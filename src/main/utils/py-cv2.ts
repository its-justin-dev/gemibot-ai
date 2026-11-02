export const CAP_PROP_POS_FRAMES = 1
export const CAP_PROP_FRAME_WIDTH = 3
export const CAP_PROP_FRAME_HEIGHT = 4
export const CAP_PROP_FPS = 5
export const CAP_PROP_FRAME_COUNT = 7

export type DecodedFrame =
  | { kind: 'jpeg'; bytes: Buffer }
  | { kind: 'raw'; bytes: Buffer; width: number; height: number; channels: 3 }

interface FrameRecord {
  offset: number
  length: number
}

interface VideoStream {
  width: number
  height: number
  fps: number
  frames: number
  codec: 'mjpeg' | 'bmp' | null
  table: FrameRecord[] | null
}

function u16be(b: Buffer, o: number): number {
  return b.readUInt16BE(o)
}

function u32be(b: Buffer, o: number): number {
  return b.readUInt32BE(o)
}

function u32le(b: Buffer, o: number): number {
  return b.readUInt32LE(o)
}

function u16le(b: Buffer, o: number): number {
  return b.readUInt16LE(o)
}

function i32le(b: Buffer, o: number): number {
  return b.readInt32LE(o)
}

function fixed16(b: Buffer, o: number): number {
  return u32be(b, o) / 65536
}

interface Box {
  type: string
  body: number
  end: number
}

function boxes(buf: Buffer, from: number, to: number, type?: string): Box[] {
  const out: Box[] = []
  let o = from
  while (o + 8 <= to) {
    let size = u32be(buf, o)
    const name = buf.toString('latin1', o + 4, o + 8)
    let header = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(o + 8))
      header = 16
    } else if (size === 0) {
      size = to - o
    }
    const body = o + header
    const end = Math.min(o + size, to)
    if (size < header) break
    if (type === undefined || name === type) out.push({ type: name, body, end })
    o += size
  }
  return out
}

function firstBox(buf: Buffer, from: number, to: number, type: string): Box | null {
  const found = boxes(buf, from, to, type)
  return found.length > 0 ? found[0] : null
}

function readMp4(buf: Buffer): VideoStream | null {
  const head = buf.length >= 8 ? buf.toString('latin1', 4, 8) : ''
  if (head !== 'ftyp' && head !== 'moov' && head !== 'mdat' && head !== 'free' && head !== 'skip')
    return null
  const moov = firstBox(buf, 0, buf.length, 'moov')
  if (!moov) return null

  for (const trak of boxes(buf, moov.body, moov.end, 'trak')) {
    const mdia = firstBox(buf, trak.body, trak.end, 'mdia')
    if (!mdia) continue
    const hdlrBox = firstBox(buf, mdia.body, mdia.end, 'hdlr')
    const handler = hdlrBox ? buf.toString('latin1', hdlrBox.body + 8, hdlrBox.body + 12) : ''
    if (handler !== 'vide') continue

    let timescale = 0
    let sampleCount = 0
    let sttsDuration = 0
    let width = 0
    let height = 0

    const tkhd = firstBox(buf, trak.body, trak.end, 'tkhd')
    if (tkhd) {
      const shift = buf[tkhd.body] === 1 ? 12 : 0
      width = Math.round(fixed16(buf, tkhd.body + 76 + shift))
      height = Math.round(fixed16(buf, tkhd.body + 80 + shift))
    }
    const mdhd = firstBox(buf, mdia.body, mdia.end, 'mdhd')
    if (mdhd) timescale = u32be(buf, mdhd.body + (buf[mdhd.body] === 1 ? 24 : 12))
    const minf = firstBox(buf, mdia.body, mdia.end, 'minf')
    const stbl = minf ? firstBox(buf, minf.body, minf.end, 'stbl') : null
    if (!stbl) continue

    const stsd = firstBox(buf, stbl.body, stbl.end, 'stsd')
    if (stsd && (!width || !height)) {
      const entry = stsd.body + 8
      width = u16be(buf, entry + 32)
      height = u16be(buf, entry + 34)
    }
    const stsz = firstBox(buf, stbl.body, stbl.end, 'stsz')
    if (stsz) sampleCount = u32be(buf, stsz.body + 8)
    const stts = firstBox(buf, stbl.body, stbl.end, 'stts')
    if (stts) {
      const entries = u32be(buf, stts.body + 4)
      for (let i = 0; i < entries; i++) {
        const o = stts.body + 8 + i * 8
        if (o + 8 > stts.end) break
        sttsDuration += u32be(buf, o) * u32be(buf, o + 4)
      }
    }

    return {
      width,
      height,
      fps: timescale > 0 && sttsDuration > 0 ? (timescale * sampleCount) / sttsDuration : 0,
      frames: sampleCount,
      codec: null,
      table: null
    }
  }
  return null
}

