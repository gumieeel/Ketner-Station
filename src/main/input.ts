import { clipboard } from 'electron';
import { buildKeyScript, KBD_TYPE, MOUSE_TYPE, parseCombo } from './keys';
import { runPowerShell } from './powershell';

export async function pressCombo(combo: string, repeat = 1): Promise<void> {
  const codes = parseCombo(combo);
  const result = await runPowerShell(buildKeyScript(codes, Math.max(1, Math.min(repeat, 100))));
  if (result.code !== 0) throw new Error(result.stderr || 'Не удалось нажать клавиши.');
}

/** Печатает текст через буфер обмена (так работают русские буквы и эмодзи), затем возвращает прежний буфер. */
export async function typeText(text: string): Promise<void> {
  const previous = await clipboard.readText();
  await clipboard.writeText(text);
  try {
    await pressCombo('ctrl+v');
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await clipboard.writeText(previous);
  }
}

export type MediaAction =
  | 'play_pause' | 'next' | 'previous' | 'stop' | 'volume_up' | 'volume_down' | 'mute' | 'set_volume';

const MEDIA_KEYS: Record<Exclude<MediaAction, 'set_volume'>, string> = {
  play_pause: 'playpause', next: 'nexttrack', previous: 'prevtrack', stop: 'stopmedia',
  volume_up: 'volumeup', volume_down: 'volumedown', mute: 'volumemute',
};

/** Один шаг системной громкости Windows — 2 %. */
export const VOLUME_STEP = 2;
const VK_VOLUME_DOWN = 0xae;
const VK_VOLUME_UP = 0xaf;

export async function mediaControl(action: MediaAction, value?: number): Promise<string> {
  if (action === 'set_volume') {
    const target = Math.max(0, Math.min(100, Math.round(value ?? 50)));
    const tap = (code: number) => `[Ketner.Kbd]::keybd_event(${code},0,0,[UIntPtr]::Zero);[Ketner.Kbd]::keybd_event(${code},0,2,[UIntPtr]::Zero)`;
    const script = `${KBD_TYPE}for($i=0;$i -lt 50;$i++){${tap(VK_VOLUME_DOWN)}};for($i=0;$i -lt ${Math.round(target / VOLUME_STEP)};$i++){${tap(VK_VOLUME_UP)}}`;
    const r = await runPowerShell(script, 30_000);
    if (r.code !== 0) throw new Error(r.stderr || 'Не удалось задать громкость.');
    return `Громкость установлена примерно на ${target}%.`;
  }
  const steps = action === 'volume_up' || action === 'volume_down' ? Math.max(1, Math.min(50, Math.round((value ?? 10) / VOLUME_STEP))) : 1;
  await pressCombo(MEDIA_KEYS[action], steps);
  return 'Готово.';
}

export async function mouseClick(button: 'left' | 'right', double = false): Promise<void> {
  const [downFlag, upFlag] = button === 'left' ? [2, 4] : [8, 16];
  const once = `[Ketner.Mouse]::mouse_event(${downFlag},0,0,0,[UIntPtr]::Zero);[Ketner.Mouse]::mouse_event(${upFlag},0,0,0,[UIntPtr]::Zero)`;
  const r = await runPowerShell(`${MOUSE_TYPE}${once}${double ? `;Start-Sleep -Milliseconds 60;${once}` : ''}`);
  if (r.code !== 0) throw new Error(r.stderr || 'Клик не удался.');
}

/** `clicks` > 0 — вверх, < 0 — вниз. Один «щелчок» колеса — 120 единиц. */
export async function mouseScroll(clicks: number): Promise<void> {
  const delta = Math.round(clicks) * 120;
  const r = await runPowerShell(`${MOUSE_TYPE}[Ketner.Mouse]::mouse_event(0x800,0,0,${delta},[UIntPtr]::Zero)`);
  if (r.code !== 0) throw new Error(r.stderr || 'Прокрутка не удалась.');
}
