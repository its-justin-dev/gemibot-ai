export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value instanceof Map || value instanceof Set) return value.size > 0
  return true
}

export function pyOr(value: unknown, fallback: unknown): unknown {
  return pyTruthy(value) ? value : fallback
}
