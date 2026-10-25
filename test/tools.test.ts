import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (n: string) => `/mock/${n}` },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
  clipboard: { readText: () => '', writeText: vi.fn() },
}));

const { TOOLS, TOOL_MAP, assertHttpUrl, needsConfirmation, resolvePath, toOpenAiTools } = await import('../src/main/tools');

describe('tool registry', () => {
  it('has unique names and valid object schemas', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of toOpenAiTools()) {
      expect(t.function.parameters).toMatchObject({ type: 'object' });
      expect(t.function.description.length).toBeGreaterThan(10);
    }
  });

  it('requires every schema-required field to be declared', () => {
    for (const t of TOOLS) {
      const p = t.parameters as { properties: Record<string, unknown>; required: string[] };
      for (const r of p.required) expect(Object.keys(p.properties)).toContain(r);
    }
  });
});

describe('confirmation policy', () => {
  const get = (n: string) => TOOL_MAP.get(n)!;
  it('asks for dangerous actions only by default', () => {
    expect(needsConfirmation(get('open_app'), { name: 'x' }, 'dangerous')).toBe(false);
    expect(needsConfirmation(get('delete_path'), { path: 'x' }, 'dangerous')).toBe(true);
    expect(needsConfirmation(get('run_powershell'), {}, 'dangerous')).toBe(true);
    expect(needsConfirmation(get('power'), { action: 'shutdown' }, 'dangerous')).toBe(true);
    expect(needsConfirmation(get('power'), { action: 'lock' }, 'dangerous')).toBe(false);
    expect(needsConfirmation(get('press_keys'), { keys: 'alt+f4' }, 'dangerous')).toBe(true);
    expect(needsConfirmation(get('press_keys'), { keys: 'ctrl+t' }, 'dangerous')).toBe(false);
  });
  it('asks for everything with "always" and nothing with "never"', () => {
    expect(needsConfirmation(get('open_app'), { name: 'x' }, 'always')).toBe(true);
    expect(needsConfirmation(get('wait'), { seconds: 1 }, 'always')).toBe(false);
    expect(needsConfirmation(get('run_powershell'), {}, 'never')).toBe(false);
  });
});

describe('assertHttpUrl', () => {
  it('adds https and rejects dangerous schemes', () => {
    expect(assertHttpUrl('github.com')).toBe('https://github.com/');
    expect(assertHttpUrl('http://localhost:3000/a')).toBe('http://localhost:3000/a');
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow();
    expect(() => assertHttpUrl('file:///C:/Windows')).toThrow();
  });
});

describe('resolvePath', () => {
  it('knows Russian and English folder names', () => {
    expect(resolvePath('Загрузки')).toBe('/mock/downloads');
    expect(resolvePath('рабочий стол')).toBe('/mock/desktop');
  });
});
