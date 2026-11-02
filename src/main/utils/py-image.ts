export interface ImageHeader {
  format: string
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngHeader(bytes: Buffer): ImageHeader | null {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null
  if (bytes.length < 29 || bytes.readUInt32BE(8) !== 13) return null
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  return { format: 'PNG', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, 0xde
])

function jpegStandaloneMarker(marker: number): boolean {
  return marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0xff
}

function jpegHeader(bytes: Buffer): ImageHeader | null {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return null
  let i = 2
  for (;;) {
    if (i >= bytes.length) return null
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]
    i += 2
    if (jpegStandaloneMarker(marker)) continue
    if (i + 1 >= bytes.length) return null
    const length = bytes.readUInt16BE(i)
    if (length < 2) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7 || i + 7 > bytes.length) return null
      return { format: 'JPEG', width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) }
    }
    if (marker === 0xda) return null
    i += length
  }
}

function gifHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 10) return null
  const version = bytes.toString('latin1', 0, 6)
  if (version !== 'GIF87a' && version !== 'GIF89a') return null
  return { format: 'GIF', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
}

const DIB_HEADER_SIZES = [12, 40, 52, 56, 64, 108, 124]

const BMP_BIT_DEPTHS = new Set([1, 4, 8, 16, 24, 32])

function dibInfo(bytes: Buffer, at: number): { width: number; height: number } | null {
  if (at < 0 || at + 4 > bytes.length) return null
  const size = bytes.readUInt32LE(at)
  if (!DIB_HEADER_SIZES.includes(size)) return null
  const data = at + 4
  if (data + size - 4 > bytes.length) return null
  if (size === 12) {
    const bits = bytes.readUInt16LE(data + 6)
    if (!BMP_BIT_DEPTHS.has(bits)) return null
    return { width: bytes.readUInt16LE(data), height: bytes.readUInt16LE(data + 2) }
  }
  const flipped = bytes[data + 7] === 0xff
  const height = bytes.readUInt32LE(data + 4)
  const bits = bytes.readUInt16LE(data + 10)
  if (!BMP_BIT_DEPTHS.has(bits)) return null
  return { width: bytes.readUInt32LE(data), height: flipped ? 2 ** 32 - height : height }
}

function bmpHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 14 || bytes.toString('latin1', 0, 2) !== 'BM') return null
  const info = dibInfo(bytes, 14)
  return info ? { format: 'BMP', ...info } : null
}

function rawDibHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 4) return null
  if (!DIB_HEADER_SIZES.includes(bytes.readUInt32LE(0))) return null
  const info = dibInfo(bytes, 0)
  return info ? { format: 'DIB', ...info } : null
}

function icoHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 6) return null
  if (!(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0)) return null
  const count = bytes.readUInt16LE(4)
  if (bytes.length < 6 + count * 16) return null
  const entries: { width: number; height: number; depth: number }[] = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const width = bytes[at] || 256
    const height = bytes[at + 1] || 256
    const colors = bytes[at + 2]
    const bpp = bytes.readUInt16LE(at + 6)
    entries.push({
      width,
      height,
      depth: bpp || (colors !== 0 ? Math.ceil(Math.log2(colors)) : 0) || 256
    })
  }
  if (entries.length === 0) return null
  const winner = entries.reduce((top, entry) =>
    entry.width * entry.height > top.width * top.height ||
    (entry.width * entry.height === top.width * top.height && entry.depth < top.depth)
      ? entry
      : top
  )
  return { format: 'ICO', width: winner.width, height: winner.height }
}

function curHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 6) return null
  if (!(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 2 && bytes[3] === 0)) return null
  const count = bytes.readUInt16LE(4)
  if (bytes.length < 6 + count * 16) return null
  let chosen = -1
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    if (chosen < 0 || (bytes[at] > bytes[chosen] && bytes[at + 1] > bytes[chosen + 1])) chosen = at
  }
  if (chosen < 0) return null
  const bitmap = dibInfo(bytes, bytes.readUInt32LE(chosen + 12))
  if (!bitmap) return null
  return { format: 'CUR', width: bitmap.width, height: Math.floor(bitmap.height / 2) }
}

