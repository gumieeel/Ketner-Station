import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/shared/stt-filter';

describe('cleanTranscript', () => {
  it('keeps real commands untouched', () => {
    expect(cleanTranscript(' Кетнер, открой Дискорд. ')).toBe('Кетнер, открой Дискорд.');
  });
  it('drops bracketed annotations', () => {
    expect(cleanTranscript('[МУЗЫКА] открой ютуб (смех)')).toBe('открой ютуб');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
  });
  it('drops subtitle hallucinations', () => {
    expect(cleanTranscript('Субтитры сделал DimaTorzok')).toBe('');
    expect(cleanTranscript('Продолжение следует...')).toBe('');
  });
});
