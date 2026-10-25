import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/shared/config-defaults';
import { encodeWav, whisperArgs } from '../src/main/stt';

describe('encodeWav', () => {
  it('writes a valid 16-bit mono 16 kHz header and clips samples', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(wav.length).toBe(54);
    expect(wav.readInt16LE(44 + 2)).toBe(16384);
    expect(wav.readInt16LE(44 + 6)).toBe(32767);
    expect(wav.readInt16LE(44 + 8)).toBe(-32768);
  });
});

describe('whisperArgs', () => {
  it('forces Russian, no timestamps, and adds the prompt only when set', () => {
    const base = whisperArgs('m.bin', 'a.wav', DEFAULT_CONFIG, 4);
    expect(base).toEqual(expect.arrayContaining(['-l', 'ru', '-nt', '-np', '-t', '4']));
    expect(base).not.toContain('--prompt');
    const withPrompt = whisperArgs('m.bin', 'a.wav', { ...DEFAULT_CONFIG, stt: { ...DEFAULT_CONFIG.stt, prompt: ' Кетнер ' } }, 4);
    expect(withPrompt.slice(-2)).toEqual(['--prompt', 'Кетнер']);
  });
});
