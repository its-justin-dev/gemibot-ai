import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TOKEN_SETTINGS,
  normalizeTokenSettings,
  parseTokenCommand,
  tokenSettingsFromDict,
  tokenSettingsToDict
} from '../../src/shared/utils/token-settings'

describe('token settings', () => {
  it('keeps safe defaults until a value is persisted', () => {
    expect(tokenSettingsFromDict({})).toEqual(DEFAULT_TOKEN_SETTINGS)
    expect(tokenSettingsFromDict({ model: 'gemini-3.5-flash' })).toEqual(
      DEFAULT_TOKEN_SETTINGS
    )
  })

  it('round-trips every persisted key', () => {
    const settings = normalizeTokenSettings({
      maxMemoryChars: 8_000,
      memoryRelevance: false,
      slimTools: false,
      maxToolOutputChars: 6_000,
      reuseReadResults: false,
      loopGuard: false,
      maxOutputTokens: 2_048,
      cheapModel: 'gemini-3.1-flash-lite'
    })
    expect(tokenSettingsFromDict(tokenSettingsToDict(settings))).toEqual(settings)
  })

  it('clamps sizes, keeps 0 as no cap and leaves output 0 as provider default', () => {
    const clamped = normalizeTokenSettings({
      maxMemoryChars: 999_999,
      maxToolOutputChars: 1,
      maxOutputTokens: 1
    })
    expect(clamped.maxMemoryChars).toBe(60_000)
    expect(clamped.maxToolOutputChars).toBe(1_000)
    expect(clamped.maxOutputTokens).toBe(256)

    const uncapped = normalizeTokenSettings({
      maxMemoryChars: 0,
      maxToolOutputChars: 0,
      maxOutputTokens: 0
    })
    expect(uncapped.maxMemoryChars).toBe(0)
    expect(uncapped.maxToolOutputChars).toBe(0)
    expect(uncapped.maxOutputTokens).toBe(0)
  })
})

describe('parseTokenCommand', () => {
  it('shows the view with no arguments', () => {
    expect(parseTokenCommand('').kind).toBe('view')
    expect(parseTokenCommand('show').kind).toBe('view')
  })

  it('parses sizes, toggles and model ids', () => {
    expect(parseTokenCommand('memory 9000').updates).toEqual({ maxMemoryChars: 9_000 })
    expect(parseTokenCommand('tools 5000').updates).toEqual({ maxToolOutputChars: 5_000 })
    expect(parseTokenCommand('output 1024').updates).toEqual({ maxOutputTokens: 1_024 })
    expect(parseTokenCommand('relevance off').updates).toEqual({ memoryRelevance: false })
    expect(parseTokenCommand('slim off').updates).toEqual({ slimTools: false })
    expect(parseTokenCommand('cache off').updates).toEqual({ reuseReadResults: false })
    expect(parseTokenCommand('loop off').updates).toEqual({ loopGuard: false })
    expect(parseTokenCommand('cheap gemini-2.5-flash').updates).toEqual({
      cheapModel: 'gemini-2.5-flash'
    })
  })

  it('routes compaction settings through the compactor', () => {
    expect(parseTokenCommand('summarizer gemini-3.1-flash-lite').compaction).toEqual({
      summarizerModel: 'gemini-3.1-flash-lite'
    })
    expect(parseTokenCommand('threshold 120').compaction).toEqual({ thresholdPercent: 95 })
    expect(parseTokenCommand('threshold 10').compaction).toEqual({ thresholdPercent: 50 })
  })

  it('rejects unknown or incomplete commands', () => {
    expect(parseTokenCommand('memory').kind).toBe('error')
    expect(parseTokenCommand('slim maybe').kind).toBe('error')
    expect(parseTokenCommand('cheap').kind).toBe('error')
    expect(parseTokenCommand('nonsense').kind).toBe('error')
  })

  it('resets to the documented defaults', () => {
    const parsed = parseTokenCommand('reset')
    expect(parsed.kind).toBe('update')
    expect(parsed.updates).toEqual(DEFAULT_TOKEN_SETTINGS)
  })
})
