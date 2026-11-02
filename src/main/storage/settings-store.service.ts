import { resolve } from 'path'
import { EffortLevel } from '../../shared/models/effort-level'
import { SettingsStorage } from './settings-storage.service'

export class SettingsStore {
  static readonly DEFAULT_EFFORT = EffortLevel.MEDIUM
  static readonly DEFAULT_MODEL = 'gemini-3.5-flash-lite'

  readonly storage: SettingsStorage

  constructor(appRoot: string) {
    this.storage = new SettingsStorage(resolve(appRoot))
  }

  async getModel(): Promise<string> {
    try {
      const settings = await this.storage.readSettingsDict()
      const model = (settings['model'] ?? '').trim()
      if (model) return model
    } catch {}
    return SettingsStore.DEFAULT_MODEL
  }

  async setModel(model: string): Promise<void> {
    if (!model) return
    await this.storage.saveSettings({ model: String(model).trim() })
  }

  async getEffortLevel(): Promise<EffortLevel> {
    try {
      const settings = await this.storage.readSettingsDict()
      const rawLevel = (settings['effort_level'] ?? '').trim()
      if (rawLevel) return EffortLevel.fromString(rawLevel)
    } catch {}
    return SettingsStore.DEFAULT_EFFORT
  }

  async setEffortLevel(effortLevel: unknown): Promise<void> {
    const level = EffortLevel.fromString(effortLevel)
    await this.storage.saveSettings({ effort_level: level.value })
  }

  async getAll(): Promise<Record<string, string>> {
    try {
      return await this.storage.readSettingsDict()
    } catch {
      return {}
    }
  }

  async update(updates: Record<string, string>): Promise<void> {
    await this.storage.saveSettings(updates)
  }
}
