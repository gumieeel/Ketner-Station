/**
 * Оболочка для скриптов PowerShell. Приложение запускает powershell.exe без консоли
 * (CREATE_NO_WINDOW), а в таком процессе нельзя менять кодировку консоли и ненадёжен
 * обычный вывод. Поэтому скрипт выполняется внутри блока, а результат (вывод, ошибка)
 * возвращается одной строкой JSON в base64 — это безопасно для кириллицы и любых символов.
 */
const START = '@@KETNER@@';
const END = '@@END@@';

export function wrapScript(script: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$__ok=$true;$__o='';$__e=''",
    `try{$__o=(& {${script}\n} | Out-String)}catch{$__ok=$false;$__e=($_ | Out-String)}`,
    '$__j=@{ok=$__ok;out=$__o;err=$__e} | ConvertTo-Json -Compress',
    `[Console]::Out.Write('${START}'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__j))+'${END}')`,
  ].join('\n');
}

export interface ParsedPs {
  ok: boolean;
  out: string;
  err: string;
}

/** Достаёт результат из stdout; `null`, если оболочка не отработала (скрипт не стартовал). */
export function parseWrapped(stdout: string): ParsedPs | null {
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return null;
  try {
    const json = Buffer.from(stdout.slice(start + START.length, end), 'base64').toString('utf8');
    const data = JSON.parse(json) as { ok?: boolean; out?: string; err?: string };
    return { ok: data.ok === true, out: (data.out ?? '').trim(), err: (data.err ?? '').trim() };
  } catch {
    return null;
  }
}
