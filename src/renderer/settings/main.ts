import { PIPER_VOICES, WHISPER_MODELS } from '../../shared/config-defaults';
import type { AppEntry, Config, LogEntry, ModelStatus, PublicConfig, SiteEntry } from '../../shared/types';
import { Sounds } from '../audio/sounds';
import { Speaker } from '../audio/speaker';
import { wakeVariantFromHeard } from '../../shared/text';
import { commaList, debounce, h, lines } from './dom';

const api = window.ketner;
let cfg: PublicConfig;
let models: ModelStatus;
let apiModels: string[] = [];
const sounds = new Sounds();
const speaker = new Speaker(() => cfg, (t) => api.synthesize(t), () => undefined);

const save = debounce((patch: Partial<Config>) => {
  void api.saveConfig(patch).then((next) => {
    cfg = { ...next };
  });
}, 400);

function apply<K extends keyof Config>(key: K, value: Config[K]): void {
  (cfg as Config)[key] = value;
  save({ [key]: value } as Partial<Config>);
}

// --- поля ---------------------------------------------------------------
function row(name: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'row' }, h('label', { class: 'name' }, name), h('div', {}, control, hint ? h('div', { class: 'hint' }, hint) : null));
}

function textRow(name: string, value: string, onChange: (v: string) => void, hint?: string, type = 'text'): HTMLElement {
  return row(name, h('input', { type, value, oninput: (e: Event) => onChange((e.target as HTMLInputElement).value) }), hint);
}

function numberRow(name: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, hint?: string): HTMLElement {
  return row(name, h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), oninput: (e: Event) => {
    const n = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(n)) onChange(n);
  } }), hint);
}

function rangeRow(name: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, hint?: string): HTMLElement {
  const label = h('span', { class: 'hint' }, String(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), oninput: (e: Event) => {
    const n = Number((e.target as HTMLInputElement).value);
    label.textContent = String(n);
    onChange(n);
  } });
  return row(name, h('div', {}, input, label), hint);
}

function checkRow(name: string, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  return row(name, h('div', { class: 'check' }, h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) })), hint);
}

function selectRow(name: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void, hint?: string): HTMLElement {
  const select = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return row(name, select, hint);
}

async function deviceOptions(kind: 'audioinput' | 'audiooutput'): Promise<Array<[string, string]>> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // без доступа к микрофону подписи устройств будут пустыми
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return [['', 'Устройство по умолчанию'], ...devices.map((d, i): [string, string] => [d.deviceId, d.label || `Устройство ${i + 1}`])];
}

// --- разделы -------------------------------------------------------------
function badge(status: ModelStatus['stt']): HTMLElement {
  const map = { ready: ['ok', 'готово'], missing: ['wait', 'не скачано'], downloading: ['wait', 'скачивается…'], error: ['bad', 'ошибка'] } as const;
  const [cls, text] = map[status];
  return h('span', { class: `badge ${cls}` }, text);
}

