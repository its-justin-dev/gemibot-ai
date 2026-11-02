import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/constants/ipc-channels'
import type { PlatformInfo } from '../shared/types/app'
import type { MainConfig } from '../shared/types/config'
import type { AppSettings, SettingsPatch } from '../shared/types/settings'
import type { ApiKeyInfo, ApiKeyResult } from '../shared/types/api-key'
import type { FileDiffDict } from '../shared/models/file-diff'
import type {
  TimelineSaveTarget,
  WindowAnswer,
  WindowCommand,
  WindowEvent,
  WindowReply,
  WindowRequest,
  WindowSnapshot
} from '../shared/types/window'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP.GET_VERSION),
  getPlatformInfo: (): Promise<PlatformInfo> => ipcRenderer.invoke(IPC.APP.GET_PLATFORM),

  openFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.FILE.OPEN_DIALOG),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS.GET),
  setSettings: (patch: SettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SETTINGS.SET, patch),

  getConfig: (): Promise<MainConfig> => ipcRenderer.invoke(IPC.CONFIG.GET),

  getApiKey: (): Promise<ApiKeyInfo> => ipcRenderer.invoke(IPC.API_KEY.GET),
  saveApiKey: (key: string): Promise<ApiKeyResult> => ipcRenderer.invoke(IPC.API_KEY.SET, key),

  getWindowSnapshot: (): Promise<WindowSnapshot> => ipcRenderer.invoke(IPC.WINDOW.SNAPSHOT),
  onWindowEvent: (listener: (event: WindowEvent) => void): (() => void) =>
    subscribe(IPC.WINDOW.EVENT, listener),
  onWindowRequest: (listener: (request: WindowRequest) => void): (() => void) =>
    subscribe(IPC.WINDOW.REQUEST, listener),
  replyWindowRequest: (id: number, answer: WindowAnswer): void => {
    const reply: WindowReply = { id, answer }
    ipcRenderer.send(IPC.WINDOW.REPLY, reply)
  },
  sendWindowCommand: (cmd: WindowCommand): void => ipcRenderer.send(IPC.WINDOW.COMMAND, cmd),
  getDiff: (path: string): Promise<FileDiffDict | null> =>
    ipcRenderer.invoke(IPC.WINDOW.DIFF, path),
  pickSaveTimelineFile: (): Promise<TimelineSaveTarget | null> =>
    ipcRenderer.invoke(IPC.WINDOW.SAVE_DIALOG)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
