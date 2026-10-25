import { app } from 'electron';
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import { WHISPER_MODELS } from '../shared/config-defaults';
import type { ModelStatus, WhisperModel } from '../shared/types';
import { safeJoin, zipToTarGz } from './archive';

export const VOSK_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip';
export const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
/** Запасные адреса, если API GitHub недоступен (лимит запросов, фильтры). */
const WHISPER_FALLBACK_URLS = [
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-bin-x64.zip',
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.4/whisper-bin-x64.zip',
];

export const whisperModelUrl = (model: WhisperModel): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODELS[model].file}`;

async function whisperBinaryUrls(): Promise<string[]> {
  try {
    const r = await fetch(WHISPER_RELEASE_API, { headers: { 'User-Agent': 'KetnerStation', Accept: 'application/vnd.github+json' } });
    if (r.ok) {
      const data = (await r.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
      const asset = data.assets?.find((a) => a.name === 'whisper-bin-x64.zip');
      if (asset) return [asset.browser_download_url, ...WHISPER_FALLBACK_URLS];
    }
  } catch {
    // пойдём по запасным адресам
  }
  return WHISPER_FALLBACK_URLS;
}

export function piperVoiceUrls(voiceId: string): { onnx: string; json: string } {
  // ru_RU-irina-medium → ru/ru_RU/irina/medium/ru_RU-irina-medium
  const [locale, name, quality] = voiceId.split('-');
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${(locale ?? '').split('_')[0]}/${locale}/${name}/${quality}/${voiceId}`;
  return { onnx: `${base}.onnx`, json: `${base}.onnx.json` };
}

type ProgressFn = (percent: number) => void;

export async function downloadToBuffer(url: string, onProgress?: ProgressFn): Promise<Uint8Array> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch {
    throw new Error(`Нет доступа к ${host}. Проверьте интернет, VPN и брандмауэр и нажмите «Скачать» ещё раз.`);
  }
  if (!response.ok || !response.body) throw new Error(`Сервер ${host} ответил ошибкой ${response.status}. Попробуйте позже.`);
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Скачивает большой файл потоком на диск (модели Whisper весят сотни мегабайт). */
export async function downloadToFile(url: string, dest: string, onProgress?: ProgressFn): Promise<void> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch {
    throw new Error(`Нет доступа к ${host}. Проверьте интернет, VPN и брандмауэр и нажмите «Скачать» ещё раз.`);
  }
  if (!response.ok || !response.body) throw new Error(`Сервер ${host} ответил ошибкой ${response.status}. Попробуйте позже.`);
  const total = Number(response.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  const file = fs.createWriteStream(tmp);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!file.write(value)) await new Promise<void>((r) => file.once('drain', r));
      received += value.length;
      if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, dest);
  } catch (err) {
    file.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Ищет файл по имени в каталоге и подкаталогах. */
export function findFile(root: string, names: string[]): string | null {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && names.includes(entry.name.toLowerCase())) return full;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findFile(path.join(root, entry.name), names);
      if (found) return found;
    }
  }
  return null;
}

