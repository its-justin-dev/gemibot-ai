import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import { fileService } from '../services/file.service'

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE.OPEN_DIALOG, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    return fileService.openTextFile(window)
  })
}
