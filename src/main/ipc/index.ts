import { registerAppHandlers } from './app.handlers'
import { registerConfigHandlers } from './config.handlers'
import { registerFileHandlers } from './file.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { windowBridge } from './window.handlers'

export function registerIpcHandlers(): void {
  registerAppHandlers()
  registerConfigHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  windowBridge.register()
}
