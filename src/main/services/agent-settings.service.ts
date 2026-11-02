import { resolve } from 'path'
import { defaultSettingsBlock, parseSettingsMarkdown } from '../../shared/utils/settings-doc'
import {
  ensureDatabaseSettings,
  readDatabaseSettings,
  saveDatabaseSettings,
  settingsScope,
  type SettingsStorageInfo
} from './settings-db.service'

export interface CurrentPreferences {
  model: string
  activeFunction: string
  mode: string
}

export class AgentSettings {
  private readonly appRoot: string

  constructor(appRoot: string) {
    this.appRoot = resolve(appRoot)
  }

  async ensureSettings(current: CurrentPreferences): Promise<void> {
    ensureDatabaseSettings(
      this.appRoot,
      parseSettingsMarkdown(defaultSettingsBlock(current.model, current.activeFunction, current.mode))
    )
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
