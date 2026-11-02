import { existsSync } from 'fs'
import { join } from 'path'
import { AppConstants } from '../../shared/constants/app-constants'

let loaded = false
let envFile: string | null = null

export function loadDotenv(candidates: string[]): void {
  if (loaded) return
  loaded = true
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      process.loadEnvFile(file)
      envFile = file
      return
    } catch {
      // A malformed .env must not abort startup; the next candidate or the in-app dialog still
      // provides a key.
    }
  }
}

export function loadedEnvFile(): string | null {
  return envFile
}

export function resolveApiKey(): string {
  return (
    AppConstants.API_KEY || process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'] || ''
  )
}

export function resolveEnvApiKey(): string {
  return process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'] || ''
}

export function envCandidates(appPath: string, userData: string): string[] {
  return [join(appPath, '.env'), join(userData, '.env')]
}
