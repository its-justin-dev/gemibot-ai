const ALWAYS_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~'
const encoder = new TextEncoder()

export function pyQuote(string: string, safe = '/'): string {
  if (string === '') return string
  let out = ''
  for (const ch of string) {
    if (ALWAYS_SAFE.includes(ch) || safe.includes(ch)) {
      out += ch
      continue
    }
    for (const byte of encoder.encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}
