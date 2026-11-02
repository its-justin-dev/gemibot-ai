export function pyRepr(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  return `${quote}${escaped.replaceAll(quote, `\\${quote}`)}${quote}`
}

export function pyListRepr(values: readonly string[]): string {
  return `[${values.map(pyRepr).join(', ')}]`
}

export function pyReprValue(value: unknown): string {
  if (typeof value === 'string') return pyRepr(value)
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value instanceof Uint8Array) return pyBytesRepr(value)
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(pyReprValue).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{${entries.map(([key, item]) => `${pyRepr(key)}: ${pyReprValue(item)}`).join(', ')}}`
}

export function pyBytesRepr(value: Uint8Array): string {
  const quote = value.includes(0x27) && !value.includes(0x22) ? '"' : "'"
  let out = ''
  for (const byte of value) {
    if (byte === 0x5c) out += '\\\\'
    else if (byte === quote.charCodeAt(0)) out += `\\${quote}`
    else if (byte === 0x0a) out += '\\n'
    else if (byte === 0x0d) out += '\\r'
    else if (byte === 0x09) out += '\\t'
    else if (byte < 0x20 || byte >= 0x7f) out += `\\x${byte.toString(16).padStart(2, '0')}`
    else out += String.fromCharCode(byte)
  }
  return `b${quote}${out}${quote}`
}
