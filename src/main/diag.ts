import type { DiagnosticResult } from '../shared/ipc';
import { listStartApps } from './apps';
import { pressCombo } from './input';
import { uiList } from './uia';
import type { KetnerClient } from './llm';
import { isWindows, runPowerShell } from './powershell';

async function check(name: string, fn: () => Promise<string>): Promise<DiagnosticResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Самопроверка функций, от которых зависит управление компьютером. Ничего не меняет в системе. */
export async function runDiagnostics(client: Pick<KetnerClient, 'ping'>, hasKey: boolean): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  results.push(
    await check('Windows', async () => {
      if (!isWindows) throw new Error(`Это ${process.platform}: управление компьютером работает только в Windows.`);
      return 'да';
    }),
  );
  if (!isWindows) return results;

  results.push(
    await check('PowerShell и кириллица', async () => {
      const r = await runPowerShell("'Привет, мир'");
      if (r.code !== 0) throw new Error(r.stderr);
      if (r.stdout !== 'Привет, мир') throw new Error(`Вернулось «${r.stdout}» вместо «Привет, мир».`);
      return 'работает';
    }),
  );
  results.push(
    await check('Программы из меню «Пуск»', async () => {
      const apps = await listStartApps(true);
      if (!apps.length) throw new Error('Список пуст: Get-StartApps ничего не вернул.');
      return `найдено ${apps.length}, например: ${apps.slice(0, 4).map((a) => a.name).join(', ')}`;
    }),
  );
  results.push(
    await check('Нажатие клавиш', async () => {
      await pressCombo('f15'); // F15 нигде не используется, но проходит весь путь до системы
      return 'работает';
    }),
  );
  results.push(
    await check('Видимость элементов окна (UI Automation)', async () => {
      const text = await uiList();
      if (!text.startsWith('Элементы')) throw new Error(text);
      return `видны ${text.split('\n').length - 1} элементов активного окна`;
    }),
  );
  results.push(
    await check('Ketner AI', async () => {
      if (!hasKey) throw new Error('Ключ API не задан.');
      const { models } = await client.ping();
      return `подключено, моделей: ${models.length}`;
    }),
  );
  return results;
}
