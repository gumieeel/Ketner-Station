import { gzipSync, unzipSync } from 'fflate';
import path from 'node:path';

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(buf: Uint8Array, offset: number, value: string, length: number): void {
  buf.set(encoder.encode(value).subarray(0, length), offset);
}

function writeOctal(buf: Uint8Array, offset: number, value: number, length: number): void {
  writeString(buf, offset, value.toString(8).padStart(length - 1, '0'), length - 1);
}

function splitName(name: string): { name: string; prefix: string } {
  if (encoder.encode(name).length <= 100) return { name, prefix: '' };
  const idx = name.lastIndexOf('/', name.length - 2);
  const prefix = name.slice(0, idx);
  const rest = name.slice(idx + 1);
  if (idx < 0 || encoder.encode(prefix).length > 155 || encoder.encode(rest).length > 100) {
    throw new Error(`Слишком длинный путь в архиве: ${name}`);
  }
  return { name: rest, prefix };
}

function header(name: string, size: number, isDir: boolean): Uint8Array {
  const { name: shortName, prefix } = splitName(name);
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, shortName, 100);
  writeOctal(h, 100, isDir ? 0o755 : 0o644, 8);
  writeOctal(h, 108, 0, 8);
  writeOctal(h, 116, 0, 8);
  writeOctal(h, 124, size, 12);
  writeOctal(h, 136, 0, 12);
  h.fill(0x20, 148, 156); // место под контрольную сумму считается пробелами
  h[156] = isDir ? 0x35 : 0x30;
  writeString(h, 257, 'ustar', 6);
  writeString(h, 263, '00', 2);
  writeString(h, 345, prefix, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  writeString(h, 148, sum.toString(8).padStart(6, '0'), 6);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/** Собирает несжатый tar (ustar) из набора файлов. Каталоги создаются автоматически. */
export function createTar(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  const entries = Object.entries(files).filter(([name]) => !name.endsWith('/'));

  for (const [name] of entries) {
    let dir = path.posix.dirname(name);
    while (dir && dir !== '.') {
      dirs.add(`${dir}/`);
      dir = path.posix.dirname(dir);
    }
  }
  for (const dir of [...dirs].sort()) parts.push(header(dir, 0, true));

  for (const [name, data] of entries) {
    parts.push(header(name, data.length, false), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Модель Vosk распространяется zip-архивом, а vosk-browser читает tar.gz.
 * Пути внутри (включая верхний каталог модели) сохраняются как есть.
 */
export function zipToTarGz(zip: Uint8Array): Uint8Array {
  const files = unzipSync(zip);
  return gzipSync(createTar(files), { level: 6 });
}

/** Безопасно соединяет корневой каталог и путь из архива (без выхода за пределы корня). */
export function safeJoin(root: string, entry: string): string {
  const target = path.resolve(root, entry);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Небезопасный путь в архиве: ${entry}`);
  return target;
}
