import { describe, expect, it } from 'vitest'
import { FALLBACK_API_BASE_URL, buildMainConfig } from '../../src/shared/utils/config'

describe('buildMainConfig', () => {
  it('falls back when nothing is configured', () => {
    expect(buildMainConfig({})).toEqual({
      appEnv: 'development',
      apiBaseUrl: FALLBACK_API_BASE_URL,
      hasApiKey: false
    })
  })

  it('treats blank values as missing', () => {
    expect(buildMainConfig({ MAIN_VITE_APP_ENV: '  ', MAIN_VITE_API_BASE_URL: '' })).toEqual({
      appEnv: 'development',
      apiBaseUrl: FALLBACK_API_BASE_URL,
      hasApiKey: false
    })
  })

  it('reports a key without carrying the value', () => {
    const config = buildMainConfig({ GEMIBOT_API_KEY: ' super-secret ' })
    expect(config.hasApiKey).toBe(true)
    expect(JSON.stringify(config)).not.toContain('super-secret')
  })
})
