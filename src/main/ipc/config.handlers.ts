import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import { configService } from '../services/config.service'

export function registerConfigHandlers(): void {
  ipcMain.handle(IPC.CONFIG.GET, () => configService.get())
}
