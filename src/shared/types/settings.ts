export interface AppSettings {
  theme: 'light' | 'dark'
  displayName: string
  multiAgentEnabled: boolean
  multiAgentMaxSubAgents: number
}

export type SettingsPatch = Partial<AppSettings>
