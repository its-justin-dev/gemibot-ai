import { crc32, deflateSync } from 'zlib'

import qrcode from 'qrcode'

import { PythonError } from '../../shared/utils/exceptions'
import { pyBytesRepr, pyReprValue } from '../../shared/utils/pyrepr'
import { pySlice, pyStr, pyTypeName } from '../../shared/utils/pystr'

const ERROR_CORRECTION = 'M'
const BOX_SIZE = 10
const BORDER = 4
const OPTIMIZE_MINIMUM = 20

const MODE_NUMBER = 1
const MODE_ALPHA_NUM = 2
const MODE_8BIT_BYTE = 4

const ALPHA_NUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

const BIT_LIMIT_M = [
  0, 128, 224, 352, 512, 688, 864, 992, 1232, 1456, 1728, 2032, 2320, 2672, 2920, 3320, 3624, 4056,
  4504, 5016, 5352, 5712, 6256, 6880, 7312, 8000, 8496, 9024, 9544, 10136, 10984, 11640, 12328,
  13048, 13800, 14496, 15312, 15936, 16816, 17728, 18672
]

const MODE_SIZE_SMALL = { [MODE_NUMBER]: 10, [MODE_ALPHA_NUM]: 9, [MODE_8BIT_BYTE]: 8 }
const MODE_SIZE_MEDIUM = { [MODE_NUMBER]: 12, [MODE_ALPHA_NUM]: 11, [MODE_8BIT_BYTE]: 16 }
const MODE_SIZE_LARGE = { [MODE_NUMBER]: 14, [MODE_ALPHA_NUM]: 13, [MODE_8BIT_BYTE]: 16 }

function modeSizesForVersion(version: number): typeof MODE_SIZE_SMALL {
  if (version < 10) return MODE_SIZE_SMALL
  if (version < 27) return MODE_SIZE_MEDIUM
  return MODE_SIZE_LARGE
}

interface QrChunk {
  mode: number
  bytes: Buffer
}

function toSegment(chunk: QrChunk): { data: string; mode: string } {
  const mode =
    chunk.mode === MODE_NUMBER ? 'numeric' : chunk.mode === MODE_ALPHA_NUM ? 'alphanumeric' : 'byte'
  return { data: chunk.bytes.toString('utf8'), mode }
}

export function qrPayloadBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value)
  const text = typeof value === 'string' ? value : strOf(value)
  checkEncodable(text)
  return Buffer.from(text, 'utf-8')
}

function strOf(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return pyStr(value)
  return pyReprValue(value)
}

function checkEncodable(text: string): void {
  const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff
  const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
  const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
  let point = 0
  for (let unit = 0; unit < text.length; unit++, point++) {
    const code = text.charCodeAt(unit)
    if (!isSurrogate(code)) continue
    if (isHigh(code) && isLow(text.charCodeAt(unit + 1))) {
      unit++
      continue
    }
    let last = point
    while (unit + 1 < text.length && isSurrogate(text.charCodeAt(unit + 1))) {
      if (isHigh(text.charCodeAt(unit + 1)) && isLow(text.charCodeAt(unit + 2))) break
      unit++
      last++
    }
    const hex = `\\u${code.toString(16).padStart(4, '0')}`
    const where =
      last === point
        ? `character '${hex}' in position ${point}`
        : `characters in position ${point}-${last}`
    throw new PythonError(
      'UnicodeEncodeError',
      `'utf-8' codec can't encode ${where}: surrogates not allowed`
    )
  }
}

export function qrPayloadSummary(value: unknown): string {
  if (typeof value === 'string') return pySlice(value, 0, 80)
  if (value instanceof Uint8Array) return pyBytesRepr(value.subarray(0, 80))
  if (Array.isArray(value)) return pyReprValue(value.slice(0, 80))
  if (value !== null && value !== undefined && typeof value === 'object')
    throw new PythonError('KeyError', 'slice(None, 80, None)')
  throw new PythonError('TypeError', `'${pyTypeName(value)}' object is not subscriptable`)
}

function findRun(
  data: Buffer,
  inClass: (byte: number) => boolean,
  minimum: number,
  anchored: boolean
): [number, number] | null {
  if (anchored) {
    if (data.length === 0 || !inClass(data[0])) return null
    let end = 0
    while (end < data.length && inClass(data[end])) end++
    const rest = data.length - end
    if (rest === 0) return [0, end]
    if (rest === 1 && data[end] === 0x0a) return [0, end]
    return null
  }
  for (let i = 0; i < data.length; i++) {
    if (!inClass(data[i])) continue
    let end = i
    while (end < data.length && inClass(data[end])) end++
    if (end - i >= minimum) return [i, end]
    i = end - 1
  }
  return null
}

