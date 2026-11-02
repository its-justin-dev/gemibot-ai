import { resolveSettingsScope } from './app-storage-keys.service'
import { settingsRepository } from './long-term-repository.service'

export interface SettingsStorageInfo {
  scope: string
}

/** Settings buffered while SQLite is unavailable, flushed on the next successful read. */
const pending = new Map<string, Record<string, string>>()

function remember(scope: string, entries: Record<string, string>): void {
  pending.set(scope, { ...(pending.get(scope) ?? {}), ...entries })
}

export function settingsScope(appRoot: string): string {
  return resolveSettingsScope(appRoot)
}

/** Seeds defaults plus any buffered values, then returns the live rows. */
export function ensureDatabaseSettings(
  appRoot: string,
  defaults: Record<string, string>
): Record<string, string> {
  const scope = settingsScope(appRoot)
  const buffered = pending.get(scope)
  try {
    if (!settingsRepository.isSeeded(scope)) {
      settingsRepository.seed(scope, { ...defaults, ...buffered })
    } else if (buffered) {
      settingsRepository.setMany(scope, buffered)
    }
    pending.delete(scope)
    return settingsRepository.list(scope)
  } catch {
    remember(scope, defaults)
    return { ...defaults, ...(pending.get(scope) ?? {}) }
  }
}

export function readDatabaseSettings(appRoot: string): Record<string, string> {
  const scope = settingsScope(appRoot)
  try {
    const rows = settingsRepository.list(scope)
    const buffered = pending.get(scope)
    if (!buffered) return rows
    settingsRepository.setMany(scope, buffered)
    pending.delete(scope)
    return { ...rows, ...buffered }
  } catch {
    return { ...(pending.get(scope) ?? {}) }
  }
}

export function saveDatabaseSettings(appRoot: string, updates: Record<string, string>): void {
  const scope = settingsScope(appRoot)
  const merged = { ...(pending.get(scope) ?? {}), ...updates }
  try {
    settingsRepository.setMany(scope, merged)
    pending.delete(scope)
  } catch {
    remember(scope, updates)
  }
}
