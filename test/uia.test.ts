import { describe, expect, it } from 'vitest';
import { buildClickScript, buildListScript } from '../src/main/uia';

describe('uia scripts', () => {
  it('quotes the target text safely, including apostrophes', () => {
    const script = buildClickScript("Моя 'волна'");
    expect(script).toContain("$q = 'моя ''волна'''");
  });
  it('makes the process DPI aware before reading coordinates', () => {
    for (const s of [buildClickScript('x'), buildListScript()]) {
      expect(s.indexOf('SetProcessDPIAware()')).toBeGreaterThan(-1);
    }
  });
  it('does not use exit, which would end the PowerShell wrapper early', () => {
    expect(buildClickScript('x')).not.toMatch(/\bexit\b/);
    expect(buildListScript()).not.toMatch(/\bexit\b/);
  });
  it('tries Invoke before falling back to a mouse click', () => {
    const s = buildClickScript('x');
    expect(s.indexOf('InvokePattern')).toBeLessThan(s.indexOf('mouse_event(2'));
  });
});
