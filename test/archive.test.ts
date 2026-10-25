import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { safeJoin, zipToTarGz } from '../src/main/archive';

describe('zipToTarGz', () => {
  it('produces an archive that GNU tar can list and extract byte-for-byte', () => {
    const long = `vosk-model-small-ru-0.22/${'deep/'.repeat(25)}file.bin`;
    const big = new Uint8Array(1500).map((_, i) => i % 251);
    const zip = zipSync({
      'vosk-model-small-ru-0.22/README': strToU8('привет'),
      'vosk-model-small-ru-0.22/am/final.mdl': big,
      [long]: strToU8('x'),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ketner-tar-'));
    try {
      const archive = path.join(dir, 'model.tar.gz');
      fs.writeFileSync(archive, zipToTarGz(zip));
      const listing = execFileSync('tar', ['-tzf', archive]).toString();
      expect(listing).toContain('vosk-model-small-ru-0.22/am/final.mdl');
      expect(listing).toContain('vosk-model-small-ru-0.22/am/');
      execFileSync('tar', ['-xzf', archive, '-C', dir]);
      expect(fs.readFileSync(path.join(dir, 'vosk-model-small-ru-0.22/README'), 'utf8')).toBe('привет');
      expect(Buffer.compare(fs.readFileSync(path.join(dir, 'vosk-model-small-ru-0.22/am/final.mdl')), Buffer.from(big))).toBe(0);
      expect(fs.readFileSync(path.join(dir, long), 'utf8')).toBe('x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('safeJoin', () => {
  it('rejects path traversal', () => {
    const root = path.resolve('/tmp/root');
    expect(safeJoin(root, 'a/b.txt')).toBe(path.join(root, 'a/b.txt'));
    expect(() => safeJoin(root, '../evil')).toThrow();
    expect(() => safeJoin(root, 'a/../../evil')).toThrow();
  });
});
