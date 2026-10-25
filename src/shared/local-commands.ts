import { normalize } from './text';

export interface LocalCommand {
  tool: string;
  args: Record<string, unknown>;
}

const RULES: Array<{ pattern: RegExp; command: LocalCommand }> = [
  { pattern: /^(поставь )?(на )?(паузу|пауза)( музыку| трек)?$|^(пауза|стоп|останови|продолжи|продолжай|играй|включи музыку|выключи музыку|останови музыку)$/, command: { tool: 'media_control', args: { action: 'play_pause' } } },
  { pattern: /^(следующий|следующая|дальше|вперед|переключи|следующий трек|следующая песня|включи следующий трек|включи следующую песню|переключи трек|переключи песню|пропусти|пропусти трек)$/, command: { tool: 'media_control', args: { action: 'next' } } },
  { pattern: /^(предыдущий|предыдущая|назад|предыдущий трек|предыдущая песня|включи предыдущий трек|верни трек|верни песню)$/, command: { tool: 'media_control', args: { action: 'previous' } } },
  { pattern: /^(сделай )?(погромче|громче|прибавь звук|прибавь громкость|увеличь громкость)$/, command: { tool: 'media_control', args: { action: 'volume_up', value: 10 } } },
  { pattern: /^(сделай )?(потише|тише|убавь звук|убавь громкость|уменьши громкость)$/, command: { tool: 'media_control', args: { action: 'volume_down', value: 10 } } },
  { pattern: /^(выключи звук|включи звук|без звука|отключи звук|верни звук|заглуши)$/, command: { tool: 'media_control', args: { action: 'mute' } } },
  { pattern: /^(сверни все|сверни все окна|покажи рабочий стол|сверни окна)$/, command: { tool: 'window_control', args: { action: 'show_desktop' } } },
];

/** Простые команды из одной фразы выполняются сразу, без обращения к модели: быстрее и бесплатно. */
export function matchLocalCommand(text: string): LocalCommand | null {
  const n = normalize(text);
  for (const rule of RULES) if (rule.pattern.test(n)) return rule.command;
  return null;
}