interface AviStream {
  width: number
  height: number
  length: number
  scale: number
  rate: number
}

function readAvi(buf: Buffer): VideoStream | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF') return null
  if (buf.toString('latin1', 8, 12) !== 'AVI ') return null

  const listChildren = (from: number, to: number, type: string): Box[] => {
    const found: Box[] = []
    let o = from
    while (o + 8 <= to) {
      const size = u32le(buf, o + 4)
      const name = buf.toString('latin1', o, o + 4)
      if (name === 'LIST' && buf.toString('latin1', o + 8, o + 12) === type)
        found.push({ type: name, body: o + 12, end: Math.min(o + 8 + size, to) })
      o += 8 + size + (size & 1)
    }
    return found
  }
  const chunks = (from: number, to: number, type: string): Box[] => {
    const found: Box[] = []
    let o = from
    while (o + 8 <= to) {
      const size = u32le(buf, o + 4)
      if (buf.toString('latin1', o, o + 4) === type)
        found.push({ type, body: o + 8, end: Math.min(o + 8 + size, to) })
      o += 8 + size + (size & 1)
    }
    return found
  }

  const hdrl = listChildren(12, buf.length, 'hdrl')[0]
  if (!hdrl) return null
  const avih = chunks(hdrl.body, hdrl.end, 'avih')[0]
  if (!avih) return null
  const microSecPerFrame = u32le(buf, avih.body)
  const totalFrames = u32le(buf, avih.body + 16)

  let video: AviStream | null = null
  for (const strl of listChildren(hdrl.body, hdrl.end, 'strl')) {
    const strh = chunks(strl.body, strl.end, 'strh')[0]
    if (!strh || buf.toString('latin1', strh.body, strh.body + 4) !== 'vids') continue
    const stream: AviStream = {
      scale: u32le(buf, strh.body + 20),
      rate: u32le(buf, strh.body + 24),
      length: u32le(buf, strh.body + 32),
      width: 0,
      height: 0
    }
    const strf = chunks(strl.body, strl.end, 'strf')[0]
    if (strf) {
      stream.width = u32le(buf, strf.body + 4)
      stream.height = Math.abs(i32le(buf, strf.body + 8))
    }
    video = stream
    break
  }
  if (!video) return null

  const moviList = listChildren(12, buf.length, 'movi')[0]
  const idx1 = chunks(12, buf.length, 'idx1')[0]
  const videoChunks: FrameRecord[] = []
  if (moviList) {
    const isVideoChunk = (id: string): boolean => /^\d\dd[cbf]$/.test(id)
    if (idx1) {
      const entries = Math.floor(u32le(buf, idx1.body - 4) / 16)
      for (let i = 0; i < entries; i++) {
        const o = idx1.body + i * 16
        if (o + 16 > idx1.end) break
        if (!isVideoChunk(buf.toString('latin1', o, o + 4))) continue
        videoChunks.push({
          offset: moviList.body - 4 + u32le(buf, o + 8) + 8,
          length: u32le(buf, o + 12)
        })
      }
    } else {
      let o = moviList.body
      while (o + 8 <= moviList.end) {
        const size = u32le(buf, o + 4)
        if (isVideoChunk(buf.toString('latin1', o, o + 4)))
          videoChunks.push({ offset: o + 8, length: size })
        o += 8 + size + (size & 1)
      }
    }
  }
  let codec: VideoStream['codec'] = null
  const first = videoChunks[0]
  if (first && first.offset + 2 <= buf.length) {
    if (buf.toString('latin1', first.offset, first.offset + 2) === 'BM') codec = 'bmp'
    else if (buf[first.offset] === 0xff && buf[first.offset + 1] === 0xd8) codec = 'mjpeg'
  }

  const frames = totalFrames || videoChunks.length || video.length
  let fps = microSecPerFrame > 0 ? 1e6 / microSecPerFrame : 0
  if (fps <= 0 && video.scale > 0) fps = video.rate / video.scale
  return {
    width: video.width,
    height: video.height,
    fps,
    frames,
    codec,
    table: codec ? videoChunks : null
  }
}

