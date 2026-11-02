import { lstat, readdir, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { PythonError } from '../../shared/utils/exceptions'

function escapeLiteral(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/u.test(ch) ? `\\${ch}` : ch
}

export function fnmatchTranslateSegment(pat: string, star: string, questionMark: string): string[] {
  const res: string[] = []
  let i = 0
  const n = pat.length
  while (i < n) {
    const c = pat[i] as string
    i += 1
    if (c === '*') {
      if (res.length === 0 || res[res.length - 1] !== star) res.push(star)
    } else if (c === '?') {
      res.push(questionMark)
    } else if (c === '[') {
      let j = i
      if (j < n && pat[j] === '!') j += 1
      if (j < n && pat[j] === ']') j += 1
      while (j < n && pat[j] !== ']') {
        if (pat[j] === '\\') j += 1
        j += 1
      }
      if (j >= n) {
        res.push('\\\\[')
        continue
      }
      const from = i
      let stuff = pat.slice(from, j)
      i = j + 1
      if (!stuff.includes('-')) {
        stuff = stuff.replaceAll('\\', '\\\\')
      } else {
        const chunks: string[] = []
        let start = from
        let k = pat[from] === '!' ? from + 2 : from + 1
        for (;;) {
          const at = pat.indexOf('-', k)
          if (at < 0 || at >= j) break
          chunks.push(pat.slice(start, at))
          start = at + 1
          k = at + 3
        }
        const chunk = pat.slice(start, j)
        if (chunk) chunks.push(chunk)
        else chunks[chunks.length - 1] += '-'
        for (let m = chunks.length - 1; m > 0; m--) {
          if (chunks[m - 1][chunks[m - 1].length - 1] > chunks[m][0]) {
            chunks[m - 1] = chunks[m - 1].slice(0, -1) + chunks[m].slice(1)
            chunks.splice(m, 1)
          }
        }
        stuff = chunks.map((part) => part.replaceAll('\\', '\\\\').replaceAll('-', '\\-')).join('-')
      }
      stuff = stuff.replace(/[&~|]/gu, '\\$&')
      if (!stuff) res.push('(?!)')
      else if (stuff === '!') res.push('[\\s\\S]')
      else {
        if (stuff[0] === '!') stuff = `^${stuff.slice(1)}`
        else if (stuff[0] === '^' || stuff[0] === '[') stuff = `\\${stuff}`
        res.push(`[${stuff}]`)
      }
    } else {
      res.push(escapeLiteral(c))
    }
  }
  return res
}

const ANY_SEP = '\\\\'
const NOT_SEP = '[^\\\\]'
const ONE_LAST_SEGMENT = `${NOT_SEP}+`
const ONE_SEGMENT = `${ONE_LAST_SEGMENT}${ANY_SEP}`
const ANY_SEGMENTS = `(?:[\\s\\S]+${ANY_SEP})?`
const ANY_LAST_SEGMENTS = '[\\s\\S]*'

export function globTranslate(pat: string): string {
  const parts = pat.split('\\')
  const last = parts.length - 1
  const results: string[] = []
  parts.forEach((part, idx) => {
    if (part === '*') {
      results.push(idx < last ? ONE_SEGMENT : ONE_LAST_SEGMENT)
    } else if (part === '**') {
      if (idx < last) {
        if (parts[idx + 1] !== '**') results.push(ANY_SEGMENTS)
      } else results.push(ANY_LAST_SEGMENTS)
    } else {
      if (part) results.push(...fnmatchTranslateSegment(part, `${NOT_SEP}*`, NOT_SEP))
      if (idx < last) results.push(ANY_SEP)
    }
  })
  return `^(?:${results.join('')})$`
}

const compiled = new Map<string, RegExp>()

function compileGlob(pat: string): RegExp {
  let re = compiled.get(pat)
  if (!re) {
    re = new RegExp(globTranslate(pat), 'i')
    compiled.set(pat, re)
  }
  return re
}

type Matcher = (text: string, pos: number) => boolean

function compileMatcher(pat: string): Matcher {
  const re = compileGlob(pat)
  return (text, pos) => {
    re.lastIndex = 0
    return re.test(pos === 0 ? text : text.slice(pos))
  }
}

const MAGIC_CHECK = /[*?[]/u

const SPECIAL_PARTS = ['', '.', '..']

type Selector = (path: string, exists: boolean) => AsyncGenerator<string>

class Globber {
  selector(parts: string[]): Selector {
    if (parts.length === 0) return selectExists
    const part = parts.pop() as string
    if (part === '**') return this.recursiveSelector(part, parts)
    if (SPECIAL_PARTS.includes(part)) return this.specialSelector(part, parts)
    if (!MAGIC_CHECK.test(part)) return this.literalSelector(part, parts)
    return this.wildcardSelector(part, parts)
  }

  private specialSelector(part: string, parts: string[]): Selector {
    const selectNext = this.selector(parts)
    return async function* (path, exists) {
      yield* selectNext(addSlash(path) + part, exists)
    }
  }

  private literalSelector(part: string, parts: string[]): Selector {
    while (parts.length > 0 && !MAGIC_CHECK.test(parts[parts.length - 1])) {
      part += `\\${parts.pop() as string}`
    }
    const selectNext = this.selector(parts)
    return async function* (path) {
      yield* selectNext(addSlash(path) + part, false)
    }
  }

  private wildcardSelector(part: string, parts: string[]): Selector {
    const match = part === '*' ? null : compileMatcher(part)
    const dirOnly = parts.length > 0
    const selectNext = dirOnly ? this.selector(parts) : null
    return async function* (path) {
      const entries = await scandir(path)
      if (entries === null) return
      for (const entry of entries) {
        if (match !== null && !match(entry.name, 0)) continue
        const full = childPath(path, entry.name)
        if (!dirOnly) {
          yield full
          continue
        }
        if (!isDirNoFollow(entry)) continue
        yield* (selectNext as Selector)(full, true)
      }
    }
  }

  private recursiveSelector(first: string, parts: string[]): Selector {
    while (parts.length > 0 && parts[parts.length - 1] === '**') parts.pop()
    let part = first
    while (parts.length > 0 && !SPECIAL_PARTS.includes(parts[parts.length - 1])) {
      part += `\\${parts.pop() as string}`
    }
    const match = part === '**' ? null : compileMatcher(part)
    const dirOnly = parts.length > 0
    const selectNext = this.selector(parts)

    return async function* (path, exists) {
      const base = addSlash(path)
      const matchPos = base.length
      if (match === null || match(base, matchPos)) yield* selectNext(base, exists)
      const stack: string[] = [base]
      while (stack.length > 0) {
        const current = stack.pop() as string
        const entries = await scandir(current)
        if (entries === null) continue
        for (const entry of entries) {
          const full = childPath(current, entry.name)
          const isDir = await isDirFollowed(full, entry)
          if (isDir || !dirOnly) {
            if (match === null || match(full, matchPos)) {
              if (dirOnly) yield* selectNext(full, true)
              else yield full
            }
          }
          if (isDir) stack.push(full)
        }
      }
    }
  }
}

async function* selectExists(path: string, exists: boolean): AsyncGenerator<string> {
  if (exists) {
    yield path
    return
  }
  try {
    await lstat(path)
    yield path
  } catch {}
}

async function scandir(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return null
  }
}

function isDirNoFollow(entry: Dirent): boolean {
  return entry.isDirectory()
}

async function isDirFollowed(full: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await stat(full)).isDirectory()
  } catch {
    return false
  }
}

