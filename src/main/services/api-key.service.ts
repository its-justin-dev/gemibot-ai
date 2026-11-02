import { existsSync } from 'fs'
import { chmod, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { app } from 'electron'
import { API_KEY_VARS, apiKeyProblem, cleanApiKey, maskApiKey } from '../../shared/utils/api-key'
import { applyEnvValues } from '../../shared/utils/env-file'
import type { ApiKeyInfo, ApiKeyResult } from '../../shared/types/api-key'
import { errorMessage } from '../../shared/utils/exceptions'
import { readText, writeText } from '../utils/fs-text'
import { loadedEnvFile, resolveApiKey } from '../utils/load-env'

/**
 * The file the engine already reads its key from. A packaged app cannot write inside the
 * asar, so a fresh install falls back to the userData copy that `loadDotenv` also reads.
 */
export function apiKeyFile(): string {
  const loaded = loadedEnvFile()
  if (loaded !== null) return loaded
  const inApp = join(app.getAppPath(), '.env')
  return existsSync(inApp) ? inApp : join(app.getPath('userData'), '.env')
}

export function apiKeyInfo(): ApiKeyInfo {
  const key = resolveApiKey()
  return { key, masked: maskApiKey(key), file: apiKeyFile(), vars: [...API_KEY_VARS] }
}

/**
 * Persist the key and hand it back trimmed, so the caller can point the live client at exactly
 * what was written. `process.loadEnvFile` never overrides a variable that is already set, so
 * the in-memory value is what keeps this session working; the file is what survives a restart.
 */
export async function saveApiKey(raw: string): Promise<ApiKeyResult> {
  const key = cleanApiKey(raw)
  const problem = apiKeyProblem(key)
  if (problem !== null) return { ok: false, message: problem }

  const file = apiKeyFile()
  try {
    const source = existsSync(file) ? await readText(file) : null
    if (source === null) await mkdir(dirname(file), { recursive: true })
    const next = applyEnvValues(
      source?.text ?? '',
      Object.fromEntries(API_KEY_VARS.map((name) => [name, key]))
    )
    await writeText(file, next, source?.crlf ?? process.platform === 'win32')
    if (process.platform !== 'win32') {
      // The file holds a plain-text secret; keep it private even if it existed with wider bits.
      await chmod(file, 0o600).catch(() => {})
    }
  } catch (e) {
    return { ok: false, message: `Could not write ${file}: ${errorMessage(e)}` }
  }

  for (const name of API_KEY_VARS) process.env[name] = key
  return { ok: true, message: `Saved to ${file}` }
}
