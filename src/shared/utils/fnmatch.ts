const CURRENT_PLATFORM: string =
  (globalThis as { process?: { platform?: string } }).process?.platform ?? 'win32'

export function normcase(p: string): string {
  return CURRENT_PLATFORM === 'win32' ? p.replaceAll('/', '\\').toLowerCase() : p
}

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function fnmatchTranslate(pattern: string): string {
  let res = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const c = pattern[i]
    i += 1
    if (c === '*') {
      while (pattern[i] === '*') i += 1
      res += '[\\s\\S]*'
    } else if (c === '?') {
      res += '[\\s\\S]'
    } else if (c === '[') {
      let j = i
      if (j < n && pattern[j] === '!') j += 1
      if (j < n && pattern[j] === ']') j += 1
      while (j < n && pattern[j] !== ']') {
        if (pattern[j] === '\\') j += 1
        j += 1
      }
      if (j >= n) {
        res += '\\['
      } else {
        const stuff = pattern.slice(i, j).replace(/\\/g, '\\\\')
        i = j + 1
        const negate = stuff.startsWith('!')
        const body = (negate ? stuff.slice(1) : stuff).replace(/\]/g, '\\]')
        res += negate ? `[^${body}]` : `[${body}]`
      }
    } else if (c === '\\') {
      if (i >= n) res += '\\\\'
      else {
        res += escapeRe(pattern[i])
        i += 1
      }
    } else {
      res += escapeRe(c)
    }
  }
  return `^(?:${res})$`
}

const cache = new Map<string, RegExp>()

function compilePattern(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (!re) {
    re = new RegExp(fnmatchTranslate(pattern), 'u')
    cache.set(pattern, re)
  }
  return re
}

export function fnmatch(name: string, pattern: string): boolean {
  if (!name) return false
  return compilePattern(normcase(pattern)).test(normcase(name))
}

export function fnmatchCase(name: string, pattern: string): boolean {
  return compilePattern(pattern).test(name)
}

export function fnmatchFilter(names: string[], pattern: string): string[] {
  const re = compilePattern(normcase(pattern))
  return names.filter((name) => re.test(normcase(name)))
}
