import { homedir } from 'os'
import { isAbsolute, resolve as nativeResolve, win32 } from 'path'
import { mkdir } from 'fs/promises'

export function pyExpandUser(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return nativeResolve(homedir(), path.slice(2))
  return path
}

export function pyResolve(path: string, cwd?: string): string {
  return nativeResolve(cwd ?? process.cwd(), path)
}

export function pyIsAbsolute(path: string): boolean {
  return isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)
}

export function pyRelativePath(fullPath: string, root: string): string {
  if (fullPath === root) return '.'
  const rel = win32.relative(root, fullPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return toPosix(fullPath)
  return toPosix(rel)
}

export function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

export function pyPathName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const last = cut === -1 ? trimmed : trimmed.slice(cut + 1)
  return /^[a-zA-Z]:$/u.test(last) ? '' : last
}

export function pyParent(path: string): string {
  return win32.dirname(path)
}

export async function pyMkdirExistOk(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}
