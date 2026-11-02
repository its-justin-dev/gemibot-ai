import { describe, expect, it } from 'vitest'

import {
  GEMINI_KEY_PREFIX,
  apiKeyProblem,
  cleanApiKey,
  maskApiKey
} from '../../src/shared/utils/api-key'
import { applyEnvValues } from '../../src/shared/utils/env-file'

/** Shaped exactly like a real Google Gemini key, but not one. */
const KEY = `${GEMINI_KEY_PREFIX}TestKeyValue0000000000000000000000000000`

const ENV = [
  '# Copy to .env and fill in.',
  'MAIN_VITE_APP_ENV=development',
  'GEMINI_API_KEY=old-gemini-key',
  '',
  '# Scaffold-only key.',
  'GEMIBOT_API_KEY=old-gemibot-key',
  '#GEMINI_API_KEY=commented-out',
  'UNRELATED="kept as is"'
].join('\n')

const WRITE = { GEMINI_API_KEY: 'new-key-1234567890', GEMIBOT_API_KEY: 'new-key-1234567890' }

describe('applyEnvValues', () => {
  it('replaces both keys where they already sit and touches nothing else', () => {
    expect(applyEnvValues(ENV, WRITE).split('\n')).toEqual([
      '# Copy to .env and fill in.',
      'MAIN_VITE_APP_ENV=development',
      'GEMINI_API_KEY=new-key-1234567890',
      '',
      '# Scaffold-only key.',
      'GEMIBOT_API_KEY=new-key-1234567890',
      '#GEMINI_API_KEY=commented-out',
      'UNRELATED="kept as is"'
    ])
  })

  it('ignores lines that only look like the key', () => {
    const text = 'GEMINI_API_KEY_2=other\nMY_GEMINI_API_KEY=other\n'
    expect(applyEnvValues(text, { GEMINI_API_KEY: 'new-key-1234567890' })).toBe(
      `${text}GEMINI_API_KEY=new-key-1234567890\n`
    )
  })

  it('appends a missing key and closes the file with one newline', () => {
    expect(applyEnvValues('A=1', { GEMINI_API_KEY: 'key-1234567890ab' })).toBe(
      'A=1\nGEMINI_API_KEY=key-1234567890ab\n'
    )
    expect(applyEnvValues('', { GEMINI_API_KEY: 'key-1234567890ab' })).toBe(
      'GEMINI_API_KEY=key-1234567890ab\n'
    )
  })

  it('rewrites quoted, spaced and export-prefixed rows without losing their shape', () => {
    expect(applyEnvValues('export GEMINI_API_KEY = "quoted"\n', WRITE)).toBe(
      'export GEMINI_API_KEY =new-key-1234567890\nGEMIBOT_API_KEY=new-key-1234567890\n'
    )
  })

  it('applying the same values twice changes nothing', () => {
    const once = applyEnvValues(ENV, WRITE)
    expect(applyEnvValues(once, WRITE)).toBe(once)
  })
})

describe('cleanApiKey', () => {
  it('drops the padding and quotes people paste along with the key', () => {
    expect(cleanApiKey(`  "${KEY}"\n`)).toBe(KEY)
    expect(cleanApiKey(` '${KEY}' `)).toBe(KEY)
  })
})

describe('apiKeyProblem', () => {
  it('rejects anything that cannot survive a dotenv round trip', () => {
    expect(apiKeyProblem('')).toBe('API key cannot be empty.')
    expect(apiKeyProblem(`${GEMINI_KEY_PREFIX}a b`)).toBe(
      'API key cannot contain spaces or line breaks.'
    )
    expect(apiKeyProblem(`${GEMINI_KEY_PREFIX}line\nbreak`)).toBe(
      'API key cannot contain spaces or line breaks.'
    )
    expect(apiKeyProblem(KEY)).toBeNull()
  })

  it('accepts keys shaped like the ones Google issues', () => {
    for (const sample of [
      'AQ.Ab8RN6IpfdFYvbXvLgTDEsOLNSEHCOkn11c-not-a-real-key',
      `${GEMINI_KEY_PREFIX}JbiTWqsaVpgsfbWzSVZN-GxHHZ94UTA5Nr8`,
      `${GEMINI_KEY_PREFIX}x`
    ]) {
      expect(apiKeyProblem(sample)).toBeNull()
    }
  })

  it('rejects a key that is not in the Gemini format', () => {
    expect(apiKeyProblem('AIzaSyDummyDummyDummy')).toBe(
      `That is not a Google Gemini API key - Gemini keys start with ${GEMINI_KEY_PREFIX}.`
    )
    expect(apiKeyProblem('SK-alreadyhaveone')).toBe(
      `That is not a Google Gemini API key - Gemini keys start with ${GEMINI_KEY_PREFIX}.`
    )
    expect(apiKeyProblem('aq.ab8rn6LowercasedDoesNotCount')).toBe(
      `That is not a Google Gemini API key - Gemini keys start with ${GEMINI_KEY_PREFIX}.`
    )
  })

  it('rejects a prefix with nothing after it', () => {
    expect(apiKeyProblem(GEMINI_KEY_PREFIX)).toMatch(/too short/u)
    expect(apiKeyProblem(`${GEMINI_KEY_PREFIX}x`)).toBeNull()
  })
})

describe('maskApiKey', () => {
  it('keeps both ends and hides everything between them', () => {
    const masked = maskApiKey(KEY)
    expect(masked.slice(0, 4)).toBe('AQ.A')
    expect(masked.slice(-4)).toBe(KEY.slice(-4))
    expect(masked.slice(4, -4)).toBe('*'.repeat(masked.length - 8))
    expect(masked).not.toBe(KEY)
  })

  it('caps the dots for a long key', () => {
    expect(maskApiKey('A'.repeat(80))).toBe(`AAAA${'*'.repeat(24)}AAAA`)
  })

  it('fully hides a short key', () => {
    expect(maskApiKey('12345678')).toBe('*'.repeat(8))
    expect(maskApiKey('')).toBe('')
  })
})
