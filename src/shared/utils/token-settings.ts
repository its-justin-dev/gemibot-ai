import type { TokenSettings } from '../types/token-settings'
import { pyFormatThousands } from './pyformat'

export const DEFAULT_TOKEN_SETTINGS: TokenSettings = {
  maxMemoryChars: 12_000,
  memoryRelevance: true,
  slimTools: true,
  maxToolOutputChars: 12_000,
  reuseReadResults: true,
  loopGuard: true,
  maxOutputTokens: 0,
  cheapModel: 'gemini-3.1-flash-lite'
}

/** 0 means "no app-level cap"; any other value is kept inside a safe range. */
function sizeValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded <= 0) return 0
  return Math.max(min, Math.min(max, rounded))
}

function outputValue(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded <= 0) return 0
  return Math.max(256, Math.min(32_768, rounded))
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(clean)) return true
    if (['0', 'false', 'off', 'no'].includes(clean)) return false
  }
  return fallback
}

function modelValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.trim()
  return clean === '' ? fallback : clean
}

export function normalizeTokenSettings(value: Partial<TokenSettings>): TokenSettings {
  return {
    maxMemoryChars: sizeValue(
      value.maxMemoryChars,
      DEFAULT_TOKEN_SETTINGS.maxMemoryChars,
      2_000,
      60_000
    ),
    memoryRelevance: boolValue(
      value.memoryRelevance,
      DEFAULT_TOKEN_SETTINGS.memoryRelevance
    ),
    slimTools: boolValue(value.slimTools, DEFAULT_TOKEN_SETTINGS.slimTools),
    maxToolOutputChars: sizeValue(
      value.maxToolOutputChars,
      DEFAULT_TOKEN_SETTINGS.maxToolOutputChars,
      1_000,
      60_000
    ),
    reuseReadResults: boolValue(
      value.reuseReadResults,
      DEFAULT_TOKEN_SETTINGS.reuseReadResults
    ),
    loopGuard: boolValue(value.loopGuard, DEFAULT_TOKEN_SETTINGS.loopGuard),
    maxOutputTokens: outputValue(
      value.maxOutputTokens,
      DEFAULT_TOKEN_SETTINGS.maxOutputTokens
    ),
    cheapModel: modelValue(value.cheapModel, DEFAULT_TOKEN_SETTINGS.cheapModel)
  }
}

/** Reads the persisted `token_*` keys; a missing key keeps the safe default. */
export function tokenSettingsFromDict(settings: Record<string, string>): TokenSettings {
  const has = (key: string): boolean => settings[key] !== undefined
  return normalizeTokenSettings({
    maxMemoryChars: has('token_memory_chars')
      ? Number(settings['token_memory_chars'])
      : DEFAULT_TOKEN_SETTINGS.maxMemoryChars,
    memoryRelevance: has('token_memory_relevance')
      ? settings['token_memory_relevance'] === 'true'
      : DEFAULT_TOKEN_SETTINGS.memoryRelevance,
    slimTools: has('token_slim_tools')
      ? settings['token_slim_tools'] === 'true'
      : DEFAULT_TOKEN_SETTINGS.slimTools,
    maxToolOutputChars: has('token_tool_output_chars')
      ? Number(settings['token_tool_output_chars'])
      : DEFAULT_TOKEN_SETTINGS.maxToolOutputChars,
    reuseReadResults: has('token_reuse_reads')
      ? settings['token_reuse_reads'] === 'true'
      : DEFAULT_TOKEN_SETTINGS.reuseReadResults,
    loopGuard: has('token_loop_guard')
      ? settings['token_loop_guard'] === 'true'
      : DEFAULT_TOKEN_SETTINGS.loopGuard,
    maxOutputTokens: has('token_max_output_tokens')
      ? Number(settings['token_max_output_tokens'])
      : DEFAULT_TOKEN_SETTINGS.maxOutputTokens,
    cheapModel: has('token_cheap_model')
      ? settings['token_cheap_model']
      : DEFAULT_TOKEN_SETTINGS.cheapModel
  })
}

/** Serializes every key; callers only reach this after an explicit user change. */
export function tokenSettingsToDict(settings: TokenSettings): Record<string, string> {
  return {
    token_memory_chars: String(settings.maxMemoryChars),
    token_memory_relevance: settings.memoryRelevance ? 'true' : 'false',
    token_slim_tools: settings.slimTools ? 'true' : 'false',
    token_tool_output_chars: String(settings.maxToolOutputChars),
    token_reuse_reads: settings.reuseReadResults ? 'true' : 'false',
    token_loop_guard: settings.loopGuard ? 'true' : 'false',
    token_max_output_tokens: String(settings.maxOutputTokens),
    token_cheap_model: settings.cheapModel
  }
}

export const TOKEN_COMMAND_USAGE =
  '/token memory <chars> | tools <chars> | relevance on|off | slim on|off | ' +
  'cache on|off | loop on|off | output <tokens> | cheap <model> | ' +
  'summarizer <model> | threshold <50-95> | reset'

