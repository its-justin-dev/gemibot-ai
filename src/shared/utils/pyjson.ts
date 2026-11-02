export class PyFloat {
  constructor(readonly value: number) {}
}

export interface PyJsonObject {
  [key: string]: PyJsonValue | undefined
}

export type PyJsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | PyFloat
  | PyJsonValue[]
  | PyJsonObject
  | Map<string, PyJsonValue>

interface WriterOptions {
  ensureAscii: boolean
  itemSeparator: string
  keySeparator: string
  indent: number | null
}

export interface DumpsOptions {
  ensureAscii?: boolean
  indent?: number | null
}

export function pyJsonDumps(value: unknown, options: DumpsOptions = {}): string {
  const indent = options.indent ?? null
  const ensureAscii = options.ensureAscii ?? true
  return writeValue(
    value,
    {
      ensureAscii,
      itemSeparator: indent === null ? ', ' : ',',
      keySeparator: ': ',
      indent
    },
    0
  )
}

export function pydanticJsonDumps(value: unknown): string {
  return writeValue(
    value,
    { ensureAscii: false, itemSeparator: ',', keySeparator: ':', indent: null },
    0
  )
}

export function pyJsonLoads(text: string): unknown {
  const floats = new Map<string, number>()
  let count = 0
  const marked = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    if (token.startsWith('"') || !/[.eE]/.test(token)) return token
    const key = `\u0000${count++}`
    floats.set(key, Number(token))
    return JSON.stringify(key)
  })
  return JSON.parse(marked, (_key, value: unknown) =>
    typeof value === 'string' && floats.has(value)
      ? new PyFloat(floats.get(value) as number)
      : value
  )
}

const SHORT_STRING_ESCAPES = new Map<number, string>([
  [8, '\\b'],
  [9, '\\t'],
  [10, '\\n'],
  [12, '\\f'],
  [13, '\\r']
])

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`
}

export function pyJsonEscapeString(value: string, ensureAscii: boolean): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x22) out += '\\"'
    else if (code === 0x5c) out += '\\\\'
    else if (code < 0x20) out += SHORT_STRING_ESCAPES.get(code) ?? hex4(code)
    else if (ensureAscii && (code < 0x20 || code > 0x7e)) out += hex4(code)
    else out += value[i]
  }
  return `${out}"`
}

export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  const negative = value < 0 || Object.is(value, -0)
  const digits = digitsAndPoint(negative ? -value : value)
  const body = formatDigits(digits.digits, digits.decpt)
  return negative ? `-${body}` : body
}

function digitsAndPoint(value: number): { digits: string; decpt: number } {
  const text = value.toString()
  const expAt = text.indexOf('e')
  const mantissa = expAt >= 0 ? text.slice(0, expAt) : text
  const exponent = expAt >= 0 ? Number.parseInt(text.slice(expAt + 1), 10) : 0
  const dotAt = mantissa.indexOf('.')
  const intPart = dotAt >= 0 ? mantissa.slice(0, dotAt) : mantissa
  const fracPart = dotAt >= 0 ? mantissa.slice(dotAt + 1) : ''
  let digits = `${intPart}${fracPart}`
  let decpt = exponent + intPart.length
  const leading = digits.length - digits.replace(/^0+/, '').length
  digits = digits.slice(leading).replace(/0+$/, '')
  decpt -= leading
  if (digits === '') return { digits: '0', decpt: 1 }
  return { digits, decpt }
}

function formatDigits(digits: string, decpt: number): string {
  if (digits === '0') return '0.0'
  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0]
    const sign = exp < 0 ? '-' : '+'
    return `${mantissa}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  if (decpt <= 0) return `0.${'0'.repeat(-decpt)}${digits}`
  if (decpt >= digits.length) return `${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'
  }
  if (Number.isInteger(value)) return String(value)
  return pyFloatRepr(value)
}

function unsupported(value: unknown): never {
  const kind = value === undefined ? 'undefined' : typeof value
  throw new TypeError(`Object of type ${kind} is not JSON serializable`)
}

function writeValue(value: unknown, opts: WriterOptions, level: number): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return pyJsonEscapeString(value, opts.ensureAscii)
    case 'number':
      return writeNumber(value)
    case 'bigint':
      return value.toString()
    case 'boolean':
      return value ? 'true' : 'false'
    case 'undefined':
      unsupported(value)
  }
  const newline = opts.indent === null ? null : `\n${' '.repeat(opts.indent * level)}`
  const inner = opts.indent === null ? null : `\n${' '.repeat(opts.indent * (level + 1))}`
  const joiner = opts.indent === null ? opts.itemSeparator : `,${inner}`
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const body = value.map((item) => writeValue(item, opts, level + 1)).join(joiner)
    return newline === null ? `[${body}]` : `[${inner}${body}${newline}]`
  }
  if (value instanceof PyFloat) {
    return Number.isFinite(value.value) ? pyFloatRepr(value.value) : writeNumber(value.value)
  }
  if (value instanceof Map) {
    const entries: string[] = []
    for (const [key, item] of value) {
      if (typeof key !== 'string') unsupported(key)
      entries.push(
        `${pyJsonEscapeString(key, opts.ensureAscii)}${opts.keySeparator}${writeValue(item, opts, level + 1)}`
      )
    }
    if (entries.length === 0) return '{}'
    const body = entries.join(joiner)
    return newline === null ? `{${body}}` : `{${inner}${body}${newline}}`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    const entries: string[] = []
    for (const key of keys) {
      if (record[key] === undefined) unsupported(record[key])
      entries.push(
        `${pyJsonEscapeString(key, opts.ensureAscii)}${opts.keySeparator}${writeValue(record[key], opts, level + 1)}`
      )
    }
    if (entries.length === 0) return '{}'
    const body = entries.join(joiner)
    return newline === null ? `{${body}}` : `{${inner}${body}${newline}}`
  }
  unsupported(value)
}
