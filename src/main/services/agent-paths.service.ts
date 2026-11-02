import { ToolError } from '../../shared/utils/exceptions'
import { pyPathPartsFull } from '../../shared/utils/py-path'
import { pyLstripChars, pyStrip, pyStripChars } from '../../shared/utils/pystr'
import { pyIsAbsolute, pyResolve, toPosix } from '../utils/fs-path'
import { realpath } from 'fs/promises'
import { basename, dirname, resolve as nativeResolve, win32 } from 'path'

function partsWithin(base: string, candidate: string): boolean {
  const cand = pyPathPartsFull(candidate).map((part) => part.toLowerCase())
  const targ = pyPathPartsFull(base).map((part) => part.toLowerCase())
  if (cand.length < targ.length) return false
  return targ.every((part, index) => part === cand[index])
}

export class AgentPaths {
  root: string

  constructor(root: string) {
    this.root = pyResolve(root)
  }

  setRoot(root: string): void {
    this.root = pyResolve(root)
  }

  isWithinTarget(candidatePath: string): boolean {
    try {
      return partsWithin(this.root, pyResolve(candidatePath))
    } catch {
      return false
    }
  }

  /**
   * Lexical containment alone lets a symlink or junction inside the root point anywhere on disk,
   * so every path handed to a tool is also checked after resolving links. A path that does not
   * exist yet is checked through its nearest existing ancestor.
   */
  private async physicallyWithin(candidatePath: string): Promise<boolean> {
    try {
      const realRoot = await realpath(this.root)
      let probe = candidatePath
      const missing: string[] = []
      for (;;) {
        try {
          const real = await realpath(probe)
          const target = missing.length === 0 ? real : nativeResolve(real, ...missing)
          return partsWithin(realRoot, target)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTDIR') return false
          const parent = dirname(probe)
          if (parent === probe) return false
          missing.unshift(basename(probe))
          probe = parent
        }
      }
    } catch {
      return false
    }
  }

  async resolve(path: string | null | undefined): Promise<string> {
    const rawPath = pyStripChars(pyStrip(String(path || '.')), '\'"')
    const cleaned = pyLstripChars(rawPath, '/\\')

    const candidate = pyIsAbsolute(rawPath) ? pyResolve(rawPath) : pyResolve(rawPath, this.root)
    if (this.isWithinTarget(candidate) && (await this.physicallyWithin(candidate))) return candidate

    const full = pyResolve(cleaned, this.root)
    if (this.isWithinTarget(full) && (await this.physicallyWithin(full))) return full

    throw new ToolError(
      `Access denied: Path '${path}' escapes the active target directory.\n` +
        `Active target directory: ${this.root}\n` +
        'All operations must remain strictly inside the target folder.'
    )
  }

  rel(fullPath: string): string {
    try {
      const fullP = pyResolve(fullPath)
      if (this.isWithinTarget(fullP)) return toPosix(win32.relative(this.root, fullP)) || '.'
      return fullP
    } catch {
      return String(fullPath)
    }
  }
}
