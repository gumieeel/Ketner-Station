const NAMED_KEYS: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, capslock: 0x14,
  playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1, stopmedia: 0xb2,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad,
};
/** Клавиши, для которых нужен флаг KEYEVENTF_EXTENDEDKEY. */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b]);

export function keyCode(name: string): number | null {
  const key = name.trim().toLowerCase();
  const named = NAMED_KEYS[key];
  if (named !== undefined) return named;
  if (/^f([1-9]|1[0-2])$/.test(key)) return 0x6f + Number(key.slice(1));
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return null;
}

/** «ctrl+shift+t» → [0x11, 0x10, 0x54]. Бросает ошибку на неизвестной клавише. */
export function parseCombo(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Пустое сочетание клавиш.');
  return parts.map((p) => {
    const code = keyCode(p);
    if (code === null) throw new Error(`Неизвестная клавиша «${p}». Используйте имена вроде ctrl, alt, win, enter, f5, a.`);
    return code;
  });
}

export const KBD_TYPE = `Add-Type -Namespace Ketner -Name Kbd -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';`;
export const MOUSE_TYPE = `Add-Type -Namespace Ketner -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);';`;

/** Скрипт, который нажимает сочетания клавиш `repeat` раз. */
export function buildKeyScript(codes: number[], repeat = 1, delayMs = 15): string {
  const flagsFor = (c: number) => (EXTENDED.has(c) ? 1 : 0);
  const down = codes.map((c) => `[Ketner.Kbd]::keybd_event(${c},0,${flagsFor(c)},[UIntPtr]::Zero)`).join(';');
  const up = [...codes]
    .reverse()
    .map((c) => `[Ketner.Kbd]::keybd_event(${c},0,${flagsFor(c) | 2},[UIntPtr]::Zero)`)
    .join(';');
  return `${KBD_TYPE}for($i=0;$i -lt ${repeat};$i++){${down};${up};Start-Sleep -Milliseconds ${delayMs}}`;
}
