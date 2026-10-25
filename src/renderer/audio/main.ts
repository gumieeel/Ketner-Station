import type { AudioRpcMethod, AudioState } from '../../shared/ipc';
import { matchWake, type Answer } from '../../shared/text';
import type { PublicConfig } from '../../shared/types';
import { VoiceSession, type VoiceEvent } from '../../shared/voice-session';
import { Engine } from './engine';
import { Sounds, type ChimeKind } from './sounds';
import { Speaker } from './speaker';

const api = window.ketner;
const MODEL_URL = 'ketner://app/models/vosk-ru.tar.gz';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cfg: PublicConfig;
let paused = false;
let state: AudioState = 'loading';
let starting = false;
let confirmResolver: ((a: Answer) => void) | null = null;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let lastAudio: Float32Array | null = null;
let calibration: ((heard: string) => void) | null = null;

const sounds = new Sounds();
const speaker = new Speaker(
  () => cfg,
  (text) => api.synthesize(text),
  (warning) => api.audioError(warning),
);

function setState(next: AudioState): void {
  if (next === state) return;
  state = next;
  api.audioState(next);
}

function chime(kind: ChimeKind): void {
  if (cfg.sounds) void sounds.play(kind, cfg.soundVolume).catch(() => undefined);
}

const session = new VoiceSession(
  {
    wakeWords: () => cfg.wakeWords,
    earlyWake: () => cfg.earlyWake,
    minWakeConfidence: () => cfg.wakeMinConfidence,
    listenTimeoutMs: () => cfg.listenTimeoutSec * 1000,
    followUpMs: () => cfg.followUpSec * 1000,
  },
  onVoiceEvent,
);

const idleState = (): AudioState => (session.state === 'listening' || session.state === 'confirming' ? 'listening' : session.state === 'busy' ? 'thinking' : 'idle');

function onVoiceEvent(event: VoiceEvent): void {
  switch (event.type) {
    case 'wake':
      chime('wake');
      setState('listening');
      break;
    case 'timeout':
      chime('timeout');
      setState('idle');
      break;
    case 'command':
      void runCommand(event.text, lastAudio);
      break;
    case 'confirm':
      confirmResolver?.(event.answer);
      break;
  }
}

/**
 * Vosk быстро находит слово «Кетнер» и конец фразы, но команды он расшифровывает с ошибками.
 * Поэтому ту же запись ещё раз расшифровывает Whisper; при любой неудаче остаётся текст Vosk.
 */
async function refine(text: string, audio: Float32Array | null): Promise<string> {
  if (cfg.stt.engine !== 'whisper' || !audio || audio.length < 4000) return text;
  try {
    const better = await api.transcribe(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
    if (!better) return text;
    const wake = matchWake(better, cfg.wakeWords);
    return (wake ? wake.rest : better).trim() || text;
  } catch {
    return text;
  }
}

async function runCommand(voskText: string, audio: Float32Array | null): Promise<void> {
  setState('thinking');
  chime('ack');
  let followUp = false;
  try {
    const text = await refine(voskText, audio);
    if (cfg.debugHeard && text !== voskText) api.heard(`Whisper: ${text}`, true);
    followUp = Boolean((await api.command(text)).followUp);
  } catch (err) {
    api.audioError(`Команда не выполнена: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    session.setIdle();
    // Ассистент задал вопрос: ответ ждём сразу, без слова «Кетнер».
    if (followUp && session.state === 'idle') session.startListening();
    setState(idleState());
  }
}

const engine = new Engine({
  onPartial: (text) => session.onPartial(text),
  onFinal: (text, words, audio) => {
    lastAudio = audio;
    if (calibration) {
      calibration(text);
      return;
    }
    if (cfg.debugHeard) api.heard(text, true);
    session.onFinal(text, words);
  },
  onEnded: (reason) => {
    api.audioError(`${reason} Пробую подключиться снова.`);
    scheduleRestart(2000);
  },
});

function scheduleRestart(ms: number): void {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => void ensureRunning(), ms);
}

async function ensureRunning(): Promise<void> {
  if (starting) return;
  if (paused) {
    await engine.stop();
    setState('paused');
    return;
  }
  const models = await api.modelStatus();
  if (models.stt !== 'ready') {
    setState(models.stt === 'error' ? 'error' : 'loading');
    return; // продолжим, когда модель скачается (см. onModelStatus)
  }
  starting = true;
  try {
    await engine.start(MODEL_URL, cfg.micDeviceId);
    setState('idle');
  } catch (err) {
    setState('error');
    api.audioError(`Не удалось запустить распознавание: ${err instanceof Error ? err.message : String(err)}`);
    scheduleRestart(15_000);
  } finally {
    starting = false;
  }
}

/** Озвучить фразу, закрыв микрофон на время речи и ещё чуть-чуть после (эхо комнаты). */
async function speakGuarded(text: string): Promise<void> {
  engine.setGate(false);
  setState('speaking');
  try {
    await speaker.speak(text);
    await sleep(300);
  } finally {
    engine.setGate(true);
    setState(idleState());
  }
}

async function waitUntilIdle(maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (session.state !== 'idle' && Date.now() < until) await sleep(250);
}

async function confirm(question: string): Promise<Answer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await speakGuarded(attempt === 0 ? question : 'Не расслышал. Скажите «да» или «нет».');
    const answer = await new Promise<Answer>((resolve) => {
      confirmResolver = resolve;
      session.startConfirming(8000);
      setState('listening');
    });
    confirmResolver = null;
    setState('thinking');
    if (answer !== 'unknown') return answer;
  }
  return 'unknown';
}

/** Собирает, как распознавание услышало слово активации: `count` непустых фраз или 20 секунд. */
async function calibrate(count: number): Promise<string[]> {
  if (!engine.active) throw new Error('Распознавание ещё не запущено: дождитесь скачивания модели.');
  speaker.stop();
  const heard: string[] = [];
  chime('wake');
  setState('listening');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    calibration = (text) => {
      if (!text.trim()) return;
      heard.push(text.trim());
      chime('done');
      if (heard.length >= count) {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  calibration = null;
  setState(idleState());
  return heard;
}

api.onRpc(async (method: AudioRpcMethod, payload: unknown) => {
  const data = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'speak':
      if (data['proactive']) await waitUntilIdle(60_000);
      await speakGuarded(String(data['text'] ?? ''));
      return null;
    case 'confirm':
      return confirm(String(data['question'] ?? 'Выполнить?'));
    case 'chime':
      chime((data['kind'] as ChimeKind) ?? 'done');
      return null;
    case 'stop':
      speaker.stop();
      return null;
    case 'pause':
      paused = Boolean(data['paused']);
      speaker.stop();
      await ensureRunning();
      return null;
    case 'listen':
      if (!engine.active) return null;
      speaker.stop();
      session.startListening();
      return null;
    case 'calibrate':
      return calibrate(Number(data['count']) || 3);
    case 'reconfigure': {
      const previous = cfg;
      cfg = await api.getConfig();
      await sounds.setOutput(cfg.outputDeviceId);
      if (previous.micDeviceId !== cfg.micDeviceId && engine.active) await ensureRunning();
      return null;
    }
  }
});

api.onModelStatus((status) => {
  if (status.stt === 'ready' && !engine.active) void ensureRunning();
});

async function boot(): Promise<void> {
  cfg = await api.getConfig();
  await sounds.setOutput(cfg.outputDeviceId);
  setInterval(() => session.tick(), 250);
  await ensureRunning();
}

void boot();