function statusPage(): HTMLElement {
  const bar = h('div', { class: 'bar' }, h('div', { style: `width:${models.progress?.percent ?? 0}%` }));
  const apiMsg = h('div', { class: 'msg' });
  const test = h('button', { class: 'btn ghost', onclick: async () => {
    apiMsg.className = 'msg';
    apiMsg.textContent = 'Проверяю…';
    const result = await api.testApi();
    apiMsg.className = `msg ${result.ok ? 'ok' : 'bad'}`;
    apiMsg.textContent = result.message;
    apiModels = result.models;
  } }, 'Проверить подключение');

  return h('div', {},
    h('h1', {}, 'Ketner Station'),
    h('p', { class: 'lead' }, 'Скажите «Кетнер», дождитесь сигнала и назовите команду: «открой Яндекс Музыку», «сделай потише», «запусти Discord». Приложение работает в трее и стартует вместе с Windows.'),
    models.error ? h('div', { class: 'card' }, h('div', { class: 'msg bad' }, `Ошибка загрузки: ${models.error}`)) : null,
    h('div', { class: 'card' }, h('h3', {}, 'Распознавание речи (слово «Кетнер») ', badge(models.stt)),
      h('div', { class: 'hint' }, 'Модель Vosk (русский, ~45 МБ). Работает на вашем компьютере, звук с микрофона никуда не отправляется.'),
      models.progress?.kind === 'stt' ? h('div', {}, h('div', { class: 'hint' }, `${models.progress.label}: ${models.progress.percent}%`), bar) : null,
      models.stt === 'ready' ? null : h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: models.stt === 'downloading', onclick: () => void api.downloadModels() }, 'Скачать модель'))),
    h('div', { class: 'card' }, h('h3', {}, 'Распознавание команд (Whisper) ', badge(models.whisper)),
      h('div', { class: 'hint' }, 'Точная расшифровка того, что вы сказали после «Кетнер». Работает на вашем компьютере. Модель small занимает ~180 МБ, выбрать другую можно во вкладке «Голос и звук».'),
      models.progress?.kind === 'whisper' ? h('div', {}, h('div', { class: 'hint' }, `${models.progress.label}: ${models.progress.percent}%`), h('div', { class: 'bar' }, h('div', { style: `width:${models.progress.percent}%` }))) : null,
      cfg.stt.engine === 'whisper' && models.whisper !== 'ready' ? h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: models.whisper === 'downloading', onclick: () => void api.downloadModels() }, 'Скачать Whisper')) : null),
    h('div', { class: 'card' }, h('h3', {}, 'Голос ассистента ', badge(models.piper)),
      h('div', { class: 'hint' }, 'Синтезатор Piper (~25 МБ) и голос (~60 МБ). Пока он не скачан, ассистент говорит голосом Windows.'),
      models.piper === 'ready' ? null : h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: models.piper === 'downloading', onclick: () => void api.downloadModels() }, 'Скачать голос'))),
    h('div', { class: 'card' }, h('h3', {}, 'Ketner AI ', h('span', { class: `badge ${cfg.hasApiKey ? 'ok' : 'bad'}` }, cfg.hasApiKey ? 'ключ задан' : 'нужен ключ')),
      h('div', { class: 'hint' }, 'Команды понимает модель Ketner. Ключ создаётся на сайте в разделе API (нужен тариф Plus и выше). Вставьте его во вкладке «Ketner AI».'),
      h('div', { class: 'actions' }, test), apiMsg));
}

function wakeCalibration(wakeArea: HTMLTextAreaElement): HTMLElement {
  const msg = h('div', { class: 'msg' });
  const button = h('button', { class: 'btn ghost', onclick: async () => {
    button.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Скажите «Кетнер» три раза с паузами (после каждого сигнала)…';
    try {
      const heard = await api.calibrateWake();
      const variants = heard.map(wakeVariantFromHeard).filter((v): v is string => v !== null);
      if (!heard.length) {
        msg.className = 'msg bad';
        msg.textContent = 'Ничего не услышал. Проверьте микрофон и повторите.';
      } else {
        const merged = [...new Set([...lines(wakeArea.value), ...variants])];
        wakeArea.value = merged.join('\n');
        apply('wakeWords', merged);
        msg.className = 'msg ok';
        msg.textContent = `Услышано: ${heard.map((t) => `«${t}»`).join(', ')}. ${variants.length ? 'Варианты добавлены в список.' : 'Слишком непохоже на слово — попробуйте ещё раз.'}`;
      }
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
    } finally {
      button.disabled = false;
    }
  } }, 'Подобрать по голосу');
  return h('div', { class: 'actions' }, button, msg);
}

