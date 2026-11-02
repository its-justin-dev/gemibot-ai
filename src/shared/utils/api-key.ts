export const API_KEY_VARS = ['GEMINI_API_KEY', 'GEMIBOT_API_KEY'] as const

/** Google issues every Gemini API key under this prefix, so anything else is not a Gemini key. */
export const GEMINI_KEY_PREFIX = 'AQ.Ab8RN6'

/** Trim, drop stray quotes the user pasted with, and reject anything that cannot sit in .env. */
export function cleanApiKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/gu, '')
    .trim()
}

export function apiKeyProblem(key: string): string | null {
  if (key === '') return 'API key cannot be empty.'
  if (/[\s\0]/u.test(key)) return 'API key cannot contain spaces or line breaks.'
  if (!key.startsWith(GEMINI_KEY_PREFIX)) {
    return `That is not a Google Gemini API key - Gemini keys start with ${GEMINI_KEY_PREFIX}.`
  }
  if (key.length <= GEMINI_KEY_PREFIX.length) {
    return 'API key looks too short - check that you pasted the whole key.'
  }
  return null
}

/** Keep 4 characters on each end so the user can recognise the key without reading it. */
export function maskApiKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return `${key.slice(0, 4)}${'*'.repeat(Math.min(24, key.length - 8))}${key.slice(-4)}`
}
