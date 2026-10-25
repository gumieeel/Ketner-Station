import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC, type AudioState, type TestApiResult } from '../shared/ipc';
import type { CommandResult, Config } from '../shared/types';
import { listStartApps } from './apps';
import { safeJoin } from './archive';
import { Assistant } from './assistant';
import { ConfigStore } from './config';
import { runDiagnostics } from './diag';
import { KetnerClient, LlmError } from './llm';
import { ModelManager } from './models';
import { AudioRpc } from './rpc';
import { TimerManager } from './timers';
import { transcribe } from './stt';
import { synthesize } from './tts';

const SCHEME = 'ketner';
const ORIGIN = `${SCHEME}://app/`;
const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

function resourcePath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'resources', name) : path.join(app.getAppPath(), 'resources', name);
}

async function main(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId('org.ketner.station');

  const configStore = new ConfigStore();
  configStore.load();
  const firstRun = !fs.existsSync(path.join(app.getPath('userData'), 'config.json'));
  const models = new ModelManager();
  const rpc = new AudioRpc();
  const assistantRef: { current: Assistant | null } = { current: null };
  const timers = new TimerManager((label) => void assistantRef.current?.say(label, true));
  const client = new KetnerClient(() => configStore.get(), () => configStore.getApiKey());
  const assistant = new Assistant(configStore, client, rpc, timers);
  assistantRef.current = assistant;

  const rendererDir = path.join(app.getAppPath(), 'dist', 'renderer');

  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const pathname = decodeURIComponent(url.pathname);
      const file = pathname.startsWith('/models/')
        ? safeJoin(models.modelsDir, pathname.slice('/models/'.length))
        : safeJoin(rendererDir, pathname === '/' ? 'settings.html' : pathname.slice(1));
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Микрофон нужен только нашим собственным страницам.
  const ours = (url: string) => url.startsWith(ORIGIN);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(ours(wc.getURL()) && permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => Boolean(wc && ours(wc.getURL())) && permission === 'media');

  let audioWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let audioState: AudioState = 'loading';
  let paused = false;

  const webPreferences = (): Electron.WebPreferences => ({
    preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    backgroundThrottling: false,
  });

  const lockDown = (win: BrowserWindow) => {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!ours(url)) e.preventDefault();
    });
  };

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const createAudioWindow = () => {
    audioWindow = new BrowserWindow({ show: false, width: 400, height: 300, skipTaskbar: true, webPreferences: webPreferences() });
    lockDown(audioWindow);
    rpc.attach(audioWindow.webContents);
    void audioWindow.loadURL(`${ORIGIN}audio.html`);
    audioWindow.on('closed', () => (audioWindow = null));
    if (isDev) audioWindow.webContents.openDevTools({ mode: 'detach' });
  };

  const openSettings = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 820,
      minHeight: 600,
      title: 'Ketner Station',
      backgroundColor: '#14171a',
      autoHideMenuBar: true,
      icon: resourcePath('icon.png'),
      webPreferences: webPreferences(),
    });
    settingsWindow.setMenu(null);
    lockDown(settingsWindow);
    void settingsWindow.loadURL(`${ORIGIN}settings.html`);
    settingsWindow.on('closed', () => (settingsWindow = null));
  };

  const STATE_LABEL: Record<AudioState, string> = {
    loading: 'Загрузка…',
    idle: 'Жду слово «Кетнер»',
    listening: 'Слушаю…',
    thinking: 'Думаю…',
    speaking: 'Говорю…',
    paused: 'Микрофон выключен',
    error: 'Ошибка — откройте настройки',
  };

  const refreshTray = () => {
    if (!tray) return;
    const active = audioState === 'listening' || audioState === 'thinking' || audioState === 'speaking';
    tray.setImage(nativeImage.createFromPath(resourcePath(active ? 'tray-active.png' : 'tray.png')));
    tray.setToolTip(`Ketner Station — ${STATE_LABEL[audioState]}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: STATE_LABEL[audioState], enabled: false },
        { type: 'separator' },
        { label: 'Говорить сейчас', click: () => void rpc.call('listen').catch(() => undefined) },
        {
          label: 'Выключить микрофон',
          type: 'checkbox',
          checked: paused,
          click: (item) => {
            paused = item.checked;
            void rpc.call('pause', { paused }).catch(() => undefined);
          },
        },
        { label: 'Настройки…', click: openSettings },
        { type: 'separator' },
        { label: 'Выход', click: () => app.quit() },
      ]),
    );
  };

  const applyConfig = (cfg: Config) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.autostart, args: ['--hidden'] });
    globalShortcut.unregisterAll();
    if (cfg.hotkey) {
      try {
        globalShortcut.register(cfg.hotkey, () => void rpc.call('listen').catch(() => undefined));
      } catch {
        assistant.log('error', `Не удалось назначить горячую клавишу «${cfg.hotkey}».`);
      }
    }
  };

  // --- IPC ---------------------------------------------------------------
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => ours(e.senderFrame?.url ?? '');
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('Запрещено.');
      return fn(...(args as A));
    });

  handle(IPC.getConfig, () => configStore.getPublic());
  handle(IPC.saveConfig, (patch: Partial<Config>) => {
    configStore.update(patch);
    return configStore.getPublic();
  });
  handle(IPC.setApiKey, (key: string) => {
    configStore.setApiKey(String(key ?? ''));
    return configStore.getPublic();
  });
  handle(IPC.testApi, async (): Promise<TestApiResult> => {
    try {
      const { models: ids } = await client.ping();
      return { ok: true, message: `Подключено. Доступных моделей: ${ids.length}.`, models: ids };
    } catch (err) {
      return { ok: false, message: err instanceof LlmError ? err.message : String(err), models: [] };
    }
  });
  handle(IPC.modelStatus, () => models.status());
  handle(IPC.downloadModels, async () => {
    const c = configStore.get();
    models.refresh(c.tts.voice, c.stt.model);
    await models.ensureStt().catch(() => undefined);
    if (c.stt.engine === 'whisper') await models.ensureWhisper(c.stt.model).catch(() => undefined);
    if (c.tts.engine === 'piper') await models.ensurePiper(c.tts.voice).catch(() => undefined);
  });
  handle(IPC.getLog, () => assistant.getLog());
  handle(IPC.runText, (text: string): Promise<CommandResult> => assistant.handle(String(text), 'text'));
  handle(IPC.command, (text: string): Promise<CommandResult> => assistant.handle(String(text), 'voice'));
  handle(IPC.listenNow, () => rpc.call('listen'));
  handle(IPC.diagnostics, async () => {
    const results = await runDiagnostics(client, Boolean(configStore.getApiKey()));
    for (const r of results) assistant.log(r.ok ? 'info' : 'error', `Проверка «${r.name}»: ${r.ok ? 'ок' : 'ОШИБКА'} — ${r.detail}`);
    return results;
  });
  handle(IPC.calibrate, () => rpc.call<string[]>('calibrate', { count: 3 }, 60_000));
  handle(IPC.startApps, async () => (await listStartApps()).map((a) => a.name).sort((a, b) => a.localeCompare(b, 'ru')));
  handle(IPC.synthesize, async (text: string) => {
    const cfg = configStore.get();
    if (!models.piperReady(cfg.tts.voice)) return null;
    const wav = await synthesize(String(text), cfg, models);
    return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  });
  handle(IPC.transcribe, async (samples: ArrayBuffer) => {
    const cfg = configStore.get();
    if (cfg.stt.engine !== 'whisper' || !models.whisperReady(cfg.stt.model)) return null;
    try {
      return await transcribe(new Float32Array(samples), cfg, models);
    } catch (err) {
      assistant.log('error', `Whisper: ${err instanceof Error ? err.message : String(err)} — использую Vosk.`);
      return null;
    }
  });
  ipcMain.on(IPC.heard, (e, payload: { text: string; final: boolean }) => {
    if (trusted(e) && payload.final && configStore.get().debugHeard) assistant.log('info', `Услышано: «${payload.text}»`);
  });
  ipcMain.on(IPC.audioState, (e, state: AudioState) => {
    if (!trusted(e)) return;
    audioState = state;
    refreshTray();
  });
  ipcMain.on(IPC.audioError, (e, text: string) => {
    if (trusted(e)) assistant.log('error', String(text));
  });
  ipcMain.on(IPC.openSettings, (e) => {
    if (trusted(e)) openSettings();
  });

  configStore.onChange((cfg) => {
    applyConfig(cfg);
    broadcast(IPC.configChanged, configStore.getPublic());
    void rpc.call('reconfigure').catch(() => undefined);
    models.refresh(cfg.tts.voice, cfg.stt.model);
    if (cfg.tts.engine === 'piper') void models.ensurePiper(cfg.tts.voice).catch(() => undefined);
    if (cfg.stt.engine === 'whisper') void models.ensureWhisper(cfg.stt.model).catch(() => undefined);
  });
  models.onStatus((status) => broadcast(IPC.modelStatusChanged, status));
  assistant.onLog((entry) => broadcast(IPC.logEntry, entry));
  app.on('second-instance', openSettings);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => undefined); // живём в трее

  process.on('uncaughtException', (err) => assistant.log('error', `Необработанная ошибка: ${err.message}`));
  process.on('unhandledRejection', (err) => assistant.log('error', `Необработанная ошибка: ${err instanceof Error ? err.message : String(err)}`));

  // --- старт ---------------------------------------------------------------
  tray = new Tray(nativeImage.createFromPath(resourcePath('tray.png')));
  tray.on('click', openSettings);
  refreshTray();
  applyConfig(configStore.get());
  createAudioWindow();

  models.refresh(configStore.get().tts.voice, configStore.get().stt.model);
  if (configStore.get().stt.engine === 'whisper') {
    void models.ensureWhisper(configStore.get().stt.model).catch((err) => assistant.log('error', `Whisper: ${err instanceof Error ? err.message : String(err)}`));
  }
  void models.ensureStt().catch((err) => assistant.log('error', `Модель распознавания: ${err instanceof Error ? err.message : String(err)}`));
  if (configStore.get().tts.engine === 'piper') {
    void models.ensurePiper(configStore.get().tts.voice).catch((err) => assistant.log('error', `Синтезатор речи: ${err instanceof Error ? err.message : String(err)}`));
  }
  void listStartApps().catch(() => undefined);

  if (firstRun || !configStore.getApiKey() || (!startHidden && isDev)) openSettings();

  if (process.platform !== 'win32') assistant.log('info', 'Управление компьютером работает только в Windows: здесь команды выполняться не будут.');
}
