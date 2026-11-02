export interface MainConfig {
  appEnv: string
  apiBaseUrl: string
  hasApiKey: boolean
}

export interface EnvSource {
  MAIN_VITE_APP_ENV?: string
  MAIN_VITE_API_BASE_URL?: string
  GEMIBOT_API_KEY?: string
}
