import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from '../../shared/utils/settings'
import type { AppSettings } from '../../shared/types/settings'
import { paths } from '../utils/paths'
import { log } from './logger.service'
import { isDatabaseOpen } from './database.service'
import { settingsRepository } from './long-term-repository.service'

const APP_SETTINGS_SCOPE = '@app'

type AppSettingsKey = keyof AppSettings

const APP_SETTING_KEYS: Record<AppSettingsKey, string> = {
  theme: 'theme',
  displayName: 'displayName',
  multiAgentEnabled: 'multiAgentEnabled',
  multiAgentMaxSubAgents: 'multiAgentMaxSubAgents'
}

let cache: AppSettings | null = null

function serialize(settings: AppSettings): Record<string, string> {
  return {
    [APP_SETTING_KEYS.theme]: settings.theme,
    [APP_SETTING_KEYS.displayName]: settings.displayName,
    [APP_SETTING_KEYS.multiAgentEnabled]: String(settings.multiAgentEnabled),
    [APP_SETTING_KEYS.multiAgentMaxSubAgents]: String(settings.multiAgentMaxSubAgents)
  }
}

function deserialize(rows: Record<string, string>): AppSettings {
  const patch: Record<string, unknown> = {}
  const theme = rows[APP_SETTING_KEYS.theme]
  if (theme !== undefined) patch.theme = theme
  const displayName = rows[APP_SETTING_KEYS.displayName]
  if (displayName !== undefined) patch.displayName = displayName
  const enabled = rows[APP_SETTING_KEYS.multiAgentEnabled]
  if (enabled !== undefined) patch.multiAgentEnabled = enabled === 'true'
  const maxSubAgents = rows[APP_SETTING_KEYS.multiAgentMaxSubAgents]
  if (maxSubAgents !== undefined) patch.multiAgentMaxSubAgents = Number(maxSubAgents)
  return mergeSettings(DEFAULT_SETTINGS, sanitizeSettings(patch))
}

async function readLegacyFile(): Promise<unknown> {
  const file = paths.settingsFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown
  } catch (error) {
    log.error('Failed to read settings, falling back to defaults', error)
    return null
  }
}

async function loadFromDatabase(): Promise<AppSettings> {
  if (!settingsRepository.isSeeded(APP_SETTINGS_SCOPE)) {
    const legacy = await readLegacyFile()
    const seeded = mergeSettings(DEFAULT_SETTINGS, sanitizeSettings(legacy))
    settingsRepository.seed(APP_SETTINGS_SCOPE, serialize(seeded))
  }
  return deserialize(settingsRepository.list(APP_SETTINGS_SCOPE))
}

async function load(): Promise<AppSettings> {
  if (cache) return cache

  if (isDatabaseOpen()) {
    cache = await loadFromDatabase()
    return cache
  }

  const file = paths.settingsFile()
  if (!existsSync(file)) {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'))
    cache = mergeSettings(DEFAULT_SETTINGS, sanitizeSettings(parsed))
  } catch (error) {
    log.error('Failed to read settings, falling back to defaults', error)
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export const settingsService = {
  get: load,

  async set(patch: ReturnType<typeof sanitizeSettings>): Promise<AppSettings> {
    const next = mergeSettings(await load(), patch)
    // Persist first: a failed write must not leave the live cache ahead of the stored settings.
    if (isDatabaseOpen()) {
      settingsRepository.setMany(APP_SETTINGS_SCOPE, serialize(next))
    } else {
      await writeFile(paths.settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
    }
    cache = next
    return next
  }
}
