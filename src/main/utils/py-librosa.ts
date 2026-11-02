import { PythonError } from '../../shared/utils/exceptions'
import { pyFormatFixed } from '../../shared/utils/pyformat'
import { readWave, WAVE_FORMAT_IEEE_FLOAT, type WaveFile } from './py-wave'

const N_FFT = 2048
const HOP_LENGTH = 512
const N_MELS = 128
const LAG = 1
const AMIN = 1e-10
const TOP_DB = 80.0

const ZCR_FRAME = 2048
const ZCR_HOP = 512
const ZCR_THRESHOLD = 1e-10

const AC_SIZE = 8.0
const START_BPM = 120
const STD_BPM = 1.0
const MAX_TEMPO = 320.0

const NORMALIZE_TINY = 2.2250738585072014e-308

export interface AudioTimeSeries {
  y: Float32Array
  sr: number
}

function libsndfileError(message: string): PythonError {
  return new PythonError('LibsndfileError', message)
}

function readInt24(data: Buffer, offset: number): number {
  const raw = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
  return raw & 0x800000 ? raw - 0x1000000 : raw
}

function sampleValue(wf: WaveFile, offset: number): number {
  const { formatTag, bits, data } = wf
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT) {
    if (bits === 32) return data.readFloatLE(offset)
    if (bits === 64) return Math.fround(data.readDoubleLE(offset))
    throw libsndfileError('Format not recognised.')
  }
  if (formatTag !== 0x0001) throw libsndfileError('Format not recognised.')
  if (bits === 8) return (data.readUInt8(offset) - 128) / 128
  if (bits === 16) return data.readInt16LE(offset) / 32768
  if (bits === 24) return readInt24(data, offset) / 8388608
  if (bits === 32) return data.readInt32LE(offset) / 2147483648
  throw libsndfileError('Format not recognised.')
}

export function loadAudio(raw: Buffer): AudioTimeSeries {
  const wf = readWave(raw)
  const frames = wf.nframes
  const framesize = wf.channels * wf.sampwidth
  const mono = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < wf.channels; c++) {
      const value = sampleValue(wf, f * framesize + c * wf.sampwidth)
      sum = c === 0 ? value : Math.fround(sum + value)
    }
    mono[f] = Math.fround(sum / wf.channels)
  }
  return { y: mono, sr: wf.rate }
}

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const t = re[i]
      re[i] = re[j]
      re[j] = t
      const u = im[i]
      im[i] = im[j]
      im[j] = u
    }
  }
  const cosTable = new Float64Array(n / 2)
  const sinTable = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI * k) / n
    cosTable[k] = Math.cos(ang)
    sinTable[k] = Math.sin(ang)
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosTable[k * step]
        const wi = sinTable[k * step]
        const br = re[start + k + half]
        const bi = im[start + k + half]
        const xr = br * wr - bi * wi
        const xi = br * wi + bi * wr
        re[start + k + half] = re[start + k] - xr
        im[start + k + half] = im[start + k] - xi
        re[start + k] += xr
        im[start + k] += xi
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

function nextPowerOfTwo(value: number): number {
  let n = 1
  while (n < value) n <<= 1
  return n
}

function hannPeriodic(length: number): Float64Array {
  const w = new Float64Array(length)
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length)
  return w
}

function medianFloat32(values: Float32Array): number {
  const sorted = Array.from(values).sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return Math.fround(Math.fround(sorted[mid - 1] + sorted[mid]) / 2)
}

function hzToMel(hz: number): number {
  const fSp = 200.0 / 3
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logStep = Math.log(6.4) / 27.0
  if (hz >= minLogHz) return minLogMel + Math.log(hz / minLogHz) / logStep
  return hz / fSp
}

function melToHz(mel: number): number {
  const fSp = 200.0 / 3
  const minLogHz = 1000.0
  const minLogMel = minLogHz / fSp
  const logStep = Math.log(6.4) / 27.0
  if (mel >= minLogMel) return minLogHz * Math.exp(logStep * (mel - minLogMel))
  return fSp * mel
}

interface MelBasis {
  starts: number[]
  rows: Float32Array[]
}

const BASIS_CACHE = new Map<number, MelBasis>()

