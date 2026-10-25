import { normalize } from './text';

export interface LocalStep {
  tool: string;
  args: Record<string, unknown>;
}

/** Готовая последовательность действий без обращения к модели. */
export interface LocalCommand {
  steps: LocalStep[];
  /** Если какой-то шаг не удался (не нашёл кнопку), передать фразу модели: она разберётся. */
  fallbackToModel?: boolean;
}

const one = (tool: string, args: Record<string, unknown>): LocalCommand => ({ steps: [{ tool, args }] });

const MY_WAVE: LocalCommand = {
  steps: [
    { tool: 'open_url', args: { url: 'https://music.yandex.ru' } },
    // ui_click сам ждёт появления кнопки, фиксированных пауз нет
    { tool: 'ui_click', args: { text: 'Моя волна', alternatives: ['Мою волну', 'Слушать', 'Воспроизвести'], timeout: 20 } },
  ],
  fallbackToModel: true,
};

const RULES: Array<{ pattern: RegExp; command: LocalCommand }> = [
  { pattern: /^(?:(?:включи|запусти|поставь|давай|сыграй|играй|открой|врубай|врубай)\s+)?(?:(?:в\s+)?яндекс\s?музык[а-яё]*\s+)?(?:мою|моя)\s+волн[ауы]$/, command: MY_WAVE },
  { pattern: /^(поставь )?(на )?(паузу|пауза)( музыку| трек)?$|^(пауза|стоп|останови|продолжи|продолжай|играй|включи музыку|выключи музыку|останови музыку)$/, command: one('media_control', { action: 'play_pause' }) },
  { pattern: /^(следующий|следующая|дальше|вперед|переключи|следующий трек|следующая песня|включи следующий трек|включи следующую песню|переключи трек|переключи песню|пропусти|пропусти трек)$/, command: one('media_control', { action: 'next' }) },
  { pattern: /^(предыдущий|предыдущая|назад|предыдущий трек|предыдущая песня|включи предыдущий трек|верни трек|верни песню)$/, command: one('media_control', { action: 'previous' }) },
  { pattern: /^(сделай )?(погромче|громче|прибавь звук|прибавь громкость|увеличь громкость)$/, command: one('media_control', { action: 'volume_up', value: 10 }) },
  { pattern: /^(сделай )?(потише|тише|убавь звук|убавь громкость|уменьши громкость)$/, command: one('media_control', { action: 'volume_down', value: 10 }) },
  { pattern: /^(выключи звук|включи звук|без звука|отключи звук|верни звук|заглуши)$/, command: one('media_control', { action: 'mute' }) },
  { pattern: /^(сверни все|сверни все окна|покажи рабочий стол|сверни окна)$/, command: one('window_control', { action: 'show_desktop' }) },
];

/** Простые команды из одной фразы выполняются сразу, без обращения к модели: быстрее и бесплатно. */
export function matchLocalCommand(text: string): LocalCommand | null {
  const n = normalize(text);
  for (const rule of RULES) if (rule.pattern.test(n)) return rule.command;
  return null;
}
