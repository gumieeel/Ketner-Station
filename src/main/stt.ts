import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTranscript } from '../shared/stt-filter';
import type { Config } from '../shared/types';
import type { ModelManager } from './models';

/** float32 (−1..1) → WAV 16 бит, моно. */
export function encodeWav(samples: Float32Array, sampleRate = 16000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const MISSING_DLL = 3221225781; // 0xC0000135

export function whisperArgs(modelFile: string, wavFile: string, cfg: Config, threads: number): string[] {
  const args = ['-m', modelFile, '-f', wavFile, '-l', 'ru', '-nt', '-np', '-t', String(threads), '-bs', '2', '-bo', '2'];
  if (cfg.stt.prompt.trim()) args.push('--prompt', cfg.stt.prompt.trim());
  return args;
}

/** Расшифровывает запись локальным whisper.cpp. Пустая строка — речи не было. */
export async function transcribe(samples: Float32Array, cfg: Config, models: ModelManager): Promise<string> {
  const exe = models.whisperExe();
  if (!exe || !models.whisperReady(cfg.stt.model)) throw new Error('Whisper ещё не скачан.');
  const wav = path.join(os.tmpdir(), `ketner-stt-${process.pid}-${Date.now()}.wav`);
  await fs.promises.writeFile(wav, encodeWav(samples));
  const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, whisperArgs(models.whisperModelFile(cfg.stt.model), wav, cfg, threads), {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else if (code === MISSING_DLL) reject(new Error('Для Whisper нужен «Microsoft Visual C++ Redistributable» (x64): установите его с сайта Microsoft.'));
        else reject(new Error(`Whisper завершился с кодом ${code}: ${stderr.slice(-300)}`));
      });
    });
    return cleanTranscript(raw);
  } finally {
    fs.promises.rm(wav, { force: true }).catch(() => undefined);
  }
}
