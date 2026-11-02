import { readdir, readFile, stat } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'

import { AppConstants } from '../../shared/constants/app-constants'

const SKIP_DIRS = new Set([...AppConstants.IGNORED, '.gemibot', 'coverage', 'test-results', 'artifacts'])
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.json', '.css', '.scss', '.html',
  '.md', '.toml', '.yaml', '.yml', '.env', '.example', '.sql', '.txt', '.ini', '.cfg', '.sh'
])

interface SymbolEntry {
  path: string
  symbols: string[]
}

function normalizeRel(rel: string): string {
  return rel.replaceAll('\\', '/').replace(/^\.\/+/u, '')
}

function isInside(root: string, candidate: string): boolean {
  const base = resolve(root)
  const full = resolve(candidate)
  const lowerBase = base.toLowerCase().replace(/[\\/]+$/u, '')
  const lowerFull = full.toLowerCase()
  return lowerFull === lowerBase || lowerFull.startsWith(`${lowerBase}${sep}`)
}

function extractSymbols(text: string): string[] {
  const symbols: string[] = []
  const add = (value: string): void => {
    const clean = value.trim()
    if (clean !== '' && !symbols.includes(clean)) symbols.push(clean)
  }
  for (const match of text.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu
  )) {
    add(match[1])
  }
  for (const match of text.matchAll(/export\s*\{([^}]+)\}/gu)) {
    for (const part of match[1].split(',')) add(part.trim().split(/\s+as\s+/u).pop() ?? '')
  }
  for (const match of text.matchAll(
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gmu
  )) {
    add(match[1])
  }
  for (const match of text.matchAll(/^\s*class\s+([A-Za-z_][\w]*)\s*[:(]?/gmu)) {
    add(match[1])
  }
  for (const match of text.matchAll(
    /(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gu
  )) {
    add(`ROUTE ${match[1]}`)
  }
  for (const match of text.matchAll(/@(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gu)) {
    add(`ROUTE ${match[1]}`)
  }
  return symbols.slice(0, 12)
}

export class BuildRepoMapService {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private async walk(
    directory: string,
    depth: number,
    maxDepth: number,
    limit: number,
    results: string[]
  ): Promise<void> {
    if (depth > maxDepth || results.length >= limit) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (results.length >= limit) return
      if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await this.walk(full, depth + 1, maxDepth, limit, results)
      } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name).toLowerCase())) {
        results.push(full)
      }
    }
  }

  async files(limit = 300): Promise<string[]> {
    const full: string[] = []
    await this.walk(this.root, 0, 6, limit, full)
    return full.map((path) => normalizeRel(path.slice(this.root.length).replace(/^[\\/]+/u, '')))
  }

  /** Compact tree plus exported symbols; bounded so it is safe to put in every build prompt. */
  async map(limit = 300): Promise<string> {
    const files = await this.files(limit)
    if (files.length === 0) return '(empty project)'
    const entries: SymbolEntry[] = []
    for (const rel of files) {
      const full = join(this.root, rel)
      try {
        const info = await stat(full)
        if (info.size > 200_000) {
          entries.push({ path: rel, symbols: ['(large file)'] })
          continue
        }
        const text = await readFile(full, 'utf8')
        if (text.slice(0, 4_000).includes('\u0000')) {
          entries.push({ path: rel, symbols: [] })
          continue
        }
        entries.push({ path: rel, symbols: extractSymbols(text) })
      } catch {
        entries.push({ path: rel, symbols: [] })
      }
    }
    const lines = ['Files (relative to target root):']
    for (const entry of entries) {
      lines.push(
        entry.symbols.length > 0 ? `${entry.path}: ${entry.symbols.join(', ')}` : entry.path
      )
    }
    const text = lines.join('\n')
    return text.length > 24_000 ? `${text.slice(0, 24_000)}\n[... repository map truncated]` : text
  }

  async readRelevant(
    paths: string[],
    maxPerFile = 12_000,
    maxTotal = 30_000
  ): Promise<Array<{ path: string; content: string }>> {
    const files: Array<{ path: string; content: string }> = []
    let total = 0
    for (const raw of paths) {
      if (total >= maxTotal) break
      const rel = normalizeRel(raw)
      if (rel === '' || rel.includes('..')) continue
      const full = join(this.root, rel)
      if (!isInside(this.root, full)) continue
      try {
        const info = await stat(full)
        if (!info.isFile() || info.size > 500_000) continue
        const text = await readFile(full, 'utf8')
        if (text.slice(0, 4_000).includes('\u0000')) continue
        const room = Math.min(maxPerFile, maxTotal - total)
        const content = text.length > room ? `${text.slice(0, room)}\n[... clipped]` : text
        files.push({ path: rel, content })
        total += content.length
      } catch {
        /* a missing file is expected for a task that creates it */
      }
    }
    return files
  }
}
