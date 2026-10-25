import { app } from 'electron';
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelStatus } from '../shared/types';
import { safeJoin, zipToTarGz } from './archive';

export const VOSK_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip';
export const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

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

function atomicWrite(file: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class ModelManager {
  private state: ModelStatus = { stt: 'missing', piper: 'missing' };
  private readonly listeners = new Set<(s: ModelStatus) => void>();
  private busy: Promise<void> | null = null;

  readonly modelsDir = path.join(app.getPath('userData'), 'models');
  readonly piperDir = path.join(app.getPath('userData'), 'piper');
  readonly sttFile = path.join(this.modelsDir, 'vosk-ru.tar.gz');

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

  status(): ModelStatus {
    return this.state;
  }

  onStatus(listener: (s: ModelStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Перечитывает состояние с диска. */
  refresh(voiceId = 'ru_RU-irina-medium'): void {
    this.set({
      ...this.state,
      stt: this.state.stt === 'downloading' ? 'downloading' : fs.existsSync(this.sttFile) ? 'ready' : 'missing',
      piper: this.state.piper === 'downloading' ? 'downloading' : this.piperReady(voiceId) ? 'ready' : 'missing',
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
}