function optimalSplit(
  data: Buffer,
  finder: (data: Buffer) => [number, number] | null
): [boolean, Buffer][] {
  const out: [boolean, Buffer][] = []
  let rest = data
  while (rest.length > 0) {
    const match = finder(rest)
    if (!match) break
    if (match[0] > 0) out.push([false, rest.subarray(0, match[0])])
    out.push([true, rest.subarray(match[0], match[1])])
    rest = rest.subarray(match[1])
  }
  if (rest.length > 0) out.push([false, rest])
  return out
}

const isDigitByte = (byte: number): boolean => byte >= 0x30 && byte <= 0x39
const isAlphaByte = (byte: number): boolean => ALPHA_NUM.includes(String.fromCharCode(byte))

export function qrChunks(bytes: Buffer, minimum = OPTIMIZE_MINIMUM): QrChunk[] {
  const anchored = bytes.length <= minimum
  const digits = (data: Buffer): [number, number] | null =>
    findRun(data, isDigitByte, minimum, anchored)
  const alpha = (data: Buffer): [number, number] | null =>
    findRun(data, isAlphaByte, minimum, anchored)

  const out: QrChunk[] = []
  for (const [isNum, piece] of optimalSplit(bytes, digits)) {
    if (isNum) {
      out.push({ mode: MODE_NUMBER, bytes: piece })
      continue
    }
    for (const [isAlpha, sub] of optimalSplit(piece, alpha))
      out.push({ mode: isAlpha ? MODE_ALPHA_NUM : MODE_8BIT_BYTE, bytes: sub })
  }
  return out
}

function chunkBits(chunk: QrChunk): number {
  const length = chunk.bytes.length
  if (chunk.mode === MODE_NUMBER) {
    const full = Math.floor(length / 3)
    const rest = length % 3
    return full * 10 + (rest === 2 ? 7 : rest === 1 ? 4 : 0)
  }
  if (chunk.mode === MODE_ALPHA_NUM) {
    const full = Math.floor(length / 2)
    return full * 11 + (length % 2 === 1 ? 6 : 0)
  }
  return length * 8
}

function bisectLeft(table: number[], needed: number, lo: number): number {
  let low = lo
  let high = table.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (table[mid] < needed) low = mid + 1
    else high = mid
  }
  return low
}

function checkVersion(version: number): void {
  if (version < 1 || version > 40)
    throw new PythonError('ValueError', `Invalid version (was ${version}, expected 1 to 40)`)
}

export function qrBestFit(chunks: QrChunk[], start = 1): number {
  checkVersion(start)
  const modeSizes = modeSizesForVersion(start)
  let neededBits = 0
  for (const chunk of chunks) neededBits += 4 + modeSizes[chunk.mode] + chunkBits(chunk)
  const version = bisectLeft(BIT_LIMIT_M, neededBits, start)
  checkVersion(version)
  if (modeSizes !== modeSizesForVersion(version)) return qrBestFit(chunks, version)
  return version
}

function reservedCells(size: number, version: number): [number, number][] {
  const cells: [number, number][] = []
  for (let i = 0; i < 15; i++) {
    if (i < 6) cells.push([i, 8])
    else if (i < 8) cells.push([i + 1, 8])
    else cells.push([size - 15 + i, 8])
    if (i < 8) cells.push([8, size - i - 1])
    else if (i < 9) cells.push([8, 15 - i - 1 + 1])
    else cells.push([8, 15 - i - 1])
  }
  cells.push([size - 8, 8])
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3)
      const col = (i % 3) + size - 8 - 3
      cells.push([row, col])
      cells.push([col, row])
    }
  }
  return cells
}

function lostPointLevel1(modules: Uint8Array, size: number): number {
  const container = new Int32Array(size + 1)
  for (let row = 0; row < size; row++) {
    let previous = modules[row * size]
    let length = 0
    for (let col = 0; col < size; col++) {
      const value = modules[row * size + col]
      if (value === previous) length++
      else {
        if (length >= 5) container[length]++
        length = 1
        previous = value
      }
    }
    if (length >= 5) container[length]++
  }
  for (let col = 0; col < size; col++) {
    let previous = modules[col]
    let length = 0
    for (let row = 0; row < size; row++) {
      const value = modules[row * size + col]
      if (value === previous) length++
      else {
        if (length >= 5) container[length]++
        length = 1
        previous = value
      }
    }
    if (length >= 5) container[length]++
  }
  let lost = 0
  for (let length = 5; length <= size; length++) lost += container[length] * (length - 2)
  return lost
}

function lostPointLevel2(modules: Uint8Array, size: number): number {
  let lost = 0
  const last = size - 2
  for (let row = 0; row <= last; row++) {
    const thisRow = row * size
    const nextRow = (row + 1) * size
    for (let col = 0; col <= last;) {
      const topRight = modules[thisRow + col + 1]
      if (topRight !== modules[nextRow + col + 1]) col += 2
      else if (topRight !== modules[thisRow + col]) col++
      else if (topRight !== modules[nextRow + col]) col++
      else {
        lost += 3
        col++
      }
    }
  }
  return lost
}

