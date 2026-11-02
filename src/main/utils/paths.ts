import { app } from 'electron'
import { join } from 'path'

export const paths = {
  userData: (): string => app.getPath('userData'),
  settingsFile: (): string => join(app.getPath('userData'), 'settings.json'),
  resource: (...segments: string[]): string =>
    app.isPackaged
      ? join(process.resourcesPath, ...segments)
      : join(app.getAppPath(), 'resources', ...segments)
}
