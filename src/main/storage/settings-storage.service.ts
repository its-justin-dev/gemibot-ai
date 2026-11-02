import { resolve } from 'path'
import {
  readDatabaseSettings,
  saveDatabaseSettings,
  settingsScope,
  type SettingsStorageInfo
} from '../services/settings-db.service'

/** Settings live in the conversation database under one scope per application folder. */
export class SettingsStorage {
  private readonly appRoot: string

  constructor(appRoot: string) {
    this.appRoot = resolve(appRoot)
  }

  async readSettingsDict(): Promise<Record<string, string>> {
    return readDatabaseSettings(this.appRoot)
  }

  async saveSettings(updates: Record<string, string>): Promise<void> {
    saveDatabaseSettings(this.appRoot, updates)
  }

  storageInfo(): SettingsStorageInfo {
    return { scope: settingsScope(this.appRoot) }
  }
}