const TIFF_PREFIXES = ['II*\u0000', 'MM\u0000*']

function tiffHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 8) return null
  const prefix = bytes.toString('latin1', 0, 4)
  if (!TIFF_PREFIXES.includes(prefix)) return null
  const bigEndian = prefix.startsWith('MM')
  const u16 = (at: number): number => (bigEndian ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at))
  const u32 = (at: number): number => (bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at))
  const ifd = u32(4)
  if (ifd + 2 > bytes.length) return null
  const entries = u16(ifd)
  let width: number | null = null
  let height: number | null = null
  let orientation = 1
  for (let i = 0; i < entries; i++) {
    const at = ifd + 2 + i * 12
    if (at + 12 > bytes.length) return null
    const tag = u16(at)
    const type = u16(at + 2)
    if ((tag !== 256 && tag !== 257 && tag !== 274) || u32(at + 4) !== 1) continue
    const value = type === 3 ? u16(at + 8) : type === 4 ? u32(at + 8) : null
    if (value === null) continue
    if (tag === 256) width = value
    else if (tag === 257) height = value
    else orientation = value
  }
  if (width === null || height === null) return null
  if (orientation >= 5 && orientation <= 8) return { format: 'TIFF', width: height, height: width }
  return { format: 'TIFF', width, height }
}

function webpHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 16) return null
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP')
    return null
  const kind = bytes.toString('latin1', 12, 16)
  if (kind === 'VP8 ') {
    if (bytes.length < 30 || bytes.readUInt32LE(16) < 10) return null
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null
    return {
      format: 'WEBP',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    }
  }
  if (kind === 'VP8L') {
    if (bytes.length < 25 || bytes.readUInt32LE(16) < 5) return null
    if (bytes[20] !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    return { format: 'WEBP', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X') {
    if (bytes.length < 30 || bytes.readUInt32LE(16) < 10) return null
    return {
      format: 'WEBP',
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1
    }
  }
  return null
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d])
const PPM_MODES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']

function ppmTokens(bytes: Buffer, from: number, wanted: number): { values: number[]; ok: boolean } {
  const values: number[] = []
  let i = from
  while (values.length < wanted) {
    let token = ''
    while (token.length <= 10 && i < bytes.length) {
      const byte = bytes[i]
      i += 1
      if (WHITESPACE.has(byte)) {
        if (token.length > 0) break
        continue
      }
      if (byte === 0x23) {
        while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1
        continue
      }
      token += String.fromCharCode(byte)
    }
    if (token.length === 0 || token.length > 10) return { values: [], ok: false }
    if (!/^[+-]?\d+$/.test(token)) return { values: [], ok: false }
    values.push(Number.parseInt(token, 10))
  }
  return { values, ok: true }
}

function ppmHeader(bytes: Buffer): ImageHeader | null {
  if (bytes.length < 2) return null
  let magic = ''
  let i = 0
  while (i < 6 && i < bytes.length && !WHITESPACE.has(bytes[i])) {
    magic += String.fromCharCode(bytes[i])
    i += 1
  }
  if (!PPM_MODES.includes(magic)) return null
  const size = ppmTokens(bytes, i, 2)
  if (!size.ok) return null
  if (magic !== 'P1' && magic !== 'P4') {
    const maxval = ppmTokens(bytes, i, 3)
    if (!maxval.ok || !(maxval.values[2] > 0 && maxval.values[2] < 65536)) return null
  }
  return { format: 'PPM', width: size.values[0], height: size.values[1] }
}

const READERS: ((bytes: Buffer) => ImageHeader | null)[] = [
  pngHeader,
  jpegHeader,
  gifHeader,
  bmpHeader,
  rawDibHeader,
  icoHeader,
  curHeader,
  tiffHeader,
  webpHeader,
  ppmHeader
]

export function readImageHeader(bytes: Buffer): ImageHeader | null {
  for (const reader of READERS) {
    try {
      const header = reader(bytes)
      if (header) return header
    } catch {}
  }
  return null
}
