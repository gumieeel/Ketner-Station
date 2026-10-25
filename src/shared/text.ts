/** Приводит речь к сравнимому виду: нижний регистр, «ё» → «е», без знаков препинания. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export interface WakeMatch {
  /** Индекс слова активации в массиве токенов. */
  index: number;
  /** Сколько токенов заняло слово активации (1 или 2: «кет нер»). */
  length: number;
  /** Команда, сказанная после слова активации. */
  rest: string;
}

const FILLERS = new Set(['эй', 'ну', 'слушай', 'привет', 'ок', 'окей', 'алло', 'так', 'а']);
const MAX_LEAD_TOKENS = 3;

function allowedDistance(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * Ищет слово активации в начале фразы (после возможных «эй», «слушай»).
 * Допускает опечатки распознавания (расстояние Левенштейна), разрыв на два слова
 * («кет нер») и падежные окончания («кетнера»).
 */
export function matchWake(text: string, variants: string[]): WakeMatch | null {
  const words = tokens(text);
  const wake = variants.map(normalize).filter(Boolean);
  if (!words.length || !wake.length) return null;

  const fits = (candidate: string): boolean =>
    wake.some((v) => candidate === v || levenshtein(candidate, v) <= allowedDistance(v));

  let i = 0;
  while (i < Math.min(words.length, MAX_LEAD_TOKENS) && FILLERS.has(words[i] as string)) i++;
  const word = words[i];
  if (!word) return null;
  if (fits(word)) return { index: i, length: 1, rest: words.slice(i + 1).join(' ') };
  const next = words[i + 1];
  if (next && fits(word + next)) return { index: i, length: 2, rest: words.slice(i + 2).join(' ') };
  return null;
}

const YES = ['да', 'давай', 'ага', 'угу', 'конечно', 'подтверждаю', 'выполняй', 'делай', 'верно', 'разрешаю', 'валяй', 'ок', 'окей', 'yes'];
const NO = ['нет', 'не', 'отмена', 'отставить', 'стоп', 'отбой', 'никак', 'запрещаю', 'no'];

export type Answer = 'yes' | 'no' | 'unknown';

/** Разбирает ответ «да/нет». Отрицание сильнее согласия («да нет, не надо» — нет). */
export function parseYesNo(text: string): Answer {
  const words = tokens(text);
  if (words.some((w) => NO.includes(w))) return 'no';
  if (words.some((w) => YES.includes(w))) return 'yes';
  return 'unknown';
}

/** Оценка похожести имени приложения на запрос: меньше — лучше, `null` — не подходит. */
export function nameScore(query: string, candidate: string): number | null {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return null;
  if (q === c) return 0;
  if (c.startsWith(q)) return 1;
  if (c.split(' ').includes(q)) return 2;
  if (c.includes(q)) return 3;
  if (q.includes(c) && c.length >= 3) return 4;
  const dist = levenshtein(q, c);
  const limit = Math.max(1, Math.floor(Math.min(q.length, c.length) / 3));
  return dist <= limit ? 5 + dist : null;
}

/**
 * Превращает услышанное при калибровке в вариант слова активации:
 * «кет нер» → «кетнер». Слишком короткое и длинное (не слово, а фраза) отбрасывается.
 */
export function wakeVariantFromHeard(heard: string): string | null {
  const words = tokens(heard);
  if (words.length < 1 || words.length > 2) return null;
  const joined = words.join('');
  return joined.length >= 4 && joined.length <= 16 ? joined : null;
}