export interface TokenCommandParse {
  kind: 'view' | 'update' | 'error'
  message: string
  updates?: Partial<TokenSettings>
  compaction?: { thresholdPercent?: number; summarizerModel?: string }
}

function parseToggle(
  key: string,
  value: string
): { value?: boolean; error?: string } {
  const clean = value.trim().toLowerCase()
  if (['on', 'true', '1'].includes(clean)) return { value: true }
  if (['off', 'false', '0'].includes(clean)) return { value: false }
  return { error: `/token ${key} needs on or off.` }
}

function parseSize(
  key: string,
  value: string,
  min: number,
  max: number
): { value: number; error?: string } {
  if (value.trim() === '') return { value: 0, error: `/token ${key} needs a number.` }
  const number = Number(value)
  if (!Number.isFinite(number)) return { value: 0, error: `/token ${key} needs a number.` }
  const rounded = Math.round(number)
  return { value: rounded <= 0 ? 0 : Math.max(min, Math.min(max, rounded)) }
}

export function parseTokenCommand(arg: string): TokenCommandParse {
  const fields = arg
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
  if (fields.length === 0 || fields[0].toLowerCase() === 'show') {
    return { kind: 'view', message: '' }
  }
  const key = fields[0].toLowerCase()
  const value = fields.slice(1).join(' ').trim()

  if (key === 'reset') {
    return {
      kind: 'update',
      message: 'Token settings reset to safe defaults.',
      updates: { ...DEFAULT_TOKEN_SETTINGS }
    }
  }

  if (key === 'memory') {
    const parsed = parseSize('memory', value, 2_000, 60_000)
    if (parsed.error !== undefined) return { kind: 'error', message: parsed.error }
    return {
      kind: 'update',
      message:
        parsed.value === 0
          ? 'Memory budget cap disabled.'
          : `Memory budget set to ${pyFormatThousands(parsed.value)} characters.`,
      updates: { maxMemoryChars: parsed.value }
    }
  }

  if (key === 'tools') {
    const parsed = parseSize('tools', value, 1_000, 60_000)
    if (parsed.error !== undefined) return { kind: 'error', message: parsed.error }
    return {
      kind: 'update',
      message:
        parsed.value === 0
          ? 'Tool output cap disabled.'
          : `Tool output limit set to ${pyFormatThousands(parsed.value)} characters.`,
      updates: { maxToolOutputChars: parsed.value }
    }
  }

  if (key === 'output') {
    const parsed = parseSize('output', value, 256, 32_768)
    if (parsed.error !== undefined) return { kind: 'error', message: parsed.error }
    return {
      kind: 'update',
      message:
        parsed.value === 0
          ? 'Output limit set to the provider default.'
          : `Output limit set to ${pyFormatThousands(parsed.value)} tokens.`,
      updates: { maxOutputTokens: parsed.value }
    }
  }

  if (key === 'relevance' || key === 'slim' || key === 'cache' || key === 'loop') {
    const toggle = parseToggle(key, value)
    if (toggle.error !== undefined) return { kind: 'error', message: toggle.error }
    if (key === 'relevance') {
      return {
        kind: 'update',
        message: `Relevance-based memory selection ${toggle.value ? 'enabled' : 'disabled'}.`,
        updates: { memoryRelevance: toggle.value }
      }
    }
    if (key === 'slim') {
      return {
        kind: 'update',
        message: `Slim tool schemas ${toggle.value ? 'enabled' : 'disabled'}.`,
        updates: { slimTools: toggle.value }
      }
    }
    if (key === 'cache') {
      return {
        kind: 'update',
        message: `Repeated read-result reuse ${toggle.value ? 'enabled' : 'disabled'}.`,
        updates: { reuseReadResults: toggle.value }
      }
    }
    return {
      kind: 'update',
      message: `Repeated-call loop guard ${toggle.value ? 'enabled' : 'disabled'}.`,
      updates: { loopGuard: toggle.value }
    }
  }

  if (key === 'cheap') {
    if (value === '' || /\s/.test(value)) {
      return { kind: 'error', message: '/token cheap needs one model id.' }
    }
    return {
      kind: 'update',
      message: `Small-job model set to ${value}.`,
      updates: { cheapModel: value }
    }
  }

  if (key === 'summarizer') {
    if (value === '' || /\s/.test(value)) {
      return { kind: 'error', message: '/token summarizer needs one model id.' }
    }
    return {
      kind: 'update',
      message: `Compaction summarizer set to ${value}.`,
      compaction: { summarizerModel: value }
    }
  }

  if (key === 'threshold') {
    const number = Number(value)
    if (value === '' || !Number.isFinite(number)) {
      return { kind: 'error', message: '/token threshold needs a number.' }
    }
    const percent = Math.max(50, Math.min(95, Math.round(number)))
    return {
      kind: 'update',
      message: `Auto-compaction threshold set to ${percent}%.`,
      compaction: { thresholdPercent: percent }
    }
  }

  if (key === 'target') {
    return {
      kind: 'error',
      message: 'Use /compaction target <10-80> to change the post-compaction target.'
    }
  }

  return {
    kind: 'error',
    message: `Unknown token setting '${key}'. Use: ${TOKEN_COMMAND_USAGE}`
  }
}
