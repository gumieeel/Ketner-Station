import { describe, expect, it } from 'vitest';
import { matchWake, nameScore, normalize, parseYesNo, wakeVariantFromHeard } from '../src/shared/text';

const WAKE = ['кетнер', 'кэтнер', 'катнер'];

describe('normalize', () => {
  it('lowercases, drops punctuation and ё', () => {
    expect(normalize('  Кетнер, ОТКРОЙ  Ёлку! ')).toBe('кетнер открой елку');
  });
});

describe('matchWake', () => {
  it('finds the wake word alone', () => {
    expect(matchWake('Кетнер', WAKE)).toEqual({ index: 0, length: 1, rest: '' });
  });
  it('splits the command after the wake word', () => {
    expect(matchWake('кетнер, открой дискорд', WAKE)?.rest).toBe('открой дискорд');
  });
  it('tolerates recognition typos and cases', () => {
    expect(matchWake('кетнера включи музыку', WAKE)?.rest).toBe('включи музыку');
    expect(matchWake('ктнер пауза', WAKE)?.rest).toBe('пауза');
  });
  it('joins a wake word split in two', () => {
    expect(matchWake('кет нер открой гитхаб', WAKE)).toEqual({ index: 0, length: 2, rest: 'открой гитхаб' });
  });
  it('skips leading fillers', () => {
    expect(matchWake('эй кетнер открой хром', WAKE)?.rest).toBe('открой хром');
  });
  it('ignores the word in the middle of a sentence', () => {
    expect(matchWake('я вчера говорил с кетнером про это', WAKE)).toBeNull();
  });
  it('ignores unrelated speech and empty input', () => {
    expect(matchWake('открой дискорд', WAKE)).toBeNull();
    expect(matchWake('', WAKE)).toBeNull();
    expect(matchWake('кетнер', [])).toBeNull();
  });
});

describe('parseYesNo', () => {
  it('detects agreement and refusal', () => {
    expect(parseYesNo('да, давай')).toBe('yes');
    expect(parseYesNo('нет')).toBe('no');
    expect(parseYesNo('не надо')).toBe('no');
    expect(parseYesNo('да нет не надо')).toBe('no');
    expect(parseYesNo('может быть')).toBe('unknown');
  });
});

describe('nameScore', () => {
  it('ranks exact before prefix before substring', () => {
    const exact = nameScore('discord', 'Discord') as number;
    const prefix = nameScore('disc', 'Discord') as number;
    const contains = nameScore('cord', 'Discord') as number;
    expect(exact).toBeLessThan(prefix);
    expect(prefix).toBeLessThan(contains);
  });
  it('accepts a small typo and rejects unrelated names', () => {
    expect(nameScore('discrod', 'Discord')).not.toBeNull();
    expect(nameScore('telegram', 'Discord')).toBeNull();
  });
});

describe('wakeVariantFromHeard', () => {
  it('joins two words and rejects noise and phrases', () => {
    expect(wakeVariantFromHeard('кет нер')).toBe('кетнер');
    expect(wakeVariantFromHeard('Катнер.')).toBe('катнер');
    expect(wakeVariantFromHeard('и')).toBeNull();
    expect(wakeVariantFromHeard('открой мне дискорд')).toBeNull();
    expect(wakeVariantFromHeard('')).toBeNull();
  });
});
