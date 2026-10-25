export interface TimerInfo {
  id: number;
  label: string;
  fireAt: number;
}

/** Таймеры и напоминания в памяти процесса: при перезапуске приложения пропадают. */
export class TimerManager {
  private nextId = 1;
  private readonly timers = new Map<number, { info: TimerInfo; handle: NodeJS.Timeout }>();

  constructor(private readonly onFire: (label: string) => void) {}

  add(seconds: number, label: string): TimerInfo {
    const id = this.nextId++;
    const info: TimerInfo = { id, label, fireAt: Date.now() + seconds * 1000 };
    const handle = setTimeout(() => {
      this.timers.delete(id);
      this.onFire(label);
    }, seconds * 1000);
    this.timers.set(id, { info, handle });
    return info;
  }

  list(): TimerInfo[] {
    return [...this.timers.values()].map((t) => t.info);
  }

  cancelAll(): number {
    const count = this.timers.size;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    return count;
  }
}
