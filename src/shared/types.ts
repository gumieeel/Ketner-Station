export interface AppEntry {
  name: string;
  aliases: string[];
  /** Путь к .exe, файлу, URL или протокол (например `spotify:`). */
  target: string;
  args?: string;
}

export interface SiteEntry {
  name: string;
  aliases: string[];
  url: string;
}

export type ConfirmPolicy = 'dangerous' | 'always' | 'never';
export type TtsEngine = 'piper' | 'windows';
export type SttEngine = 'whisper' | 'vosk';
export type WhisperModel = 'base' | 'small' | 'medium';

export interface Config {
  /** Варианты написания слова активации, как его может выдать распознавание. */
  wakeWords: string[];
  /** Минимальная уверенность распознавания слова активации (0..1). */
  wakeMinConfidence: number;
  /** Сигнал «слушаю» сразу, как только слово услышано, не дожидаясь паузы. */
  earlyWake: boolean;
  /** Сколько секунд ждать команду после слова активации. */
  listenTimeoutSec: number;
  /** После ответа ещё столько секунд слушать без слова активации (0 — выключено). */
  followUpSec: number;
  /** Горячая клавиша «слушать сейчас» (формат Electron accelerator), пусто — выключено. */
  hotkey: string;
  micDeviceId: string;
  outputDeviceId: string;
  sounds: boolean;
  soundVolume: number;
  speechVolume: number;
  /** Как расшифровывать команду: Whisper точнее, Vosk быстрее. Слово активации всегда ловит Vosk. */
  stt: { engine: SttEngine; model: WhisperModel; prompt: string };
  tts: { engine: TtsEngine; voice: string; rate: number };
  llm: { baseUrl: string; model: string; maxSteps: number; temperature: number };
  confirm: ConfirmPolicy;
  /** Шаблон поиска, `{q}` заменяется запросом. */
  searchUrl: string;
  autostart: boolean;
  /** Показывать в журнале всё, что слышит распознавание (для отладки). */
  debugHeard: boolean;
  apps: AppEntry[];
  sites: SiteEntry[];
}

export interface PublicConfig extends Config {
  hasApiKey: boolean;
}

export type ModelState = 'missing' | 'downloading' | 'ready' | 'error';

export interface ModelStatus {
  stt: ModelState;
  piper: ModelState;
  whisper: ModelState;
  progress?: { kind: 'stt' | 'piper' | 'whisper'; percent: number; label: string };
  error?: string;
}

export interface LogEntry {
  id: number;
  time: number;
  kind: 'heard' | 'reply' | 'tool' | 'error' | 'info';
  text: string;
}

export interface CommandResult {
  reply: string;
  ok: boolean;
  /** Ответ — вопрос: ассистент продолжает слушать без слова активации. */
  followUp?: boolean;
}
