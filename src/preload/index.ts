import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AudioRpcMethod, type KetnerApi } from '../shared/ipc';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KetnerApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: (patch) => ipcRenderer.invoke(IPC.saveConfig, patch),
  setApiKey: (key) => ipcRenderer.invoke(IPC.setApiKey, key),
  testApi: () => ipcRenderer.invoke(IPC.testApi),
  modelStatus: () => ipcRenderer.invoke(IPC.modelStatus),
  downloadModels: () => ipcRenderer.invoke(IPC.downloadModels),
  getLog: () => ipcRenderer.invoke(IPC.getLog),
  runText: (text) => ipcRenderer.invoke(IPC.runText, text),
  listenNow: () => ipcRenderer.invoke(IPC.listenNow),
  calibrateWake: () => ipcRenderer.invoke(IPC.calibrate),
  startApps: () => ipcRenderer.invoke(IPC.startApps),
  onConfig: (cb) => subscribe(IPC.configChanged, cb),
  onModelStatus: (cb) => subscribe(IPC.modelStatusChanged, cb),
  onLog: (cb) => subscribe(IPC.logEntry, cb),

  command: (text) => ipcRenderer.invoke(IPC.command, text),
  synthesize: (text) => ipcRenderer.invoke(IPC.synthesize, text),
  heard: (text, final) => ipcRenderer.send(IPC.heard, { text, final }),
  audioState: (state) => ipcRenderer.send(IPC.audioState, state),
  audioError: (text) => ipcRenderer.send(IPC.audioError, text),
  onRpc: (handler) => {
    ipcRenderer.on(IPC.rpc, (_e, req: { id: number; method: AudioRpcMethod; payload: unknown }) => {
      handler(req.method, req.payload).then(
        (value) => ipcRenderer.send(IPC.rpcReply, { id: req.id, value }),
        (err: unknown) => ipcRenderer.send(IPC.rpcReply, { id: req.id, error: err instanceof Error ? err.message : String(err) }),
      );
    });
  },
};

contextBridge.exposeInMainWorld('ketner', api);
