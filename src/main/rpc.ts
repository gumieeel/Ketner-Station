import { ipcMain, type WebContents } from 'electron';
import { IPC, type AudioRpcMethod } from '../shared/ipc';

/** Вызовы из главного процесса в звуковое окно с ожиданием ответа. */
export class AudioRpc {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private target: WebContents | null = null;

  constructor() {
    ipcMain.on(IPC.rpcReply, (_e, reply: { id: number; value?: unknown; error?: string }) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      if (reply.error) entry.reject(new Error(reply.error));
      else entry.resolve(reply.value);
    });
  }

  attach(target: WebContents): void {
    this.target = target;
  }

  call<T = unknown>(method: AudioRpcMethod, payload?: unknown, timeoutMs = 120_000): Promise<T> {
    const target = this.target;
    if (!target || target.isDestroyed()) return Promise.reject(new Error('Звуковое окно не запущено.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Звуковое окно не ответило на «${method}».`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      target.send(IPC.rpc, { id, method, payload });
    });
  }
}
