import type { Config } from './types';

export const PIPER_VOICES = [
  { id: 'ru_RU-irina-medium', label: 'Ирина (женский)' },
  { id: 'ru_RU-denis-medium', label: 'Денис (мужской)' },
  { id: 'ru_RU-dmitri-medium', label: 'Дмитрий (мужской)' },
  { id: 'ru_RU-ruslan-medium', label: 'Руслан (мужской)' },
] as const;

export const WHISPER_MODELS = {
  base: { file: 'ggml-base-q5_1.bin', label: 'base — быстро, но неточно (~60 МБ)' },
  small: { file: 'ggml-small-q5_1.bin', label: 'small — хороший баланс (~180 МБ)' },
  medium: { file: 'ggml-medium-q5_0.bin', label: 'medium — самая точная, медленнее (~540 МБ)' },
} as const;

export const DEFAULT_CONFIG: Config = {
  wakeWords: ['кетнер', 'кэтнер', 'катнер', 'кетнэр', 'кеттнер', 'кетнера'],
  wakeMinConfidence: 0.5,
  earlyWake: false,
  listenTimeoutSec: 8,
  followUpSec: 0,
  hotkey: 'Control+Alt+K',
  micDeviceId: '',
  outputDeviceId: '',
  sounds: true,
  soundVolume: 0.5,
  speechVolume: 1,
  stt: { engine: 'whisper', model: 'small', prompt: '' },
  tts: { engine: 'piper', voice: 'ru_RU-irina-medium', rate: 1 },
  llm: { baseUrl: 'https://ketner.org/v1', model: 'auto', maxSteps: 6, temperature: 0.3 },
  confirm: 'dangerous',
  searchUrl: 'https://yandex.ru/search/?text={q}',
  autostart: true,
  debugHeard: false,
  apps: [],
  sites: [
    { name: 'Яндекс Музыка', aliases: ['яндекс музыка', 'yandex music', 'музыка'], url: 'https://music.yandex.ru' },
    { name: 'YouTube', aliases: ['ютуб', 'youtube'], url: 'https://www.youtube.com' },
    { name: 'GitHub', aliases: ['гитхаб', 'github'], url: 'https://github.com' },
    { name: 'Claude', aliases: ['клод', 'claude'], url: 'https://claude.ai' },
    { name: 'Ketner AI', aliases: ['кетнер ай', 'ketner'], url: 'https://ketner.org' },
    { name: 'Яндекс', aliases: ['яндекс', 'yandex'], url: 'https://ya.ru' },
    { name: 'Почта Gmail', aliases: ['почта', 'gmail', 'джимейл'], url: 'https://mail.google.com' },
  ],
};

export function mergeConfig(base: Config, patch: unknown): Config {
  return (isPlainObject(patch) ? deepMerge(base, patch) : base) as Config;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) continue;
    const current = base[key];
    if (isPlainObject(current)) out[key] = deepMerge(current, value);
    else if (typeof current === typeof value && Array.isArray(current) === Array.isArray(value)) out[key] = value;
  }
  return out;
}

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

/** Приводит конфиг в допустимый вид: диапазоны чисел, непустые списки, корректные адреса. */
export function sanitizeConfig(cfg: Config): Config {
  const d = DEFAULT_CONFIG;
  const wakeWords = strList(cfg.wakeWords);
  const baseUrl = (cfg.llm.baseUrl || d.llm.baseUrl).trim().replace(/\/+$/, '');
  return {
    ...cfg,
    wakeWords: wakeWords.length ? wakeWords : d.wakeWords,
    wakeMinConfidence: clamp(cfg.wakeMinConfidence, 0, 1, d.wakeMinConfidence),
    listenTimeoutSec: clamp(cfg.listenTimeoutSec, 2, 60, d.listenTimeoutSec),
    followUpSec: clamp(cfg.followUpSec, 0, 60, d.followUpSec),
    soundVolume: clamp(cfg.soundVolume, 0, 1, d.soundVolume),
    speechVolume: clamp(cfg.speechVolume, 0, 1, d.speechVolume),
    stt: {
      engine: cfg.stt.engine === 'vosk' ? 'vosk' : 'whisper',
      model: cfg.stt.model in WHISPER_MODELS ? cfg.stt.model : d.stt.model,
      prompt: cfg.stt.prompt.slice(0, 400),
    },
    tts: {
      engine: cfg.tts.engine === 'windows' ? 'windows' : 'piper',
      voice: PIPER_VOICES.some((v) => v.id === cfg.tts.voice) ? cfg.tts.voice : d.tts.voice,
      rate: clamp(cfg.tts.rate, 0.5, 2, d.tts.rate),
    },
    llm: {
      baseUrl: /^https?:\/\//i.test(baseUrl) ? baseUrl : d.llm.baseUrl,
      model: cfg.llm.model.trim() || d.llm.model,
      maxSteps: Math.round(clamp(cfg.llm.maxSteps, 1, 12, d.llm.maxSteps)),
      temperature: clamp(cfg.llm.temperature, 0, 2, d.llm.temperature),
    },
    confirm: cfg.confirm === 'always' || cfg.confirm === 'never' ? cfg.confirm : 'dangerous',
    searchUrl: cfg.searchUrl.includes('{q}') && /^https?:\/\//i.test(cfg.searchUrl) ? cfg.searchUrl : d.searchUrl,
    apps: (Array.isArray(cfg.apps) ? cfg.apps : [])
      .filter((a) => a && typeof a.name === 'string' && a.name.trim() && typeof a.target === 'string' && a.target.trim())
      .map((a) => ({ name: a.name.trim(), aliases: strList(a.aliases), target: a.target.trim(), ...(a.args?.trim() ? { args: a.args.trim() } : {}) })),
    sites: (Array.isArray(cfg.sites) ? cfg.sites : [])
      .filter((s) => s && typeof s.name === 'string' && s.name.trim() && typeof s.url === 'string' && /^https?:\/\//i.test(s.url.trim()))
      .map((s) => ({ name: s.name.trim(), aliases: strList(s.aliases), url: s.url.trim() })),
  };
}
