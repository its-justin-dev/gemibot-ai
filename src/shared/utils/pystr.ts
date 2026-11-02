import { PythonError } from './exceptions'
import { pyRepr } from './pyrepr'

const PYTHON_SPACE_CODEPOINTS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000
])

export function pyIsspace(ch: string): boolean {
  const code = ch.codePointAt(0)
  return code !== undefined && PYTHON_SPACE_CODEPOINTS.has(code)
}

const LINE_BOUNDARIES: Array<[string, string]> = [
  ['\r\n', '\n'],
  ['\n', '\n'],
  ['\r', '\r'],
  ['\v', '\v'],
  ['\f', '\f'],
  ['\x1c', '\x1c'],
  ['\x1d', '\x1d'],
  ['\x1e', '\x1e'],
  ['\x85', '\x85'],
  ['\u2028', '\u2028'],
  ['\u2029', '\u2029']
]

export function pySplitlines(text: string, keepends = false): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const pair = LINE_BOUNDARIES.find(([seq]) => text.startsWith(seq, i))
    if (!pair) {
      i += 1
      continue
    }
    const [seq, eol] = pair
    out.push(text.slice(start, i) + (keepends ? eol : ''))
    i += seq.length
    start = i
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

export function pyExpandtabs(text: string, tabsize = 8): string {
  if (tabsize <= 0) return text.replaceAll('\t', '')
  let out = ''
  let column = 0
  for (const ch of text) {
    if (ch === '\t') {
      const pad = tabsize - (column % tabsize)
      out += ' '.repeat(pad)
      column += pad
    } else {
      out += ch
      column = ch === '\n' ? 0 : column + 1
    }
  }
  return out
}

export function pyRstrip(text: string): string {
  let end = text.length
  while (end > 0 && pyIsspace(text[end - 1])) end -= 1
  return text.slice(0, end)
}

export function pyLstrip(text: string): string {
  let start = 0
  while (start < text.length && pyIsspace(text[start])) start += 1
  return text.slice(start)
}

export function pyStrip(text: string): string {
  return pyRstrip(pyLstrip(text))
}

export function pyStripChars(text: string, chars: string): string {
  return pyRstripChars(pyLstripChars(text, chars), chars)
}

export function pyLstripChars(text: string, chars: string): string {
  let start = 0
  while (start < text.length && chars.includes(text[start])) start += 1
  return text.slice(start)
}

export function pyRstripChars(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1])) end -= 1
  return text.slice(0, end)
}

export function pyIsAllSpace(text: string): boolean {
  if (!text) return false
  for (const ch of text) if (!pyIsspace(ch)) return false
  return true
}

export function pyIsUpper(text: string): boolean {
  let hasCased = false
  for (const ch of text) {
    if (ch !== ch.toUpperCase() || ch !== ch.toLowerCase()) hasCased = true
    if (ch !== ch.toUpperCase()) return false
  }
  return hasCased
}

export function pyTitle(text: string): string {
  let titled = ''
  let previousIsCased = false
  for (const ch of text) {
    titled += previousIsCased ? ch.toLowerCase() : ch.toUpperCase()
    previousIsCased = ch !== ch.toUpperCase() || ch !== ch.toLowerCase()
  }
  return titled
}

/* eslint-disable no-control-regex */
export function pySplitWords(text: string): string[] {
  return text
    .split(
      /[\x09\x0a\x0b\x0c\x0d\x1c\x1d\x1e\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/
    )
    .filter((word) => word !== '')
}
/* eslint-enable no-control-regex */

export function pyRfind(
  haystack: string,
  needle: string,
  start = 0,
  end = haystack.length
): number {
  const slice = haystack.slice(start, end)
  const at = slice.lastIndexOf(needle)
  return at === -1 ? -1 : start + at
}

export function pyLen(text: string): number {
  return Array.from(text).length
}

export function pySlice(text: string, start: number, stop = pyLen(text)): string {
  const length = pyLen(text)
  const from = start < 0 ? Math.max(0, length + start) : Math.min(start, length)
  const to = stop < 0 ? Math.max(0, length + stop) : Math.min(stop, length)
  if (from >= to) return ''
  const chars = Array.from(text)
  return chars.slice(from, to).join('')
}

export function pyLjust(text: string, width: number): string {
  const length = pyLen(text)
  return length >= width ? text : text + ' '.repeat(width - length)
}

export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

export function pyInt(text: string): number {
  const clean = pyStrip(text).replaceAll('_', '')
  if (!/^[-+]?\d+$/.test(clean))
    throw new PythonError('ValueError', `invalid literal for int() with base 10: ${pyRepr(text)}`)
  return Number(clean)
}

export function pyIntValue(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isNaN(value))
      throw new PythonError('ValueError', 'cannot convert float NaN to integer')
    if (!Number.isFinite(value))
      throw new PythonError('OverflowError', 'cannot convert float infinity to integer')
    return Math.trunc(value)
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return pyInt(value)
  throw new PythonError(
    'TypeError',
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(
      value
    )}'`
  )
}

export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (typeof value === 'bigint') return 'int'
  if (typeof value === 'string') return 'str'
  if (Array.isArray(value)) return 'list'
  return 'dict'
}

export function pyCompare(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i].codePointAt(0) as number
    const r = right[i].codePointAt(0) as number
    if (l !== r) return l < r ? -1 : 1
  }
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

export function pyKeepOriginalWs(s: string, tagS: string): string {
  const a = Array.from(s)
  const b = Array.from(tagS)
  const n = Math.min(a.length, b.length)
  let out = ''
  for (let i = 0; i < n; i++) {
    out += b[i] === ' ' && pyIsspace(a[i]) ? a[i] : b[i]
  }
  return out
}

export function pyRepeat(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : ''
}
