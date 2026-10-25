import { describe, expect, it } from 'vitest';
import { matchLocalCommand } from '../src/shared/local-commands';
import { cleanForSpeech } from '../src/shared/speech-text';

describe('cleanForSpeech', () => {
  it('strips markdown, links and emoji', () => {
    expect(cleanForSpeech('**Готово!** 🎉 Открыл [Discord](https://discord.com).')).toBe('Готово! Открыл Discord.');
    expect(cleanForSpeech('Смотри: https://example.com/a?b=1')).toBe('Смотри: ссылка');
  });
  it('turns lists and line breaks into sentences', () => {
    expect(cleanForSpeech('Нашёл:\n- первое\n- второе')).toBe('Нашёл:. первое. второе');
  });
  it('drops code blocks', () => {
    expect(cleanForSpeech('Вот команда:\n```\nrm -rf\n```\nвсё')).not.toContain('rm');
  });
});

describe('matchLocalCommand', () => {
  it('recognizes whole-phrase media commands', () => {
    expect(matchLocalCommand('Пауза.')).toEqual({ tool: 'media_control', args: { action: 'play_pause' } });
    expect(matchLocalCommand('следующий трек')?.args).toEqual({ action: 'next' });
    expect(matchLocalCommand('сделай погромче')?.args).toEqual({ action: 'volume_up', value: 10 });
    expect(matchLocalCommand('покажи рабочий стол')?.tool).toBe('window_control');
  });
  it('does not hijack longer requests', () => {
    expect(matchLocalCommand('поставь паузу на пять минут и выключи компьютер')).toBeNull();
    expect(matchLocalCommand('включи что-нибудь спокойное')).toBeNull();
    expect(matchLocalCommand('открой дискорд')).toBeNull();
  });
});
