import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, sanitizeConfig } from '../src/shared/config-defaults';

describe('mergeConfig', () => {
  it('keeps defaults for missing fields and ignores unknown or mistyped ones', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      listenTimeoutSec: 12,
      tts: { rate: 1.3 },
      hotkey: 42,
      rogue: true,
    });
    expect(merged.listenTimeoutSec).toBe(12);
    expect(merged.tts).toEqual({ ...DEFAULT_CONFIG.tts, rate: 1.3 });
    expect(merged.hotkey).toBe(DEFAULT_CONFIG.hotkey);
    expect('rogue' in merged).toBe(false);
  });
  it('returns the base for non-object patches', () => {
    expect(mergeConfig(DEFAULT_CONFIG, null)).toBe(DEFAULT_CONFIG);
  });
});

describe('sanitizeConfig', () => {
  it('clamps ranges and repairs invalid values', () => {
    const bad = mergeConfig(DEFAULT_CONFIG, {
      wakeWords: [' ', ''],
      listenTimeoutSec: 9999,
      soundVolume: -3,
      confirm: 'whatever',
      searchUrl: 'ftp://nope',
      llm: { baseUrl: 'ketner.org/v1/', maxSteps: 100 },
      tts: { voice: 'unknown', engine: 'espeak' },
    });
    const ok = sanitizeConfig(bad);
    expect(ok.wakeWords).toEqual(DEFAULT_CONFIG.wakeWords);
    expect(ok.listenTimeoutSec).toBe(60);
    expect(ok.soundVolume).toBe(0);
    expect(ok.confirm).toBe('dangerous');
    expect(ok.searchUrl).toBe(DEFAULT_CONFIG.searchUrl);
    expect(ok.llm.baseUrl).toBe(DEFAULT_CONFIG.llm.baseUrl);
    expect(ok.llm.maxSteps).toBe(12);
    expect(ok.tts.voice).toBe(DEFAULT_CONFIG.tts.voice);
    expect(ok.tts.engine).toBe('piper');
  });
  it('strips trailing slashes and drops broken app and site entries', () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, {
      llm: { baseUrl: 'https://example.com/v1//' },
      apps: [{ name: 'Foo', aliases: ['фу', 3], target: 'C:\\foo.exe' }, { name: '', aliases: [], target: 'x' }],
      sites: [{ name: 'Bad', aliases: [], url: 'javascript:alert(1)' }, { name: 'Ok', aliases: [], url: 'https://ok.dev' }],
    });
    const ok = sanitizeConfig(cfg);
    expect(ok.llm.baseUrl).toBe('https://example.com/v1');
    expect(ok.apps).toEqual([{ name: 'Foo', aliases: ['фу'], target: 'C:\\foo.exe' }]);
    expect(ok.sites).toEqual([{ name: 'Ok', aliases: [], url: 'https://ok.dev' }]);
  });
});