interface EbmlElement {
  id: string
  data: number
  end: number
}

const EBML_IDS = {
  header: '1a45dfa3',
  segment: '18538067',
  info: '1549a966',
  timecodeScale: '2ad7b1',
  duration: '4489',
  tracks: '1654ae6b',
  trackEntry: 'ae',
  trackNumber: 'd7',
  trackType: '83',
  defaultDuration: '23e383',
  video: 'e0',
  pixelWidth: 'b0',
  pixelHeight: 'ba',
  cluster: '1f43b675',
  simpleBlock: 'a3',
  blockGroup: 'eb',
  block: 'a1'
} as const

function ebmlVint(buf: Buffer, at: number): { value: number; size: number } | null {
  if (at >= buf.length) return null
  const first = buf[at]
  let size = 1
  while (size <= 8 && (first & (0x80 >> (size - 1))) === 0) size++
  if (size > 8 || at + size > buf.length) return null
  let value = first & (0xff >> size)
  for (let i = 1; i < size; i++) value = value * 256 + buf[at + i]
  return { value, size }
}

function ebmlId(buf: Buffer, at: number): { id: string; size: number } | null {
  if (at >= buf.length) return null
  const first = buf[at]
  let size = 1
  while (size <= 4 && (first & (0x80 >> (size - 1))) === 0) size++
  if (size > 4 || at + size > buf.length) return null
  let id = ''
  for (let i = 0; i < size; i++) id += buf[at + i].toString(16).padStart(2, '0')
  return { id, size }
}

function ebmlChildren(buf: Buffer, from: number, to: number): EbmlElement[] {
  const out: EbmlElement[] = []
  let o = from
  while (o < to) {
    const id = ebmlId(buf, o)
    if (!id) break
    const len = ebmlVint(buf, o + id.size)
    if (!len) break
    const data = o + id.size + len.size
    const size = len.value
    out.push({ id: id.id, data, end: Math.min(data + size, to) })
    o = data + size
    if (o > to) break
  }
  return out
}

function ebmlUint(buf: Buffer, el: EbmlElement): number {
  let value = 0
  for (let o = el.data; o < el.end; o++) value = value * 256 + buf[o]
  return value
}

function ebmlFloat(buf: Buffer, el: EbmlElement): number {
  const size = el.end - el.data
  if (size === 4) return buf.readFloatBE(el.data)
  if (size === 8) return buf.readDoubleBE(el.data)
  return 0
}

function readMatroska(buf: Buffer): VideoStream | null {
  if (buf.length < 4 || buf.toString('hex', 0, 4) !== EBML_IDS.header) return null
  const header = ebmlChildren(buf, 0, buf.length)[0]
  if (!header || header.id !== EBML_IDS.header) return null
  const seg = ebmlChildren(buf, header.end, buf.length).find((el) => el.id === EBML_IDS.segment)
  if (!seg) return null
  const elements = ebmlChildren(buf, seg.data, seg.end)

  let timecodeScale = 1000000
  let duration = 0
  const info = elements.find((el) => el.id === EBML_IDS.info)
  if (info) {
    for (const el of ebmlChildren(buf, info.data, info.end)) {
      if (el.id === EBML_IDS.timecodeScale) timecodeScale = ebmlUint(buf, el)
      else if (el.id === EBML_IDS.duration) duration = ebmlFloat(buf, el)
    }
  }

  let fps = 0
  let width = 0
  let height = 0
  let trackNumber = -1
  let defaultDuration = 0
  const tracks = elements.find((el) => el.id === EBML_IDS.tracks)
  if (tracks) {
    for (const entry of ebmlChildren(buf, tracks.data, tracks.end)) {
      if (entry.id !== EBML_IDS.trackEntry) continue
      let type = 0
      let number = 0
      let video: { width: number; height: number } | null = null
      let entryDuration = 0
      for (const el of ebmlChildren(buf, entry.data, entry.end)) {
        if (el.id === EBML_IDS.trackType) type = ebmlUint(buf, el)
        else if (el.id === EBML_IDS.trackNumber) number = ebmlUint(buf, el)
        else if (el.id === EBML_IDS.defaultDuration) entryDuration = ebmlUint(buf, el)
        else if (el.id === EBML_IDS.video) {
          let w = 0
          let h = 0
          for (const inner of ebmlChildren(buf, el.data, el.end)) {
            if (inner.id === EBML_IDS.pixelWidth) w = ebmlUint(buf, inner)
            else if (inner.id === EBML_IDS.pixelHeight) h = ebmlUint(buf, inner)
          }
          video = { width: w, height: h }
        }
      }
      if (type !== 1 || video === null) continue
      trackNumber = number
      width = video.width
      height = video.height
      defaultDuration = entryDuration
      break
    }
  }
  if (trackNumber < 0) return null

  if (defaultDuration > 0) fps = 1e9 / defaultDuration
  let frames = 0
  for (const cluster of elements) {
    if (cluster.id !== EBML_IDS.cluster) continue
    for (const el of ebmlChildren(buf, cluster.data, cluster.end)) {
      const block =
        el.id === EBML_IDS.simpleBlock
          ? { data: el.data, end: el.end }
          : el.id === EBML_IDS.blockGroup
            ? ebmlChildren(buf, el.data, el.end).find((inner) => inner.id === EBML_IDS.block)
            : null
      if (!block) continue
      const vint = ebmlVint(buf, block.data)
      if (vint && vint.value === trackNumber) frames++
    }
  }
  if (frames === 0 && fps > 0 && duration > 0)
    frames = Math.round((duration * timecodeScale) / 1e9 / (1 / fps))
  return { width, height, fps, frames, codec: null, table: null }
}

