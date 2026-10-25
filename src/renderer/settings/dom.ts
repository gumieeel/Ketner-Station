type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean);
export const commaList = (text: string): string[] => text.split(',').map((l) => l.trim()).filter(Boolean);