function atomicWrite(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class ModelManager {
  private state: ModelStatus = { stt: 'missing', piper: 'missing', whisper: 'missing' };
  private readonly listeners = new Set<(s: ModelStatus) => void>();
  private busy: Promise<void> | null = null;

  readonly modelsDir = path.join(app.getPath('userData'), 'models');
  readonly piperDir = path.join(app.getPath('userData'), 'piper');
  readonly sttFile = path.join(this.modelsDir, 'vosk-ru.tar.gz');
  readonly whisperDir = path.join(app.getPath('userData'), 'whisper');

  constructor() {
    this.refresh();
  }

  piperExe(): string {
    return path.join(this.piperDir, 'piper', 'piper.exe');
  }

  voiceFile(voiceId: string): string {
    return path.join(this.piperDir, 'voices', `${voiceId}.onnx`);
  }

  piperReady(voiceId: string): boolean {
    return fs.existsSync(this.piperExe()) && fs.existsSync(this.voiceFile(voiceId)) && fs.existsSync(`${this.voiceFile(voiceId)}.json`);
  }

  whisperExe(): string | null {
    return findFile(this.whisperDir, ['whisper-cli.exe', 'main.exe']);
  }

  whisperModelFile(model: WhisperModel): string {
    return path.join(this.whisperDir, 'models', WHISPER_MODELS[model].file);
  }

  whisperReady(model: WhisperModel): boolean {
    return this.whisperExe() !== null && fs.existsSync(this.whisperModelFile(model));
  }

  status(): ModelStatus {
    return this.state;
  }

  onStatus(listener: (s: ModelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Перечитывает состояние с диска. */
  refresh(voiceId = 'ru_RU-irina-medium', whisperModel: WhisperModel = 'small'): void {
    this.set({
      ...this.state,
      stt: this.state.stt === 'downloading' ? 'downloading' : fs.existsSync(this.sttFile) ? 'ready' : 'missing',
      piper: this.state.piper === 'downloading' ? 'downloading' : this.piperReady(voiceId) ? 'ready' : 'missing',
      whisper: this.state.whisper === 'downloading' ? 'downloading' : this.whisperReady(whisperModel) ? 'ready' : 'missing',
    });
  }

  private set(next: ModelStatus): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = (this.busy ?? Promise.resolve()).catch(() => undefined).then(task);
    this.busy = run;
    return run;
  }

  ensureStt(): Promise<void> {
    if (fs.existsSync(this.sttFile)) {
      this.refresh();
      return Promise.resolve();
    }
    return this.serial(async () => {
      if (fs.existsSync(this.sttFile)) return;
      try {
        this.set({ ...this.state, stt: 'downloading', progress: { kind: 'stt', percent: 0, label: 'Скачивание модели распознавания речи' } });
        const zip = await downloadToBuffer(VOSK_URL, (percent) =>
          this.set({ ...this.state, progress: { kind: 'stt', percent, label: 'Скачивание модели распознавания речи' } }),
        );
        this.set({ ...this.state, progress: { kind: 'stt', percent: 99, label: 'Распаковка модели' } });
        atomicWrite(this.sttFile, zipToTarGz(zip));
        const { progress: _p, error: _e, ...rest } = this.state;
        this.set({ ...rest, stt: 'ready' });
      } catch (err) {
        const { progress: _p, ...rest } = this.state;
        this.set({ ...rest, stt: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }

  ensurePiper(voiceId: string): Promise<void> {
    if (this.piperReady(voiceId)) {
      this.refresh(voiceId);
      return Promise.resolve();
    }
    return this.serial(async () => {
      if (this.piperReady(voiceId)) return;
      try {
        this.set({ ...this.state, piper: 'downloading', progress: { kind: 'piper', percent: 0, label: 'Скачивание синтезатора речи' } });
        if (!fs.existsSync(this.piperExe())) {
          const zip = await downloadToBuffer(PIPER_URL, (percent) =>
            this.set({ ...this.state, progress: { kind: 'piper', percent: Math.round(percent * 0.5), label: 'Скачивание синтезатора речи' } }),
          );
          for (const [name, data] of Object.entries(unzipSync(zip))) {
            if (name.endsWith('/')) continue;
            atomicWrite(safeJoin(this.piperDir, name), data);
          }
        }
        const urls = piperVoiceUrls(voiceId);
        const onnx = await downloadToBuffer(urls.onnx, (percent) =>
          this.set({ ...this.state, progress: { kind: 'piper', percent: 50 + Math.round(percent * 0.5), label: 'Скачивание голоса' } }),
        );
        const json = await downloadToBuffer(urls.json);
        atomicWrite(this.voiceFile(voiceId), onnx);
        atomicWrite(`${this.voiceFile(voiceId)}.json`, json);
        const { progress: _p, error: _e, ...rest } = this.state;
        this.set({ ...rest, piper: 'ready' });
      } catch (err) {
        const { progress: _p, ...rest } = this.state;
        this.set({ ...rest, piper: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }

  ensureWhisper(model: WhisperModel): Promise<void> {
    if (this.whisperReady(model)) {
      this.refresh(undefined, model);
      return Promise.resolve();
    }
    return this.serial(async () => {
      if (this.whisperReady(model)) return;
      const label = 'Скачивание распознавания команд (Whisper)';
      try {
        this.set({ ...this.state, whisper: 'downloading', progress: { kind: 'whisper', percent: 0, label } });
        if (!this.whisperExe()) {
          let zip: Uint8Array | null = null;
          let lastError: unknown;
          for (const url of await whisperBinaryUrls()) {
            try {
              zip = await downloadToBuffer(url, (percent) => this.set({ ...this.state, progress: { kind: 'whisper', percent: Math.round(percent * 0.1), label } }));
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (!zip) throw lastError instanceof Error ? lastError : new Error('Не удалось скачать программу Whisper.');
          for (const [name, data] of Object.entries(unzipSync(zip))) {
            if (name.endsWith('/')) continue;
            atomicWrite(safeJoin(this.whisperDir, name), data);
          }
          if (!this.whisperExe()) throw new Error('В архиве Whisper нет whisper-cli.exe.');
        }
        if (!fs.existsSync(this.whisperModelFile(model))) {
          await downloadToFile(whisperModelUrl(model), this.whisperModelFile(model), (percent) =>
            this.set({ ...this.state, progress: { kind: 'whisper', percent: 10 + Math.round(percent * 0.9), label } }),
          );
        }
        const { progress: _p, error: _e, ...rest } = this.state;
        this.set({ ...rest, whisper: 'ready' });
      } catch (err) {
        const { progress: _p, ...rest } = this.state;
        this.set({ ...rest, whisper: 'error', error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }
}
