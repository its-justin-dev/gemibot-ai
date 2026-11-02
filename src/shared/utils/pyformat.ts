const pow5Cache = /* @__PURE__ */ new Map<number, bigint>()

function pow5(exponent: number): bigint {
  const cached = pow5Cache.get(exponent)
  if (cached !== undefined) return cached
  let value: bigint
  if (exponent === 0) value = 1n
  else if (exponent === 1) value = 5n
  else {
    const half = pow5(exponent >> 1)
    value = exponent % 2 === 0 ? half * half : half * half * 5n
  }
  pow5Cache.set(exponent, value)
  return value
}

function exactDigits(value: number): { digits: string; decpt: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  const rawExp = Number((bits >> 52n) & 0x7ffn)
  const rawMant = bits & ((1n << 52n) - 1n)
  if (rawExp === 0 && rawMant === 0n) return { digits: '0', decpt: 1 }

  let m: bigint
  let e: number
  if (rawExp === 0) {
    m = rawMant
    e = -1074
  } else {
    m = rawMant | (1n << 52n)
    e = rawExp - 1075
  }

  if (e >= 0) {
    const digits = (m << BigInt(e)).toString()
    return { digits, decpt: digits.length }
  }
  const digits = (m * pow5(-e)).toString()
  return { digits, decpt: digits.length + e }
}

function addOne(digits: string): string {
  const out = digits.split('')
  let i = out.length - 1
  for (; i >= 0; i--) {
    if (out[i] !== '9') break
    out[i] = '0'
  }
  if (i < 0) return `1${out.join('')}`
  out[i] = String(Number(out[i]) + 1)
  return out.join('')
}

export function pyFormatFixed(value: number, precision: number): string {
  if (Number.isNaN(value)) return 'nan'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  const negative = value < 0 || Object.is(value, -0)
  const { digits, decpt } = exactDigits(negative ? -value : value)

  const intPart = decpt > 0 ? digits.padEnd(decpt, '0').slice(0, decpt) : '0'
  const fracPart = decpt > 0 ? digits.slice(decpt) : '0'.repeat(-decpt) + digits

  const keep = fracPart.slice(0, precision).padEnd(precision, '0')
  const rest = fracPart.slice(precision)

  let rounded = keep
  let whole = intPart
  let carry = false
  if (rest.length > 0) {
    const leading = rest.charCodeAt(0) - 48
    const tail = /[1-9]/u.test(rest.slice(1))
    if (leading > 5 || (leading === 5 && tail)) carry = true
    else if (leading === 5) {
      const lastDigit =
        rounded.length > 0 ? Number(rounded[rounded.length - 1]) : Number(whole[whole.length - 1])
      carry = lastDigit % 2 === 1
    }
  }
  if (carry) {
    if (rounded.length > 0) {
      const summed = addOne(rounded)
      if (summed.length > rounded.length) {
        whole = addOne(intPart)
        rounded = '0'.repeat(precision)
      } else rounded = summed
    } else whole = addOne(intPart)
  }

  const body = precision > 0 ? `${whole}.${rounded}` : whole
  return negative ? `-${body}` : body
}

export function pyFormatThousands(value: number | bigint): string {
  const text = typeof value === 'bigint' ? value.toString() : String(value)
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return negative ? `-${grouped}` : grouped
}

export function pyFormatIntWidth(value: number | bigint, width: number, zero = false): string {
  const text = typeof value === 'bigint' ? value.toString() : String(value)
  if (text.length >= width) return text
  const pad = width - text.length
  if (!zero) return ' '.repeat(pad) + text
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const padded = '0'.repeat(pad) + digits
  return negative ? `-${padded}` : padded
}

export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value
  return Number(pyFormatFixed(value, digits))
}
