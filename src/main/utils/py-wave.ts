import { PythonError } from '../../shared/utils/exceptions'

export interface WaveInfo {
  nframes: number
  rate: number
  channels: number
  sampwidth: number
}

export interface WaveFile extends WaveInfo {
  formatTag: number
  bits: number
  data: Buffer
}

const WAVE_FORMAT_PCM = 0x0001
export const WAVE_FORMAT_IEEE_FLOAT = 0x0003
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

const KSDATAFORMAT_SUBTYPE_PCM = Buffer.from([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71
])

function waveError(message: string): PythonError {
  return new PythonError('Error', message)
}

interface ParsedWave {
  formatTag: number
  channels: number
  rate: number
  bits: number
  subFormat: Buffer | null
  data: Buffer
  nframes: number
  framesize: number
}

function parseWave(data: Buffer): ParsedWave {
  if (data.length < 12) throw new PythonError('EOFError', '')
  if (data.subarray(0, 4).toString('latin1') !== 'RIFF')
    throw waveError('file does not start with RIFF id')
  if (data.subarray(8, 12).toString('latin1') !== 'WAVE') throw waveError('not a WAVE file')

  const riffSize = data.readUInt32LE(4)
  const end = Math.min(8 + riffSize, data.length)

  let parsed: ParsedWave | null = null
  let offset = 12
  for (;;) {
    if (offset + 8 > end) break
    const name = data.subarray(offset, offset + 4).toString('latin1')
    const chunkSize = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (name === 'fmt ') {
      if (body + 16 > Math.min(end, body + chunkSize)) throw new PythonError('EOFError', '')
      const formatTag = data.readUInt16LE(body)
      const channels = data.readUInt16LE(body + 2)
      const rate = data.readUInt32LE(body + 4)
      const bits = data.readUInt16LE(body + 14)
      let subFormat: Buffer | null = null
      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        if (body + 38 > Math.min(end, body + chunkSize)) throw new PythonError('EOFError', '')
        subFormat = data.subarray(body + 24, body + 40)
      }
      const sampwidth = Math.floor((bits + 7) / 8)
      if (!sampwidth) throw waveError('bad sample width')
      if (!channels) throw waveError('bad # of channels')
      parsed = {
        formatTag,
        channels,
        rate,
        bits,
        subFormat,
        nframes: 0,
        framesize: channels * sampwidth,
        data: data.subarray(body, body)
      }
    } else if (name === 'data') {
      if (parsed === null) throw waveError('data chunk before fmt chunk')
      const available = Math.max(0, Math.min(chunkSize, end - body))
      parsed.data = data.subarray(body, body + available)
      parsed.nframes = Math.floor(available / parsed.framesize)
      return parsed
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  throw waveError('fmt chunk and/or data chunk missing')
}

export function readWaveHeader(data: Buffer): WaveInfo {
  const parsed = parseWave(data)
  if (parsed.formatTag !== WAVE_FORMAT_PCM && parsed.formatTag !== WAVE_FORMAT_EXTENSIBLE) {
    throw waveError(`unknown format: ${parsed.formatTag}`)
  }
  if (
    parsed.formatTag === WAVE_FORMAT_EXTENSIBLE &&
    !parsed.subFormat?.equals(KSDATAFORMAT_SUBTYPE_PCM)
  ) {
    throw waveError('unknown extended format')
  }
  return {
    nframes: parsed.nframes,
    rate: parsed.rate,
    channels: parsed.channels,
    sampwidth: Math.floor((parsed.bits + 7) / 8)
  }
}

export function readWave(data: Buffer): WaveFile {
  const parsed = parseWave(data)
  const formatTag =
    parsed.formatTag === WAVE_FORMAT_EXTENSIBLE && parsed.subFormat
      ? parsed.subFormat.readUInt16LE(0)
      : parsed.formatTag
  return {
    nframes: parsed.nframes,
    rate: parsed.rate,
    channels: parsed.channels,
    sampwidth: Math.floor((parsed.bits + 7) / 8),
    bits: parsed.bits,
    formatTag,
    data: parsed.data
  }
}