function voicePage(): HTMLElement {
  const wakeArea = h('textarea', { value: cfg.wakeWords.join('\n'), oninput: (e: Event) => apply('wakeWords', lines((e.target as HTMLTextAreaElement).value)) });
  const micSelect = h('div', {});
  const outSelect = h('div', {});
  void deviceOptions('audioinput').then((opts) => micSelect.replaceChildren(selectRow('Микрофон', opts, cfg.micDeviceId, (v) => apply('micDeviceId', v))));
  void deviceOptions('audiooutput').then((opts) => outSelect.replaceChildren(selectRow('Колонка / устройство вывода', opts, cfg.outputDeviceId, (v) => { apply('outputDeviceId', v); void sounds.setOutput(v); },
    'Сюда идут сигналы и голос ассистента. Выберите вашу колонку или усилитель (Nux, AMP и т.п.), если они видны в Windows как устройство воспроизведения.')));

  const testMsg = h('div', { class: 'msg' });
  return h('div', {},
    h('h1', {}, 'Голос и звук'),
    h('p', { class: 'lead' }, 'Слово активации, микрофон, колонка и голос ответов.'),
    h('div', { class: 'card' },
      row('Слово активации', h('div', {}, wakeArea, wakeCalibration(wakeArea)),
        'По одному варианту на строку. Распознавание может услышать «Кетнер» как «кэтнер» или «катнер» — добавьте то, что видите в журнале (включите «показывать всё, что слышит» на вкладке «Безопасность»).'),
      rangeRow('Уверенность распознавания слова', cfg.wakeMinConfidence, 0, 1, 0.05, (v) => apply('wakeMinConfidence', v), 'Выше — меньше ложных срабатываний, но придётся говорить чётче.'),
      checkRow('Мгновенный сигнал', cfg.earlyWake, (v) => apply('earlyWake', v), 'Сигнал «слушаю» сразу при слове «Кетнер», а не после паузы. Быстрее, но случайных срабатываний больше.'),
      numberRow('Ждать команду, сек', cfg.listenTimeoutSec, 2, 60, 1, (v) => apply('listenTimeoutSec', v)),
      numberRow('Продолжать разговор, сек', cfg.followUpSec, 0, 60, 1, (v) => apply('followUpSec', v), 'После ответа ещё столько секунд слушать без слова «Кетнер». 0 — выключено.'),
      textRow('Горячая клавиша «слушать сейчас»', cfg.hotkey, (v) => apply('hotkey', v), 'Формат Electron, например Control+Alt+K. Пусто — отключить. Также прерывает речь ассистента.')),
    h('div', { class: 'card' },
      selectRow('Расшифровка команд', [['whisper', 'Whisper — точнее (рекомендуется)'], ['vosk', 'Vosk — быстрее, но много ошибок']], cfg.stt.engine, (v) => apply('stt', { ...cfg.stt, engine: v as Config['stt']['engine'] }),
        'Слово «Кетнер» всегда ловит Vosk. Сам текст команды Whisper расшифровывает заново и делает это намного точнее, но тратит 1–3 секунды.'),
      selectRow('Модель Whisper', (Object.entries(WHISPER_MODELS) as Array<[string, { label: string }]>).map(([id, m]): [string, string] => [id, m.label]), cfg.stt.model, (v) => apply('stt', { ...cfg.stt, model: v as Config['stt']['model'] }),
        'После смены модель докачивается автоматически. Если ответы приходят слишком медленно, возьмите base; если слышит неточно — medium.'),
      textRow('Подсказка для Whisper (необязательно)', cfg.stt.prompt, (v) => apply('stt', { ...cfg.stt, prompt: v }), 'Слова и названия, которые часто встречаются в ваших командах. Пусто — без подсказки.')),
    h('div', { class: 'card' }, micSelect, outSelect,
      checkRow('Звуковые сигналы', cfg.sounds, (v) => apply('sounds', v)),
      rangeRow('Громкость сигналов', cfg.soundVolume, 0, 1, 0.05, (v) => apply('soundVolume', v)),
      rangeRow('Громкость голоса', cfg.speechVolume, 0, 1, 0.05, (v) => apply('speechVolume', v)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', onclick: () => { void sounds.setOutput(cfg.outputDeviceId).then(() => sounds.play('wake', cfg.soundVolume)); } }, 'Проверить сигнал'),
        h('button', { class: 'btn ghost', onclick: async () => {
          testMsg.textContent = 'Говорю…';
          try { await speaker.speak('Привет! Я Кетнер. Слышно меня хорошо?'); testMsg.textContent = ''; } catch (e) { testMsg.textContent = String(e); }
        } }, 'Проверить голос'),
        testMsg)),
    h('div', { class: 'card' },
      selectRow('Синтезатор', [['piper', 'Piper (офлайн, выбор колонки)'], ['windows', 'Голос Windows (системное устройство)']], cfg.tts.engine, (v) => apply('tts', { ...cfg.tts, engine: v as Config['tts']['engine'] })),
      selectRow('Голос Piper', PIPER_VOICES.map((v): [string, string] => [v.id, v.label]), cfg.tts.voice, (v) => apply('tts', { ...cfg.tts, voice: v })),
      rangeRow('Скорость речи', cfg.tts.rate, 0.6, 1.6, 0.05, (v) => apply('tts', { ...cfg.tts, rate: v }))));
}

