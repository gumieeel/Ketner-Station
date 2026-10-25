import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../shared/types';
import { closeApp, findSite, openApp } from './apps';
import { mediaControl, mouseClick, mouseScroll, pressCombo, typeText, type MediaAction } from './input';
import { parseCombo } from './keys';
import { isWindows, runNative, runPowerShell } from './powershell';
import type { TimerManager } from './timers';
import { uiClick, uiList } from './uia';

export interface ToolContext {
  config: Config;
  timers: TimerManager;
}

type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Опасное действие: при политике «dangerous» требует голосового подтверждения. */
  danger?: boolean | ((args: Args) => boolean);
  /** Короткая фраза для вопроса «Выполнить: …?». */
  describe: (args: Args) => string;
  run: (args: Args, ctx: ToolContext) => Promise<string>;
}

const str = (args: Args, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Не указан параметр «${key}».`);
  return v.trim();
};
const num = (args: Args, key: string, fallback?: number): number => {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Не указан числовой параметр «${key}».`);
};

export function assertHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Некорректный адрес «${raw}».`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Разрешены только адреса http и https.');
  }
  return url.toString();
}

const KNOWN_FOLDERS: Record<string, () => string> = {
  downloads: () => app.getPath('downloads'),
  загрузки: () => app.getPath('downloads'),
  desktop: () => app.getPath('desktop'),
  'рабочий стол': () => app.getPath('desktop'),
  documents: () => app.getPath('documents'),
  документы: () => app.getPath('documents'),
  pictures: () => app.getPath('pictures'),
  изображения: () => app.getPath('pictures'),
  music: () => app.getPath('music'),
  музыка: () => app.getPath('music'),
  videos: () => app.getPath('videos'),
  видео: () => app.getPath('videos'),
  home: () => app.getPath('home'),
};

export function resolvePath(raw: string): string {
  const known = KNOWN_FOLDERS[raw.trim().toLowerCase()];
  if (known) return known();
  if (raw.startsWith('~')) return path.join(app.getPath('home'), raw.slice(1));
  return path.resolve(raw);
}

const DANGEROUS_CLICK = /удал|delete|remove|оплат|купить|pay|buy|форматир|format|выключ|shutdown|отправить|send/i;
const DANGEROUS_COMBO = /(^|\+)(delete|del|f4)(\+|$)/i;
const truncate = (s: string, n = 1500): string => (s.length > n ? `${s.slice(0, n)}… (обрезано)` : s);

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: 'open_app',
    description:
      'Запустить программу на компьютере (Discord, Telegram, Chrome, Steam, Блокнот…). Указывайте название так, как оно в меню «Пуск» или в списке приложений пользователя, обычно латиницей.',
    parameters: obj({ name: { type: 'string', description: 'Название программы' } }, ['name']),
    describe: (a) => `открыть программу ${String(a['name'])}`,
    run: (a, ctx) => openApp(str(a, 'name'), ctx.config),
  },
  {
    name: 'close_app',
    description: 'Закрыть окна программы (как крестик). force=true — принудительно завершить.',
    parameters: obj({ name: { type: 'string' }, force: { type: 'boolean' } }, ['name']),
    danger: true,
    describe: (a) => `закрыть программу ${String(a['name'])}`,
    run: (a) => closeApp(str(a, 'name'), a['force'] === true),
  },
  {
    name: 'open_url',
    description:
      'Открыть сайт в браузере по умолчанию. Для сайтов из списка пользователя используйте их адреса. Можно давать ссылки на поиск внутри сайта (например https://music.yandex.ru/search?text=…).',
    parameters: obj({ url: { type: 'string' } }, ['url']),
    describe: (a) => `открыть сайт ${String(a['url'])}`,
    run: async (a, ctx) => {
      const raw = str(a, 'url');
      const site = findSite(raw, ctx.config);
      const url = assertHttpUrl(site && !/[./]/.test(raw) ? site.url : raw);
      await shell.openExternal(url);
      return `Открыто: ${url}`;
    },
  },
  {
    name: 'search_web',
    description: 'Поиск в интернете через поисковик пользователя: открывает страницу результатов в браузере.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    describe: (a) => `искать в интернете «${String(a['query'])}»`,
    run: async (a, ctx) => {
      const url = ctx.config.searchUrl.replace('{q}', encodeURIComponent(str(a, 'query')));
      await shell.openExternal(assertHttpUrl(url));
      return 'Открыта страница поиска.';
    },
  },
  {
    name: 'media_control',
    description:
      'Музыка и громкость: play_pause, next, previous, stop, volume_up, volume_down (value — на сколько процентов, по умолчанию 10), mute (вкл/выкл звук), set_volume (value 0..100). Управляет тем, что сейчас играет в системе (браузер, Spotify и т.д.).',
    parameters: obj(
      {
        action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute', 'set_volume'] },
        value: { type: 'number' },
      },
      ['action'],
    ),
    describe: (a) => `медиа: ${String(a['action'])}`,
    run: (a) => mediaControl(str(a, 'action') as MediaAction, typeof a['value'] === 'number' ? a['value'] : undefined),
  },
  {
    name: 'press_keys',
    description:
      'Нажать сочетание клавиш, например "ctrl+t", "alt+tab", "win+d", "ctrl+shift+esc", "f11", "space", "enter". Имена латиницей, через «+». repeat — сколько раз повторить.',
    parameters: obj({ keys: { type: 'string' }, repeat: { type: 'number' } }, ['keys']),
    danger: (a) => DANGEROUS_COMBO.test(String(a['keys'] ?? '')),
    describe: (a) => `нажать клавиши ${String(a['keys'])}`,
    run: async (a) => {
      const keys = str(a, 'keys');
      parseCombo(keys);
      await pressCombo(keys, num(a, 'repeat', 1));
      return `Нажато: ${keys}.`;
    },
  },
  {
    name: 'type_text',
    description: 'Напечатать текст в активном окне (вставляется через буфер обмена). Если нужно отправить — потом нажмите enter через press_keys.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    describe: (a) => `напечатать текст «${String(a['text']).slice(0, 60)}»`,
    run: async (a) => {
      await typeText(str(a, 'text'));
      return 'Текст напечатан.';
    },
  },
  {
    name: 'mouse',
    description: 'Мышь в текущей позиции курсора: left_click, double_click, right_click, scroll_up, scroll_down (amount — число щелчков колеса, по умолчанию 3). Экрана модель не видит, поэтому точные координаты недоступны.',
    parameters: obj(
      { action: { type: 'string', enum: ['left_click', 'double_click', 'right_click', 'scroll_up', 'scroll_down'] }, amount: { type: 'number' } },
      ['action'],
    ),
    describe: (a) => `мышь: ${String(a['action'])}`,
    run: async (a) => {
      const action = str(a, 'action');
      const amount = Math.max(1, Math.min(30, num(a, 'amount', 3)));
      if (action === 'left_click') await mouseClick('left');
      else if (action === 'double_click') await mouseClick('left', true);
      else if (action === 'right_click') await mouseClick('right');
      else if (action === 'scroll_up') await mouseScroll(amount);
      else if (action === 'scroll_down') await mouseScroll(-amount);
      else throw new Error(`Неизвестное действие «${action}».`);
      return 'Готово.';
    },
  },
  {
    name: 'window_control',
    description:
      'Окна и рабочий стол: show_desktop (свернуть всё), minimize, maximize, restore, close_active, switch_window (alt+tab), task_view, lock_screen, screenshot (Win+Shift+S, область экрана), settings (параметры Windows), explorer (проводник).',
    parameters: obj(
      { action: { type: 'string', enum: ['show_desktop', 'minimize', 'maximize', 'restore', 'close_active', 'switch_window', 'task_view', 'lock_screen', 'screenshot', 'settings', 'explorer'] } },
      ['action'],
    ),
    danger: (a) => a['action'] === 'close_active',
    describe: (a) => `окна: ${String(a['action'])}`,
    run: async (a) => {
      const combos: Record<string, string> = {
        show_desktop: 'win+d',
        minimize: 'win+down',
        maximize: 'win+up',
        restore: 'win+down',
        close_active: 'alt+f4',
        switch_window: 'alt+tab',
        task_view: 'win+tab',
        screenshot: 'win+shift+s',
        settings: 'win+i',
        explorer: 'win+e',
      };
      const action = str(a, 'action');
      if (action === 'lock_screen') {
        const r = await runNative('rundll32.exe', ['user32.dll,LockWorkStation']);
        if (r.code !== 0) throw new Error(r.stderr || 'Не удалось заблокировать экран.');
        return 'Экран заблокирован.';
      }
      const combo = combos[action];
      if (!combo) throw new Error(`Неизвестное действие «${action}».`);
      await pressCombo(combo);
      return 'Готово.';
    },
  },
  {
    name: 'ui_list',
    description:
      'Увидеть, что есть в активном окне (в том числе на открытой странице сайта): список кнопок, ссылок, вкладок и полей. Используйте, когда нужно нажать что-то на экране, но точное название неизвестно, или после ui_click с ответом «не найден».',
    parameters: obj({}),
    describe: () => 'посмотреть элементы окна',
    run: () => uiList(),
  },
  {
    name: 'ui_click',
    description:
      'Нажать кнопку, ссылку или вкладку в активном окне по её названию (достаточно части названия, регистр не важен), например «Моя волна», «Воспроизвести», «Поиск». Работает и на сайтах в браузере. Сам ждёт появления элемента (до timeout секунд), поэтому после open_url вызывать wait не нужно.',
    parameters: obj(
      {
        text: { type: 'string', description: 'Название элемента на экране' },
        alternatives: { type: 'array', items: { type: 'string' }, description: 'Другие возможные названия того же элемента' },
        timeout: { type: 'number', description: 'Сколько секунд ждать появления элемента (по умолчанию 15)' },
      },
      ['text'],
    ),
    danger: (a) => DANGEROUS_CLICK.test(String(a['text'] ?? '')),
    describe: (a) => `нажать «${String(a['text'])}» на экране`,
    run: (a) =>
      uiClick(
        str(a, 'text'),
        Array.isArray(a['alternatives']) ? a['alternatives'].filter((x): x is string => typeof x === 'string') : [],
        num(a, 'timeout', 15),
      ),
  },
  {
    name: 'open_path',
    description: 'Открыть папку или файл в Windows. Можно указать путь или одно из имён: downloads/загрузки, desktop/рабочий стол, documents/документы, pictures, music, videos, home.',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    describe: (a) => `открыть ${String(a['path'])}`,
    run: async (a) => {
      const target = resolvePath(str(a, 'path'));
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return `Открыто: ${target}`;
    },
  },
  {
    name: 'list_dir',
    description: 'Показать содержимое папки (до 60 элементов).',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    describe: (a) => `показать папку ${String(a['path'])}`,
    run: async (a) => {
      const dir = resolvePath(str(a, 'path'));
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 60).map((e) => (e.isDirectory() ? `[папка] ${e.name}` : e.name));
      return `${dir}: ${entries.length} элементов\n${lines.join('\n')}`;
    },
  },
  {
    name: 'create_folder',
    description: 'Создать папку (вместе с недостающими родительскими).',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    describe: (a) => `создать папку ${String(a['path'])}`,
    run: async (a) => {
      const dir = resolvePath(str(a, 'path'));
      await fs.promises.mkdir(dir, { recursive: true });
      return `Папка создана: ${dir}`;
    },
  },
  {
    name: 'delete_path',
    description: 'Переместить файл или папку в корзину (можно восстановить).',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    danger: true,
    describe: (a) => `удалить в корзину ${String(a['path'])}`,
    run: async (a) => {
      const target = resolvePath(str(a, 'path'));
      if (!fs.existsSync(target)) throw new Error(`Не найдено: ${target}`);
      await shell.trashItem(target);
      return `Перемещено в корзину: ${target}`;
    },
  },
  {
    name: 'power',
    description:
      'Питание компьютера: lock, sleep, hibernate, restart, shutdown (с задержкой 15 секунд), cancel (отменить запланированное выключение или перезагрузку).',
    parameters: obj({ action: { type: 'string', enum: ['lock', 'sleep', 'hibernate', 'restart', 'shutdown', 'cancel'] } }, ['action']),
    danger: (a) => a['action'] !== 'lock' && a['action'] !== 'cancel',
    describe: (a) => {
      const names: Record<string, string> = { sleep: 'перевести в сон', hibernate: 'гибернация', restart: 'перезагрузить компьютер', shutdown: 'выключить компьютер' };
      return names[String(a['action'])] ?? `питание: ${String(a['action'])}`;
    },
    run: async (a) => {
      const action = str(a, 'action');
      const commands: Record<string, [string, string[]]> = {
        lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
        hibernate: ['shutdown.exe', ['/h']],
        restart: ['shutdown.exe', ['/r', '/t', '15']],
        shutdown: ['shutdown.exe', ['/s', '/t', '15']],
        cancel: ['shutdown.exe', ['/a']],
      };
      if (action === 'sleep') {
        const r = await runPowerShell(
          'Add-Type -AssemblyName System.Windows.Forms;[void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend,$false,$false)',
        );
        if (r.code !== 0) throw new Error(r.stderr || 'Не удалось уйти в сон.');
        return 'Готово.';
      }
      const command = commands[action];
      if (!command) throw new Error(`Неизвестное действие «${action}».`);
      const r = await runNative(command[0], command[1]);
      if (r.code !== 0) throw new Error(r.stderr || 'Команда не выполнена.');
      return action === 'restart' || action === 'shutdown' ? 'Запланировано через 15 секунд. Чтобы отменить, скажите «отмени выключение».' : 'Готово.';
    },
  },
  {
    name: 'set_timer',
    description: 'Поставить таймер или напоминание: через seconds секунд ассистент скажет вслух label.',
    parameters: obj({ seconds: { type: 'number' }, label: { type: 'string' } }, ['seconds']),
    describe: (a) => `поставить таймер на ${String(a['seconds'])} секунд`,
    run: async (a, ctx) => {
      const seconds = Math.max(1, Math.min(24 * 3600, Math.round(num(a, 'seconds'))));
      const label = typeof a['label'] === 'string' && a['label'].trim() ? a['label'].trim() : 'Время вышло';
      ctx.timers.add(seconds, label);
      return `Таймер на ${seconds} с поставлен.`;
    },
  },
  {
    name: 'cancel_timers',
    description: 'Отменить все таймеры и напоминания.',
    parameters: obj({}),
    describe: () => 'отменить таймеры',
    run: async (_a, ctx) => `Отменено таймеров: ${ctx.timers.cancelAll()}.`,
  },
  {
    name: 'wait',
    description: 'Подождать (до 15 секунд), например пока откроется сайт, прежде чем нажимать клавиши.',
    parameters: obj({ seconds: { type: 'number' } }, ['seconds']),
    describe: () => 'подождать',
    run: async (a) => {
      const seconds = Math.max(0.2, Math.min(15, num(a, 'seconds')));
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return 'Готово.';
    },
  },
  {
    name: 'run_powershell',
    description:
      'Выполнить команду PowerShell, если ни один другой инструмент не подходит. Обязательно передайте description — одну короткую русскую фразу, что команда делает: её зачитают пользователю для подтверждения.',
    parameters: obj({ command: { type: 'string' }, description: { type: 'string' } }, ['command', 'description']),
    danger: true,
    describe: (a) => String(a['description'] ?? 'выполнить команду PowerShell'),
    run: async (a) => {
      const r = await runPowerShell(str(a, 'command'), 30_000);
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
      if (r.timedOut) return `Команда не уложилась в 30 секунд. ${truncate(out)}`;
      return r.code === 0 ? truncate(out || 'Выполнено.') : `Ошибка (код ${r.code}): ${truncate(out)}`;
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function toOpenAiTools() {
  return TOOLS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function isDangerous(tool: ToolDef, args: Args): boolean {
  return typeof tool.danger === 'function' ? tool.danger(args) : Boolean(tool.danger);
}

export function needsConfirmation(tool: ToolDef, args: Args, policy: Config['confirm']): boolean {
  if (policy === 'never') return false;
  if (policy === 'always') return !['wait', 'cancel_timers', 'set_timer'].includes(tool.name);
  return isDangerous(tool, args);
}

export { isWindows };