function addSlash(path: string): string {
  const tail = ntTail(path)
  if (!tail || tail.endsWith('\\') || tail.endsWith('/')) return path
  return `${path}\\`
}

function childPath(dir: string, name: string): string {
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}\\${name}`
}

function ntTail(path: string): string {
  if (/^[A-Za-z]:/.test(path)) {
    const rest = path.slice(2)
    return rest.startsWith('\\') || rest.startsWith('/') ? rest.slice(1) : rest
  }
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const after = path.slice(2)
    const serverEnd = after.search(/[/\\]/u)
    if (serverEnd === -1) return ''
    const shareEnd = after.slice(serverEnd + 1).search(/[/\\]/u)
    if (shareEnd === -1) return ''
    return after.slice(serverEnd + 1 + shareEnd + 1)
  }
  if (path.startsWith('\\') || path.startsWith('/')) return path.slice(1)
  return path
}

function ntRootOf(pattern: string): string {
  const drive = /^[A-Za-z]:[/\\]/.exec(pattern)
  if (drive) return drive[0]
  if (pattern.startsWith('\\') || pattern.startsWith('/')) return pattern[0]
  return ''
}

function reverseParts(pattern: string): string[] {
  const names: string[] = []
  let path = pattern
  for (;;) {
    const [parent, name] = ntSplit(path)
    if (parent === path) break
    names.push(name)
    path = parent
  }
  return names
}

function ntSplit(path: string): [string, string] {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (index === -1) return ['', path]
  return [path.slice(0, index).replace(/[/\\]+$/u, ''), path.slice(index + 1)]
}

export async function* pyGlob(root: string, pattern: string): AsyncGenerator<string> {
  if (ntRootOf(pattern)) {
    throw new PythonError('NotImplementedError', 'Non-relative patterns are unsupported')
  }
  yield* new Globber().selector(reverseParts(pattern))(root, false)
}