function aiPage(): HTMLElement {
  const keyInput = h('input', { type: 'password', placeholder: cfg.hasApiKey ? '•••••••• (ключ сохранён)' : 'ketner_sk_…', autocomplete: 'off' });
  const keyMsg = h('div', { class: 'msg' });
  const modelSelect = h('div', {}, selectRow('Модель', [['auto', 'auto (подбирает Ketner)'], ...apiModels.filter((m) => m !== 'auto').map((m): [string, string] => [m, m])], cfg.llm.model, (v) => apply('llm', { ...cfg.llm, model: v }),
    'Список приходит после «Проверить подключение».'));
  return h('div', {},
    h('h1', {}, 'Ketner AI'),
    h('p', { class: 'lead' }, 'Модель понимает команды и сама решает, какие действия на компьютере выполнить. Каждая команда тратит запросы вашего тарифа.'),
    h('div', { class: 'card' },
      row('Ключ API', h('div', {}, keyInput, h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => {
          cfg = await api.setApiKey((keyInput as HTMLInputElement).value);
          (keyInput as HTMLInputElement).value = '';
          const result = await api.testApi();
          apiModels = result.models;
          keyMsg.className = `msg ${result.ok ? 'ok' : 'bad'}`;
          keyMsg.textContent = result.message;
          modelSelect.replaceChildren(...[...selectRow('Модель', [['auto', 'auto (подбирает Ketner)'], ...apiModels.filter((m) => m !== 'auto').map((m): [string, string] => [m, m])], cfg.llm.model, (v) => apply('llm', { ...cfg.llm, model: v })).childNodes]);
        } }, 'Сохранить и проверить'),
        h('button', { class: 'btn danger', onclick: async () => { cfg = await api.setApiKey(''); keyMsg.className = 'msg'; keyMsg.textContent = 'Ключ удалён.'; } }, 'Удалить ключ')), keyMsg),
        'Ключ хранится в зашифрованном виде (Windows DPAPI) и отправляется только на указанный ниже адрес.'),
      textRow('Адрес API', cfg.llm.baseUrl, (v) => apply('llm', { ...cfg.llm, baseUrl: v }), 'Для Ketner AI: https://ketner.org/v1. Подойдёт любой OpenAI-совместимый сервер с вызовом функций.'),
      modelSelect,
      numberRow('Максимум шагов на команду', cfg.llm.maxSteps, 1, 12, 1, (v) => apply('llm', { ...cfg.llm, maxSteps: v })),
      rangeRow('Температура', cfg.llm.temperature, 0, 1, 0.05, (v) => apply('llm', { ...cfg.llm, temperature: v }), 'Ниже — точнее и предсказуемее.'),
      textRow('Поиск в интернете', cfg.searchUrl, (v) => apply('searchUrl', v), '{q} заменяется запросом. По умолчанию Яндекс.')));
}

function listEditor<T extends AppEntry | SiteEntry>(title: string, items: T[], columns: Array<{ key: keyof T & string; label: string; list?: boolean; width?: string }>, blank: () => T, onChange: (items: T[]) => void, hint: string): HTMLElement {
  const body = h('tbody');
  const render = () => {
    body.replaceChildren(...items.map((item, i) => h('tr', {},
      ...columns.map((c) => h('td', { style: c.width ? `width:${c.width}` : '' }, h('input', {
        type: 'text',
        value: c.list ? (item[c.key] as unknown as string[]).join(', ') : String(item[c.key] ?? ''),
        oninput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          (item as unknown as Record<string, unknown>)[c.key] = c.list ? commaList(v) : v;
          onChange(items);
        },
      }))),
      h('td', { style: 'width:44px' }, h('button', { class: 'btn danger', title: 'Удалить', onclick: () => { items.splice(i, 1); onChange(items); render(); } }, '✕')))));
  };
  render();
  return h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'hint' }, hint),
    h('table', {}, h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', {}, c.label)), h('th'))), body),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => { items.push(blank()); render(); } }, '+ Добавить')));
}