function decodeBmp(frame: Buffer): { data: Buffer; width: number; height: number } | null {
  if (frame.length < 54) return null
  const pixels = u32le(frame, 10)
  const header = u32le(frame, 14)
  const width = i32le(frame, 18)
  const rawHeight = i32le(frame, 22)
  const bits = u16le(frame, 28)
  const compression = u32le(frame, 30)
  if (header < 40 || compression !== 0 || width <= 0 || rawHeight === 0) return null
  if (bits !== 24 && bits !== 32) return null
  const height = Math.abs(rawHeight)
  const stride = Math.floor((bits * width + 31) / 32) * 4
  if (pixels + stride * height > frame.length) return null

  const data = Buffer.alloc(width * height * 3)
  const topDown = rawHeight < 0
  for (let y = 0; y < height; y++) {
    const from = pixels + stride * (topDown ? y : height - 1 - y)
    let to = y * width * 3
    for (let x = 0; x < width; x++, to += 3) {
      data[to] = frame[from + x * (bits / 8) + 2]
      data[to + 1] = frame[from + x * (bits / 8) + 1]
      data[to + 2] = frame[from + x * (bits / 8)]
    }
  }
  return { data, width, height }
}

export class VideoCapture {
  private stream: VideoStream | null = null
  private buffer: Buffer | null = null
  private position = 0

  constructor(source: Buffer) {
    this.buffer = source
    try {
      this.stream = readMp4(source) ?? readAvi(source) ?? readMatroska(source) ?? null
    } catch {
      this.stream = null
    }
  }

  isOpened(): boolean {
    return this.stream !== null
  }

  get(prop: number): number {
    const stream = this.stream
    if (!stream) return -1
    if (prop === CAP_PROP_FPS) return stream.fps
    if (prop === CAP_PROP_FRAME_COUNT) return stream.frames
    if (prop === CAP_PROP_FRAME_WIDTH) return stream.width
    if (prop === CAP_PROP_FRAME_HEIGHT) return stream.height
    return -1
  }

  set(prop: number, value: number): boolean {
    if (prop !== CAP_PROP_POS_FRAMES || !this.stream) return false
    this.position = Math.max(0, Math.trunc(value))
    return true
  }

  read(): DecodedFrame | null {
    const stream = this.stream
    if (!stream || !stream.table || !this.buffer) return null
    if (this.position >= stream.table.length) return null
    const record = stream.table[this.position]
    const bytes = this.buffer.subarray(record.offset, record.offset + record.length)
    if (bytes.length !== record.length || bytes.length === 0) return null
    this.position += 1
    if (stream.codec === 'mjpeg') return { kind: 'jpeg', bytes: Buffer.from(bytes) }
    const frame = decodeBmp(bytes)
    if (!frame) return null
    return { kind: 'raw', bytes: frame.data, width: frame.width, height: frame.height, channels: 3 }
  }

  release(): void {
    this.stream = null
    this.buffer = null
  }
}
