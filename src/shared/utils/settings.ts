import type { AppSettings, SettingsPatch } from '../types/settings'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  displayName: 'Gemibot',
  multiAgentEnabled: false,
  multiAgentMaxSubAgents: 4
}

const THEMES: readonly AppSettings['theme'][] = ['light', 'dark']
const MAX_NAME_LENGTH = 40

export function sanitizeSettings(patch: unknown): SettingsPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return {}

  const source = patch as Record<string, unknown>
  const result: SettingsPatch = {}

  if (typeof source.theme === 'string' && THEMES.includes(source.theme as AppSettings['theme'])) {
    result.theme = source.theme as AppSettings['theme']
  }

  if (typeof source.displayName === 'string') {
    const name = source.displayName.trim().slice(0, MAX_NAME_LENGTH)
    if (name.length > 0) result.displayName = name
  }

  if (typeof source.multiAgentEnabled === 'boolean') {
    result.multiAgentEnabled = source.multiAgentEnabled
  }

  if (typeof source.multiAgentMaxSubAgents === 'number') {
    const max = Math.max(2, Math.min(6, source.multiAgentMaxSubAgents))
    result.multiAgentMaxSubAgents = max
  }

  return result
}

export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  return { ...current, ...patch }
}