function melBasis(sr: number): MelBasis {
  const cached = BASIS_CACHE.get(sr)
  if (cached) return cached

  const binCount = 1 + Math.floor(N_FFT / 2)
  const fftfreqs: number[] = []
  for (let k = 0; k < binCount; k++) fftfreqs.push((k * sr) / N_FFT)

  const points = N_MELS + 2
  const minMel = hzToMel(0)
  const maxMel = hzToMel(0.5 * sr)
  const melF: number[] = []
  for (let i = 0; i < points; i++) {
    const mel = i === points - 1 ? maxMel : minMel + ((maxMel - minMel) * i) / (points - 1)
    melF.push(melToHz(mel))
  }

  const starts: number[] = []
  const rows: Float32Array[] = []
  for (let i = 0; i < N_MELS; i++) {
    const fdiffLo = melF[i + 1] - melF[i]
    const fdiffHi = melF[i + 2] - melF[i + 1]
    const enorm = 2.0 / (melF[i + 2] - melF[i])
    const row: number[] = []
    let first = -1
    for (let k = 0; k < binCount; k++) {
      const lower = (fftfreqs[k] - melF[i]) / fdiffLo
      const upper = (melF[i + 2] - fftfreqs[k]) / fdiffHi
      const weight = Math.fround(Math.max(0, Math.min(lower, upper)) * enorm)
      if (weight !== 0 && first === -1) first = k
      if (first !== -1) row.push(weight)
    }
    starts.push(first === -1 ? 0 : first)
    rows.push(Float32Array.from(row))
  }
  const basis = { starts, rows }
  BASIS_CACHE.set(sr, basis)
  return basis
}

export function onsetStrength(y: Float32Array, sr: number): Float32Array {
  const n = y.length
  const frames = 1 + Math.floor(n / HOP_LENGTH)
  const binCount = 1 + Math.floor(N_FFT / 2)
  const basis = melBasis(sr)
  const window = hannPeriodic(N_FFT)

  const db = new Float32Array(N_MELS * frames)
  const power = new Float64Array(binCount)
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  let peak = -Infinity
  for (let t = 0; t < frames; t++) {
    re.fill(0)
    im.fill(0)
    for (let k = 0; k < N_FFT; k++) {
      const s = t * HOP_LENGTH + k - Math.floor(N_FFT / 2)
      re[k] = s < 0 || s >= n ? 0 : y[s] * window[k]
    }
    fft(re, im, false)
    for (let k = 0; k < binCount; k++) power[k] = Math.fround(re[k] * re[k] + im[k] * im[k])
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0
      const row = basis.rows[m]
      const offset = basis.starts[m]
      for (let j = 0; j < row.length; j++) acc += row[j] * power[offset + j]
      const value = Math.fround(10 * Math.log10(Math.max(AMIN, Math.fround(acc))))
      db[m * frames + t] = value
      if (value > peak) peak = value
    }
  }

  const floor = Math.fround(peak - TOP_DB)
  for (let i = 0; i < db.length; i++) if (db[i] < floor) db[i] = floor

  const diff = new Float32Array(N_MELS)
  const raw = new Float32Array(Math.max(0, frames - LAG))
  for (let t = LAG; t < frames; t++) {
    for (let m = 0; m < N_MELS; m++) {
      const delta = Math.fround(db[m * frames + t] - db[m * frames + t - LAG])
      diff[m] = delta > 0 ? delta : 0
    }
    raw[t - LAG] = medianFloat32(diff)
  }

  const env = new Float32Array(frames)
  const padWidth = LAG + Math.floor(N_FFT / (2 * HOP_LENGTH))
  for (let t = padWidth; t < frames; t++) env[t] = raw[t - padWidth]
  return env
}

