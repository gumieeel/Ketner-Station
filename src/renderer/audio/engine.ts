import { createModel, type KaldiRecognizer, type Model } from 'vosk-browser';
import type { RecognizedWord } from '../../shared/voice-session';

const SAMPLE_RATE = 16000;
const CHUNK = 1600; // 100 мс
const RING_CHUNKS = 200; // хранить последние 20 секунд
const PRE_ROLL_CHUNKS = 5; // добавить 0,5 с перед первым словом
const FALLBACK_CHUNKS = 40; // если начало фразы не поймали: последние 4 с

const WORKLET = `
class KetnerTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('ketner-tap', KetnerTap);
`;

export interface EngineHandlers {
  onPartial: (text: string) => void;
  /** `audio` — запись именно этой фразы (16 кГц, моно) для повторной расшифровки точной моделью. */
  onFinal: (text: string, words: RecognizedWord[], audio: Float32Array) => void;
  onEnded: (reason: string) => void;
}

/** Микрофон → Vosk (WebAssembly, офлайн) → частичные и итоговые фразы. */
export class Engine {
  private model: Model | null = null;
  private recognizer: KaldiRecognizer | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private gateOpen = true;
  private running = false;
  private ring: Float32Array[] = [];
  private received = 0;
  private utteranceStart = -1;

  constructor(private readonly handlers: EngineHandlers) {}

  get active(): boolean {
    return this.running;
  }

  async start(modelUrl: string, micDeviceId: string): Promise<void> {
    await this.stop();
    this.model ??= await createModel(modelUrl);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const track = this.stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => {
      if (this.running) this.handlers.onEnded('Микрофон отключился.');
    });

    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const blobUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const source = this.ctx.createMediaStreamSource(this.stream);
    const tap = new AudioWorkletNode(this.ctx, 'ketner-tap');
    // Узел должен быть подключён, иначе браузер перестанет его вызывать; в динамики ничего не идёт.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(this.ctx.destination);

    this.newRecognizer();
    this.running = true;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.gateOpen || !this.recognizer) return;
      this.ring.push(e.data);
      this.received++;
      if (this.ring.length > RING_CHUNKS) this.ring.shift();
      this.recognizer.acceptWaveformFloat(e.data, SAMPLE_RATE);
    };
  }

  /** Закрыть вход на время речи ассистента, чтобы он не слушал сам себя. */
  setGate(open: boolean): void {
    if (open === this.gateOpen) return;
    this.gateOpen = open;
    if (open) this.newRecognizer(); // выбросить недораспознанный хвост
  }

  async stop(): Promise<void> {
    this.running = false;
    this.recognizer?.remove();
    this.recognizer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  /** Освободить и модель (при смене модели или выходе). */
  async dispose(): Promise<void> {
    await this.stop();
    this.model?.terminate();
    this.model = null;
  }

  /** Склеивает записанные куски текущей фразы в один массив. */
  private utterance(): Float32Array {
    const oldest = this.received - this.ring.length; // абсолютный номер первого куска в кольце
    const wanted = this.utteranceStart >= 0 ? this.utteranceStart : this.received - FALLBACK_CHUNKS;
    const from = Math.max(0, wanted - oldest);
    const parts = this.ring.slice(from);
    const out = new Float32Array(parts.length * CHUNK);
    parts.forEach((part, i) => out.set(part, i * CHUNK));
    return out;
  }

  private newRecognizer(): void {
    if (!this.model) return;
    this.recognizer?.remove();
    this.ring = [];
    this.received = 0;
    this.utteranceStart = -1;
    const recognizer = new this.model.KaldiRecognizer(SAMPLE_RATE);
    recognizer.setWords(true);
    recognizer.on('partialresult', (m) => {
      if (m.event !== 'partialresult' || !m.result.partial) return;
      if (this.utteranceStart < 0) this.utteranceStart = Math.max(0, this.received - 1 - PRE_ROLL_CHUNKS);
      this.handlers.onPartial(m.result.partial);
    });
    recognizer.on('result', (m) => {
      if (m.event !== 'result') return;
      const words = (m.result.result ?? []).map((w) => ({ word: w.word, conf: w.conf }));
      const audio = this.utterance();
      this.utteranceStart = -1;
      this.handlers.onFinal(m.result.text ?? '', words, audio);
    });
    this.recognizer = recognizer;
  }
}
