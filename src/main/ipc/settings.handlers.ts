import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants/ipc-channels'
import { sanitizeSettings } from '../../shared/utils/settings'
import { settingsService } from '../services/settings.service'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS.GET, () => settingsService.get())
  ipcMain.handle(IPC.SETTINGS.SET, (_event, patch: unknown) =>
    settingsService.set(sanitizeSettings(patch))
  )
}
