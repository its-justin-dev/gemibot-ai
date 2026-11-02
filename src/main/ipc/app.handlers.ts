import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.APP.GET_VERSION, () => app.getVersion())
  ipcMain.handle(IPC.APP.GET_PLATFORM, () => ({
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    isPackaged: app.isPackaged,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }))
}
