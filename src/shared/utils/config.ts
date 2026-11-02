import type { EnvSource, MainConfig } from '../types/config'

export const FALLBACK_API_BASE_URL = 'http://localhost:8787'

const trimmed = (value: string | undefined): string => value?.trim() ?? ''

export function buildMainConfig(source: EnvSource): MainConfig {
  return {
    appEnv: trimmed(source.MAIN_VITE_APP_ENV) || 'development',
    apiBaseUrl: trimmed(source.MAIN_VITE_API_BASE_URL) || FALLBACK_API_BASE_URL,
    hasApiKey: trimmed(source.GEMIBOT_API_KEY).length > 0
  }
}