function appsPage(): HTMLElement {
  const apps = structuredClone(cfg.apps);
  const sites = structuredClone(cfg.sites);
  const startList = h('datalist', { id: 'start-apps' });
  void api.startApps().then((names) => startList.replaceChildren(...names.map((n) => h('option', { value: n }))));
  return h('div', {},
    h('h1', {}, 'Приложения и сайты'),
    h('p', { class: 'lead' }, 'Программы из меню «Пуск» ассистент находит сам. Здесь можно задать свои прозвища и добавить то, чего там нет (портативные программы, скрипты).'),
    startList,
    listEditor('Программы', apps, [
      { key: 'name', label: 'Название' },
      { key: 'aliases', label: 'Как ещё называть (через запятую)', list: true },
      { key: 'target', label: 'Путь, ссылка или протокол (spotify:)' },
      { key: 'args', label: 'Аргументы', width: '16%' },
    ], () => ({ name: '', aliases: [], target: '' }) as AppEntry, (v) => apply('apps', v.filter((a) => a.name.trim() && a.target.trim())),
      'Пример: «Nux Editor», прозвища «нукс», путь C:\\Program Files\\Nux\\Nux.exe.'),
    listEditor('Сайты', sites, [
      { key: 'name', label: 'Название' },
      { key: 'aliases', label: 'Как ещё называть (через запятую)', list: true },
      { key: 'url', label: 'Адрес' },
    ], () => ({ name: '', aliases: [], url: 'https://' }) as SiteEntry, (v) => apply('sites', v.filter((s) => s.name.trim() && /^https?:\/\//i.test(s.url))),
      'Эти адреса ассистент использует, когда вы просите открыть сайт по названию.'));
}

function safetyPage(): HTMLElement {
  return h('div', {},
    h('h1', {}, 'Безопасность'),
    h('p', { class: 'lead' }, 'Ассистент может запускать программы, нажимать клавиши и выполнять команды PowerShell. Распознавание ошибается, а чужой голос может сказать «Кетнер», поэтому опасные действия подтверждаются голосом.'),
    h('div', { class: 'card' },
      selectRow('Подтверждения', [
        ['dangerous', 'Спрашивать только про опасное (рекомендуется)'],
        ['always', 'Спрашивать перед любым действием'],
        ['never', 'Никогда не спрашивать (на свой риск)'],
      ], cfg.confirm, (v) => apply('confirm', v as Config['confirm']),
        'Опасное: удаление файлов, выключение и перезагрузка, закрытие программ и окон, команды PowerShell, клавиши Delete и Alt+F4. Ассистент зачитает действие, ответьте «да» или «нет».'),
      checkRow('Запускать вместе с Windows', cfg.autostart, (v) => apply('autostart', v), 'Тихо, в трее, без окон. Работает у установленной версии.'),
      checkRow('Показывать в журнале всё, что слышит распознавание', cfg.debugHeard, (v) => apply('debugHeard', v), 'Только для отладки: в журнал попадает вся речь рядом с микрофоном. Выключите, когда настроите слово активации.')));
}

function logPage(): HTMLElement {
  const box = h('div', { class: 'log' });
  const add = (e: LogEntry) => {
    const t = new Date(e.time).toLocaleTimeString('ru-RU');
    box.append(h('div', { class: e.kind }, h('time', {}, t), e.text));
    box.scrollTop = box.scrollHeight;
  };
  void api.getLog().then((entries) => entries.forEach(add));
  const off = api.onLog(add);
  window.addEventListener('hashchange', off, { once: true });

  const input = h('input', { type: 'text', placeholder: 'Например: открой блокнот', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void send(); } });
  const send = async () => {
    const text = (input as HTMLInputElement).value.trim();
    if (!text) return;
    (input as HTMLInputElement).value = '';
    await api.runText(text);
  };
  return h('div', {},
    h('h1', {}, 'Журнал и проверка'),
    h('p', { class: 'lead' }, 'Здесь видно, что услышал и сделал ассистент. Команду можно напечатать, чтобы проверить ключ и инструменты без микрофона.'),
    box,
    h('div', { class: 'actions' }, input, h('button', { class: 'btn', onclick: () => void send() }, 'Выполнить'), h('button', { class: 'btn ghost', onclick: () => void api.listenNow() }, 'Слушать сейчас')),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: async (e: Event) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Проверяю…';
      await api.runDiagnostics();
      btn.disabled = false;
      btn.textContent = 'Проверить функции Windows';
    } }, 'Проверить функции Windows')));
}

const PAGES: Array<{ id: string; title: string; render: () => HTMLElement }> = [
  { id: 'status', title: 'Состояние', render: statusPage },
  { id: 'voice', title: 'Голос и звук', render: voicePage },
  { id: 'ai', title: 'Ketner AI', render: aiPage },
  { id: 'apps', title: 'Приложения и сайты', render: appsPage },
  { id: 'safety', title: 'Безопасность', render: safetyPage },
  { id: 'log', title: 'Журнал и проверка', render: logPage },
];

function show(): void {
  const id = location.hash.slice(1) || 'status';
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0]!;
  const nav = document.getElementById('nav')!;
  nav.replaceChildren(
    h('div', { class: 'brand' }, h('i'), 'Ketner Station'),
    ...PAGES.map((p) => h('button', { class: p.id === page.id ? 'active' : '', onclick: () => { location.hash = p.id; } }, p.title)),
  );
  document.getElementById('content')!.replaceChildren(page.render());
}

async function boot(): Promise<void> {
  [cfg, models] = await Promise.all([api.getConfig(), api.modelStatus()]);
  await sounds.setOutput(cfg.outputDeviceId);
  window.addEventListener('hashchange', show);
  api.onModelStatus((s) => {
    models = s;
    if ((location.hash.slice(1) || 'status') === 'status') show();
  });
  show();
}

void boot();
