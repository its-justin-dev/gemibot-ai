export function pyKey<T = unknown>(data: unknown, key: string): T {
  if (typeof data !== 'object' || data === null || !(key in data)) {
    throw new TypeError(`KeyError: '${key}'`)
  }
  return (data as Record<string, T>)[key]
}

export function pyGet<T>(data: unknown, key: string, fallback: T): T | null {
  if (typeof data !== 'object' || data === null || !(key in data)) return fallback
  return (data as Record<string, T | null>)[key]
}