function meanTempogram(env: Float32Array, sr: number): Float64Array {
  const win = Math.floor((AC_SIZE * sr) / HOP_LENGTH)
  const half = Math.floor(win / 2)
  const n = env.length

  const padded = new Float64Array(n + 2 * half)
  for (let i = 0; i < padded.length; i++) {
    if (i < half) padded[i] = (env[0] * i) / half
    else if (i >= n + half) padded[i] = (env[n - 1] * (n + 2 * half - 1 - i)) / half
    else padded[i] = env[i - half]
  }

  const acWindow = hannPeriodic(win)
  const nPad = nextPowerOfTwo(2 * win - 1)
  const re = new Float64Array(nPad)
  const im = new Float64Array(nPad)
  const mean = new Float64Array(win)

  for (let t = 0; t < n; t++) {
    re.fill(0)
    im.fill(0)
    for (let l = 0; l < win; l++) re[l] = padded[t + l] * acWindow[l]
    fft(re, im, false)
    for (let k = 0; k < nPad; k++) {
      const p = re[k] * re[k] + im[k] * im[k]
      re[k] = p
      im[k] = 0
    }
    fft(re, im, true)

    let peak = 0
    for (let l = 0; l < win; l++) {
      const magnitude = Math.abs(re[l])
      if (magnitude > peak) peak = magnitude
    }
    const divisor = Math.max(peak, NORMALIZE_TINY)
    for (let l = 0; l < win; l++) mean[l] += re[l] / divisor
  }
  for (let l = 0; l < win; l++) mean[l] /= n
  return mean
}

export function beatTempo(env: Float32Array, sr: number): number {
  let silent = true
  for (let t = 0; t < env.length; t++) if (env[t] !== 0) silent = false
  if (silent) return 0.0

  const win = Math.floor((AC_SIZE * sr) / HOP_LENGTH)
  const tg = meanTempogram(env, sr)

  const bpms = new Float64Array(win)
  bpms[0] = Infinity
  for (let lag = 1; lag < win; lag++) bpms[lag] = (60.0 * sr) / (HOP_LENGTH * lag)

  const logprior = new Float64Array(win)
  for (let lag = 0; lag < win; lag++) {
    logprior[lag] = -0.5 * Math.pow((Math.log2(bpms[lag]) - Math.log2(START_BPM)) / STD_BPM, 2)
  }
  let maxIdx = win
  for (let lag = 0; lag < win; lag++) {
    if (bpms[lag] < MAX_TEMPO) {
      maxIdx = lag
      break
    }
  }
  for (let lag = 0; lag < maxIdx; lag++) logprior[lag] = -Infinity

  let best = 0
  let bestScore = -Infinity
  for (let lag = 0; lag < win; lag++) {
    const value = Math.log1p(1e6 * tg[lag]) + logprior[lag]
    if (value > bestScore) {
      bestScore = value
      best = lag
    }
  }
  return bpms[best]
}

export function rmsLevel(y: Float32Array): number {
  if (!y.length) return NaN
  let acc = 0
  for (let i = 0; i < y.length; i++) acc += Math.fround(y[i] * y[i])
  return Math.fround(Math.sqrt(Math.fround(acc / y.length)))
}

export function zeroCrossingRate(y: Float32Array): number {
  const n = y.length
  if (!n) {
    throw new PythonError(
      'ValueError',
      'zero-size array to reduction operation maximum which has no identity'
    )
  }
  const pad = Math.floor(ZCR_FRAME / 2)
  const frames = 1 + Math.floor(n / ZCR_HOP)
  let total = 0
  for (let t = 0; t < frames; t++) {
    let count = 0
    let previous = false
    for (let i = 0; i < ZCR_FRAME; i++) {
      const source = Math.min(Math.max(t * ZCR_HOP + i - pad, 0), n - 1)
      const value = y[source]
      const negative = Math.abs(value) > ZCR_THRESHOLD && value < 0
      if (i > 0 && negative !== previous) count++
      previous = negative
    }
    total += count / ZCR_FRAME
  }
  return total / frames
}

export function acousticProfile(raw: Buffer): string {
  const { y, sr } = loadAudio(raw)
  const dur = sr ? y.length / sr : 0
  const rms = rmsLevel(y)
  const zcr = zeroCrossingRate(y)
  const tempo = beatTempo(onsetStrength(y, sr), sr)
  return (
    `Librosa Acoustic Profile: Duration=${pyFormatFixed(dur, 2)}s | SR=${sr}Hz | ` +
    `RMS Energy=${pyFormatFixed(rms, 4)} | ZeroCrossingRate=${pyFormatFixed(zcr, 4)} | ` +
    `Tempo=${pyFormatFixed(tempo, 1)} BPM`
  )
}
