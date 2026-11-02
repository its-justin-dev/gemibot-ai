import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, sanitizeSettings } from '../../src/shared/utils/settings'

describe('sanitizeSettings', () => {
  it('drops unknown keys and non-objects', () => {
    expect(sanitizeSettings(null)).toEqual({})
    expect(sanitizeSettings('nope')).toEqual({})
    expect(sanitizeSettings({ theme: 'dark', evil: 1 })).toEqual({ theme: 'dark' })
  })

  it('rejects themes outside the allowed set', () => {
    expect(sanitizeSettings({ theme: 'neon' })).toEqual({})
  })

  it('trims and caps the display name', () => {
    expect(sanitizeSettings({ displayName: '  Gemibot  ' })).toEqual({ displayName: 'Gemibot' })
    expect(sanitizeSettings({ displayName: 'x'.repeat(80) })).toEqual({
      displayName: 'x'.repeat(40)
    })
    expect(sanitizeSettings({ displayName: '   ' })).toEqual({})
  })
})

describe('mergeSettings', () => {
  it('applies a patch over the current settings', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { theme: 'dark' })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark'
    })
  })
})
