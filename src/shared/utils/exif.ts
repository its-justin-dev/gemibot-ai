import { EXIF_TAGS } from '../constants/exif-tags'

const TYPE_SIZES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8
}

function renderValue(
  buffer: Buffer,
  little: boolean,
  type: number,
  count: number,
  offset: number
): string {
  const view = (pos: number, size: number): number =>
    size === 1
      ? buffer.readUInt8(pos)
      : size === 2
        ? little
          ? buffer.readUInt16LE(pos)
          : buffer.readUInt16BE(pos)
        : little
          ? buffer.readUInt32LE(pos)
          : buffer.readUInt32BE(pos)

  if (type === 2) {
    const ascii = buffer.subarray(offset, offset + Math.max(0, count - 1))
    return ascii.toString('utf-8')
  }
  if (type === 3 || type === 4 || type === 1) {
    return String(view(offset, TYPE_SIZES[type]))
  }
  if (type === 5 || type === 10) {
    const readSigned = (pos: number): number =>
      little ? buffer.readInt32LE(pos) : buffer.readInt32BE(pos)
    const readUnsigned = (pos: number): number =>
      little ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos)
    const num = type === 5 ? readUnsigned(offset) : readSigned(offset)
    const den = type === 5 ? readUnsigned(offset + 4) : readSigned(offset + 4)
    return pyFloatStr(num / den)
  }
  const raw = buffer.subarray(offset, offset + count * (TYPE_SIZES[type] ?? 1))
  return 'b' + JSON.stringify(raw.toString('latin1'))
}

export interface ExifEntry {
  id: number
  value: string
}

function pyFloatStr(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

export function jpegExifPayload(raw: Buffer): Buffer | null {
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) return null
  let pos = 2
  while (pos + 4 <= raw.length) {
    if (raw[pos] !== 0xff) return null
    const marker = raw[pos + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xda) return null
    const size = raw.readUInt16BE(pos + 2)
    if (marker === 0xe1 && size >= 8) {
      const payload = raw.subarray(pos + 4, pos + 2 + size)
      if (payload.subarray(0, 4).toString('latin1') === 'Exif') return payload.subarray(6)
    }
    pos += 2 + size
  }
  return null
}

export function parseExifIfd0(exif: Buffer): ExifEntry[] {
  if (exif.subarray(0, 4).toString('latin1') === 'Exif') exif = exif.subarray(6)
  if (exif.length < 8) return []
  const head = exif.toString('latin1', 0, 2)
  if (head !== 'II' && head !== 'MM') return []
  const little = head === 'II'
  const u16 = (pos: number): number => (little ? exif.readUInt16LE(pos) : exif.readUInt16BE(pos))
  const u32 = (pos: number): number => (little ? exif.readUInt32LE(pos) : exif.readUInt32BE(pos))
  if (u16(2) !== 42) return []
  const ifd0 = u32(4)
  if (ifd0 + 2 > exif.length) return []
  const entries: ExifEntry[] = []
  const count = u16(ifd0)
  for (let index = 0; index < count; index += 1) {
    const base = ifd0 + 2 + index * 12
    if (base + 12 > exif.length) break
    const tag = u16(base)
    const type = u16(base + 2)
    const num = u32(base + 4)
    const size = (TYPE_SIZES[type] ?? 1) * num
    const valueOffset = size <= 4 ? base + 8 : u32(base + 8)
    if (valueOffset + size > exif.length) continue
    entries.push({ id: tag, value: renderValue(exif, little, type, num, valueOffset) })
  }
  return entries
}

export function exifTagName(id: number): string {
  return EXIF_TAGS.TAGS[String(id)] ?? String(id)
}
