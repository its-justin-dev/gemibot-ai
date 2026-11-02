import { basename, dirname } from 'path'
import { memoryRepository, settingsRepository, storageKey } from './long-term-repository.service'

/** Projects nested in these folders shared the parent project's memory in the file-based app. */
const WRAPPER_DIR_NAMES = ['chatbot', 'gemibot-cli', 'gemibot']

function candidateRoots(appRoot: string): string[] {
  const root = storageKey(appRoot)
  const roots = [root]
  if (WRAPPER_DIR_NAMES.includes(basename(root).toLowerCase())) {
    const parent = storageKey(dirname(root))
    if (parent !== root) roots.push(parent)
  }
  return roots
}

export function memoryKeyCandidates(appRoot: string): string[] {
  return candidateRoots(appRoot).map((root) => `memory:${root}`)
}

export function settingsScopeCandidates(appRoot: string): string[] {
  return candidateRoots(appRoot).map((root) => `settings:${root}`)
}

/** Keeps the rows a project already has, then falls back to its own root. */
export function resolveMemoryKey(appRoot: string): string {
  const keys = memoryKeyCandidates(appRoot)
  try {
    return memoryRepository.newestExistingKey(keys) ?? keys[0]
  } catch {
    return keys[0]
  }
}

/** Keeps the rows a project already has, then falls back to its own root. */
export function resolveSettingsScope(appRoot: string): string {
  const scopes = settingsScopeCandidates(appRoot)
  try {
    return settingsRepository.newestExistingScope(scopes) ?? scopes[0]
  } catch {
    return scopes[0]
  }
}
