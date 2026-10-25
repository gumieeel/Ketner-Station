import { spawn } from 'node:child_process';

export interface PsResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const PRELUDE = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

export const isWindows = process.platform === 'win32';

/** Запускает скрипт в скрытом PowerShell. Скрипт передаётся в `-EncodedCommand`, поэтому кавычки и Unicode безопасны. */
export function runPowerShell(script: string, timeoutMs = 20_000): Promise<PsResult> {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve({ stdout: '', stderr: 'Команда доступна только в Windows.', code: 1, timedOut: false });
      return;
    }
    const encoded = Buffer.from(PRELUDE + script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, timedOut });
    });
  });
}

/** Экранирует строку для одинарных кавычек PowerShell. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Запускает программу напрямую, без PowerShell (аргументы с запятыми PowerShell бы разбил). */
export function runNative(command: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    if (!isWindows) {
      resolve({ code: 1, stderr: 'Команда доступна только в Windows.' });
      return;
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: String(err) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr.trim() });
    });
  });
}
