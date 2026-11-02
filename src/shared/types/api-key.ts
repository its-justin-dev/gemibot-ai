export interface ApiKeyInfo {
  /** The key the app is using right now - shown in the dialog so the user can edit it. */
  key: string
  masked: string
  file: string
  vars: string[]
}

export interface ApiKeyResult {
  ok: boolean
  message: string
}
