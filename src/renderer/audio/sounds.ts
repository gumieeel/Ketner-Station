type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export type ChimeKind = 'wake' | 'ack' | 'done' | 'error' | 'timeout';

interface Note {
  freq: number;
  start: number;
  length: number;
}

const PATTERNS: Record<ChimeKind, Note[]> = {
  wake: [
    { freq: 660, start: 0, length: 0.09 },
    { freq: 990, start: 0.08, length: 0.14 },
  ],
  ack: [{ freq: 880, start: 0, length: 0.06 }],
  done: [{ freq: 784, start: 0, length: 0.12 }],
  error: [
    { freq: 392, start: 0, length: 0.12 },
    { freq: 262, start: 0.11, length: 0.2 },
  ],
  timeout: [{ freq: 440, start: 0, length: 0.14 }],
};

/** Короткие сигналы, синтезируемые на лету, — без звуковых файлов. */
export class Sounds {
  private ctx: SinkContext | null = null;
  private sinkId = '';

  async setOutput(deviceId: string): Promise<void> {
    if (deviceId === this.sinkId && this.ctx) return;
    this.sinkId = deviceId;
    if (this.ctx) await this.applySink(this.ctx);
  }

  private async applySink(ctx: SinkContext): Promise<void> {
    try {
      await ctx.setSinkId?.(this.sinkId === '' ? '' : this.sinkId);
    } catch {
      // устройство пропало: остаёмся на системном по умолчанию
    }
  }

  private async context(): Promise<SinkContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext() as SinkContext;
      await this.applySink(this.ctx);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async play(kind: ChimeKind, volume: number): Promise<void> {
    if (volume <= 0) return;
    const ctx = await this.context();
    const t0 = ctx.currentTime + 0.02;
    let end = t0;
    for (const note of PATTERNS[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      const peak = 0.35 * volume;
      const s = t0 + note.start;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(peak, s + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + note.length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(s);
      osc.stop(s + note.length + 0.02);
      end = Math.max(end, s + note.length);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, (end - ctx.currentTime) * 1000)));
  }
}
