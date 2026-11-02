import { mkdir, stat } from 'fs/promises'
import { dirname } from 'path'

import { PythonError } from '../../shared/utils/exceptions'

export function fileNotFound(path: string): PythonError {
  return new PythonError('FileNotFoundError', `[Errno 2] No such file or directory: '${path}'`)
}

export function statNotFoundWinError2(path: string): PythonError {
  return new PythonError(
    'FileNotFoundError',
    `[WinError 2] The system cannot find the file specified: '${path}'`
  )
}

export function diskUsageNotFound(path: string): PythonError {
  return new PythonError(
    'FileNotFoundError',
    `[WinError 3] The system cannot find the path specified: '${path}'`
  )
}

export function permissionDenied(path: string): PythonError {
  return new PythonError('PermissionError', `[Errno 13] Permission denied: '${path}'`)
}

export function fileExistsWin183(path: string): PythonError {
  return new PythonError(
    'FileExistsError',
    `[WinError 183] Cannot create a file when that file already exists: '${path}'`
  )
}

export function osError(error: unknown, path: string): PythonError {
  const failure = error as NodeJS.ErrnoException | null
  const at = typeof failure?.path === 'string' && failure.path !== '' ? failure.path : path
  const code = failure?.code
  if (code === 'ENOENT') return fileNotFound(at)
  if (code === 'EEXIST') return fileExistsWin183(at)
  return permissionDenied(at)
}

export async function mkdirParents(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    return
  } catch {}
  let current = dir
  for (;;) {
    const info = await stat(current).catch(() => null)
    if (info && !info.isDirectory()) throw fileExistsWin183(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw fileNotFound(dir)
}
