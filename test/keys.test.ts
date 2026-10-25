import { describe, expect, it } from 'vitest';
import { buildKeyScript, keyCode, parseCombo } from '../src/main/keys';

describe('parseCombo', () => {
  it('maps modifiers, letters, digits and function keys', () => {
    expect(parseCombo('ctrl+shift+t')).toEqual([0x11, 0x10, 0x54]);
    expect(parseCombo('Win + D')).toEqual([0x5b, 0x44]);
    expect(parseCombo('alt+f4')).toEqual([0x12, 0x73]);
    expect(parseCombo('ctrl+5')).toEqual([0x11, 0x35]);
  });
  it('knows media keys', () => {
    expect(keyCode('playpause')).toBe(0xb3);
    expect(keyCode('nexttrack')).toBe(0xb0);
    expect(keyCode('volumeup')).toBe(0xaf);
  });
  it('rejects unknown keys and empty input', () => {
    expect(() => parseCombo('ctrl+банан')).toThrow(/Неизвестная клавиша/);
    expect(() => parseCombo('')).toThrow();
  });
});

describe('buildKeyScript', () => {
  it('presses in order and releases in reverse, marking extended keys', () => {
    const script = buildKeyScript([0x11, 0x25], 2);
    expect(script).toContain('-lt 2');
    const down = script.indexOf('keybd_event(17,0,0');
    const downArrow = script.indexOf('keybd_event(37,0,1');
    const upArrow = script.indexOf('keybd_event(37,0,3');
    const upCtrl = script.indexOf('keybd_event(17,0,2');
    expect(down).toBeGreaterThan(-1);
    expect(down < downArrow && downArrow < upArrow && upArrow < upCtrl).toBe(true);
  });
});
