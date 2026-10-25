import type { CommandResult, Config, LogEntry, ModelStatus, PublicConfig } from './types';

/** Каналы IPC между окнами и главным процессом. */
export const IPC = {
  getConfig: 'config:get',
  saveConfig: 'config:save',
  setApiKey: 'config:set-api-key',
  testApi: 'api:test',
  configChanged: 'config:changed',
  modelStatus: 'models:status',
  downloadModels: 'models:download',
  modelStatusChanged: 'models:changed',
  getLog: 'log:get',
  logEntry: 'log:entry',
  runText: 'assistant:run-text',
  command: 'assistant:command',
  listenNow: 'assistant:listen-now',
  calibrate: 'assistant:calibrate',
  diagnostics: 'app:diagnostics',
  synthesize: 'tts:synthesize',
  transcribe: 'stt:transcribe',
  heard: 'audio:heard',
  audioState: 'audio:state',
  audioError: 'audio:error',
  startApps: 'apps:start-menu',
  openSettings: 'app:open-settings',
  rpc: 'rpc:request',
  rpcReply: 'rpc:reply',
} as const;

/** Состояние звукового конвейера, показывается в трее. */
export type AudioState = 'loading' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';

/** Вызовы главного процесса в звуковое окно. */
export type AudioRpcMethod = 'speak' | 'confirm' | 'chime' | 'stop' | 'pause' | 'reconfigure' | 'listen' | 'calibrate';

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TestApiResult {
  ok: boolean;
  message: string;
  models: string[];
}

export interface KetnerApi {
  getConfig(): Promise<PublicConfig>;
  saveConfig(patch: Partial<Config>): Promise<PublicConfig>;
  setApiKey(key: string): Promise<PublicConfig>;
  testApi(): Promise<TestApiResult>;
  modelStatus(): Promise<ModelStatus>;
  downloadModels(): Promise<void>;
  getLog(): Promise<LogEntry[]>;
  runText(text: string): Promise<CommandResult>;
  listenNow(): Promise<void>;
  /** Просит трижды сказать слово активации и возвращает, как его услышало распознавание. */
  calibrateWake(): Promise<string[]>;
  /** Проверяет, что PowerShell, меню «Пуск», нажатие клавиш и связь с Ketner работают. */
  runDiagnostics(): Promise<DiagnosticResult[]>;
  startApps(): Promise<string[]>;
  onConfig(cb: (config: PublicConfig) => void): () => void;
  onModelStatus(cb: (status: ModelStatus) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;

  // Для звукового окна
  command(text: string): Promise<CommandResult>;
  synthesize(text: string): Promise<ArrayBuffer | null>;
  /** Расшифровывает запись (16 кГц, моно, float32) через Whisper; `null` — Whisper недоступен. */
  transcribe(samples: ArrayBuffer): Promise<string | null>;
  heard(text: string, final: boolean): void;
  audioState(state: AudioState): void;
  audioError(text: string): void;
  onRpc(handler: (method: AudioRpcMethod, payload: unknown) => Promise<unknown>): void;
}

declare global {
  interface Window {
    ketner: KetnerApi;
  }
}
