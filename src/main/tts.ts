import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/types';
import type { ModelManager } from './models';

/** Синтез речи через Piper: текст на вход, WAV на выход. Работает офлайн. */
export async function synthesize(text: string, config: Config, models: ModelManager): Promise<Buffer> {
  const voice = config.tts.voice;
  if (!models.piperReady(voice)) throw new Error('Голос Piper ещё не скачан.');
  const out = path.join(os.tmpdir(), `ketner-tts-${process.pid}-${Date.now()}.wav`);
  const lengthScale = (1 / config.tts.rate).toFixed(2);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(models.piperExe(), ['--model', models.voiceFile(voice), '--output_file', out, '--length_scale', lengthScale, '--sentence_silence', '0.15'], {
      cwd: path.dirname(models.piperExe()),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Piper завершился с кодом ${code}: ${stderr.slice(-300)}`));
    });
    child.stdin.end(`${text.replace(/\s+/g, ' ').trim()}\n`, 'utf8');
  });

  try {
    return await fs.promises.readFile(out);
  } finally {
    fs.promises.rm(out, { force: true }).catch(() => undefined);
  }
}