function lostPointLevel3(modules: Uint8Array, size: number): number {
  let lost = 0
  const short = size - 11
  for (let row = 0; row < size; row++) {
    const base = row * size
    for (let col = 0; col <= short;) {
      if (level3At(modules, base + col, size, false)) lost += 40
      col += modules[base + col + 10] === 1 ? 2 : 1
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row <= short;) {
      if (level3At(modules, row * size + col, size, true)) lost += 40
      row += modules[(row + 10) * size + col] === 1 ? 2 : 1
    }
  }
  return lost
}

function level3At(modules: Uint8Array, at: number, size: number, column: boolean): boolean {
  const step = column ? size : 1
  const read = (offset: number): number => modules[at + offset * step]
  if (read(1) !== 0 || read(4) !== 1 || read(5) !== 0 || read(6) !== 1 || read(9) !== 0)
    return false
  return (
    (read(0) === 1 &&
      read(2) === 1 &&
      read(3) === 1 &&
      read(7) === 0 &&
      read(8) === 0 &&
      read(10) === 0) ||
    (read(0) === 0 &&
      read(2) === 0 &&
      read(3) === 0 &&
      read(7) === 1 &&
      read(8) === 1 &&
      read(10) === 1)
  )
}

function lostPointLevel4(modules: Uint8Array, size: number): number {
  let dark = 0
  for (const value of modules) dark += value
  const percent = dark / (size * size)
  return Math.trunc(Math.abs(percent * 100 - 50) / 5) * 10
}

function lostPoint(modules: Uint8Array, size: number): number {
  return (
    lostPointLevel1(modules, size) +
    lostPointLevel2(modules, size) +
    lostPointLevel3(modules, size) +
    lostPointLevel4(modules, size)
  )
}

function gridOf(symbol: { modules: { size: number; get(row: number, col: number): number } }): {
  size: number
  cells: Uint8Array
} {
  const size = symbol.modules.size
  const cells = new Uint8Array(size * size)
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      cells[row * size + col] = symbol.modules.get(row, col) ? 1 : 0
  return { size, cells }
}

export interface QrSymbol {
  version: number
  mask: number
  modules: Uint8Array
  side: number
}

export function qrSymbol(payload: Buffer): QrSymbol {
  const chunks = qrChunks(payload)
  const version = qrBestFit(chunks)
  const segments = chunks.map(toSegment)
  const symbols = Array.from({ length: 8 }, (_, mask) =>
    gridOf(
      qrcode.create(segments, {
        version,
        errorCorrectionLevel: ERROR_CORRECTION,
        maskPattern: mask
      })
    )
  )
  const reserved = reservedCells(symbols[0].size, version)

  let best = 0
  let bestLost = 0
  for (let mask = 0; mask < 8; mask++) {
    const test = Uint8Array.from(symbols[mask].cells)
    for (const [row, col] of reserved) test[row * symbols[mask].size + col] = 0
    const lost = lostPoint(test, symbols[mask].size)
    if (mask === 0 || bestLost > lost) {
      bestLost = lost
      best = mask
    }
  }

  const chosen = symbols[best]
  const side = chosen.size + BORDER * 2
  const modules = new Uint8Array(side * side)
  for (let row = 0; row < chosen.size; row++)
    for (let col = 0; col < chosen.size; col++)
      modules[(row + BORDER) * side + col + BORDER] = chosen.cells[row * chosen.size + col]
  return { version, mask: best, modules, side }
}

function pixelsOf(symbol: QrSymbol): { width: number; height: number; gray: Uint8Array } {
  const width = symbol.side * BOX_SIZE
  const gray = new Uint8Array(width * width)
  gray.fill(255)
  for (let row = 0; row < symbol.side; row++) {
    for (let col = 0; col < symbol.side; col++) {
      if (symbol.modules[row * symbol.side + col] !== 1) continue
      for (let dy = 0; dy < BOX_SIZE; dy++) {
        const y = (row * BOX_SIZE + dy) * width + col * BOX_SIZE
        gray.fill(0, y, y + BOX_SIZE)
      }
    }
  }
  return { width, height: width, gray }
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([header, body, crc])
}

export function qrPngBytes(symbol: QrSymbol): Buffer {
  const { width, height, gray } = pixelsOf(symbol)
  const stride = Math.ceil(width / 8)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    const at = row * (stride + 1)
    raw[at] = 0
    for (let col = 0; col < width; col++)
      if (gray[row * width + col] !== 0) raw[at + 1 + (col >> 3)] |= 1 << (7 - (col % 8))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 1
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
