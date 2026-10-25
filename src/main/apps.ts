import { spawn } from 'node:child_process';
import { shell } from 'electron';
import { nameScore, normalize } from '../shared/text';
import type { AppEntry, Config } from '../shared/types';
import { psQuote, runPowerShell } from './powershell';

interface StartApp {
  name: string;
  appId: string;
}

let startAppsCache: { at: number; apps: StartApp[] } | null = null;
const CACHE_MS = 10 * 60_000;

export async function listStartApps(force = false): Promise<StartApp[]> {
  if (!force && startAppsCache && Date.now() - startAppsCache.at < CACHE_MS) return startAppsCache.apps;
  const r = await runPowerShell('Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress', 30_000);
  let apps: StartApp[] = [];
  if (r.code === 0 && r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout) as { Name?: string; AppID?: string } | Array<{ Name?: string; AppID?: string }>;
      apps = (Array.isArray(parsed) ? parsed : [parsed])
        .filter((a): a is { Name: string; AppID: string } => Boolean(a.Name && a.AppID))
        .map((a) => ({ name: a.Name, appId: a.AppID }));
    } catch {
      apps = [];
    }
  }
  startAppsCache = { at: Date.now(), apps };
  return apps;
}

export function bestMatches<T>(query: string, items: T[], names: (item: T) => string[]): T[] {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    let best: number | null = null;
    for (const n of names(item)) {
      const s = nameScore(query, n);
      if (s !== null && (best === null || s < best)) best = s;
    }
    if (best !== null) scored.push({ item, score: best });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}

export function findConfiguredApp(query: string, config: Config): AppEntry | undefined {
  return bestMatches(query, config.apps, (a) => [a.name, ...a.aliases])[0];
}

export function findSite(query: string, config: Config) {
  return bestMatches(query, config.sites, (s) => [s.name, ...s.aliases])[0];
}

function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const PROTOCOL_LIKE = /^[a-z][a-z0-9+.-]+:(?!\\)/i;

async function launchTarget(entry: AppEntry): Promise<void> {
  if (PROTOCOL_LIKE.test(entry.target) && !/^[a-z]:[\\/]/i.test(entry.target)) {
    await shell.openExternal(entry.target);
    return;
  }
  const args = entry.args ? (entry.args.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, '')) : [];
  try {
    await launchDetached(entry.target, args);
  } catch {
    const error = await shell.openPath(entry.target);
    if (error) throw new Error(error);
  }
}

/** Открывает программу: сначала по списку из настроек, затем по меню «Пуск», затем как команду. */
export async function openApp(query: string, config: Config): Promise<string> {
  const configured = findConfiguredApp(query, config);
  if (configured) {
    await launchTarget(configured);
    return `Запущено: ${configured.name}.`;
  }

  const startApps = await listStartApps();
  const match = bestMatches(query, startApps, (a) => [a.name])[0];
  if (match) {
    await launchDetached('explorer.exe', [`shell:AppsFolder\\${match.appId}`]);
    return `Запущено: ${match.name}.`;
  }

  const direct = await runPowerShell(`Start-Process ${psQuote(query)}`);
  if (direct.code === 0) return `Запущено: ${query}.`;

  const hints = startApps.slice(0, 40).map((a) => a.name).join(', ');
  return `Программа «${query}» не найдена. Установленные программы: ${hints || 'список недоступен'}. Попробуйте точное название или предложите добавить её в настройках.`;
}

/** Закрывает окна программы мягко (как крестик). С `force` — завершает процесс. */
export async function closeApp(query: string, force: boolean): Promise<string> {
  const q = psQuote(normalize(query));
  const script = `
$q = ${q}
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and (($_.ProcessName.ToLower() -like "*$q*") -or ($_.MainWindowTitle.ToLower() -like "*$q*")) }
if (-not $procs) { return 'NONE' }
foreach ($p in $procs) { if (${force ? '$true' : '$false'}) { Stop-Process -Id $p.Id -Force } else { [void]$p.CloseMainWindow() } }
($procs | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '`;
  const r = await runPowerShell(script);
  if (r.code !== 0) throw new Error(r.stderr || 'Не удалось закрыть программу.');
  if (r.stdout.trim() === 'NONE') return `Окон программы «${query}» не найдено.`;
  return `Закрыто: ${r.stdout.trim()}.`;
}
