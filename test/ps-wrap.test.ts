import { describe, expect, it } from 'vitest';
import { parseWrapped, wrapScript } from '../src/main/ps-wrap';

const encode = (o: object) => `@@KETNER@@${Buffer.from(JSON.stringify(o), 'utf8').toString('base64')}@@END@@`;

describe('parseWrapped', () => {
  it('decodes Cyrillic output and trims it', () => {
    expect(parseWrapped(encode({ ok: true, out: ' Привет, мир\r\n', err: '' }))).toEqual({ ok: true, out: 'Привет, мир', err: '' });
  });
  it('reports script errors', () => {
    expect(parseWrapped(`noise${encode({ ok: false, out: '', err: 'Ошибка доступа' })}tail`)).toMatchObject({ ok: false, err: 'Ошибка доступа' });
  });
  it('returns null when the wrapper never finished', () => {
    expect(parseWrapped('')).toBeNull();
    expect(parseWrapped('@@KETNER@@AAAA')).toBeNull();
    expect(parseWrapped('@@KETNER@@%%%@@END@@')).toBeNull();
  });
});

describe('wrapScript', () => {
  it('runs the script in its own block and never touches console encoding', () => {
    const wrapped = wrapScript('Get-Date');
    expect(wrapped).toContain('& {Get-Date');
    expect(wrapped).not.toContain('OutputEncoding');
    expect(wrapped).not.toMatch(/\bexit\b/);
  });
});
