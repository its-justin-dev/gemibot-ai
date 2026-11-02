export interface RuntimeVersions {
  electron: string
  chrome: string
  node: string
}

export interface PlatformInfo {
  platform: string
  arch: string
  locale: string
  isPackaged: boolean
  versions: RuntimeVersions
}
