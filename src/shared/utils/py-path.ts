import { pyStrip } from './pystr'

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[/\\]/
const UNC_ROOT_RE = /^[/\\][/\\][^/\\]+[/\\][^/\\]+/

export function pyNormalizeRelPath(path: string): string {
  let clean = pyStrip(String(path).replaceAll('\\', '/'))
  while (clean.startsWith('./')) clean = clean.slice(2)
  return clean.replace(/^\/+|\/+$/g, '') || '.'
}

function splitAnchor(path: string): [string | null, string] {
  const rest = String(path)
  const drive = WINDOWS_DRIVE_RE.exec(rest)
  if (drive) return [`${rest.slice(0, 2)}\\`, rest.slice(2)]
  const unc = UNC_ROOT_RE.exec(rest)
  if (unc) return [`${unc[0]}\\`, rest.slice(unc[0].length)]
  if (rest.startsWith('/') || rest.startsWith('\\')) return [rest[0], rest.slice(1)]
  return [null, rest]
}

function pathComponents(rest: string): string[] {
  return rest.split(/[/\\]+/).filter((part) => part !== '' && part !== '.')
}

export function pyPathPartsFull(path: string): string[] {
  const [anchor, rest] = splitAnchor(path)
  const parts = pathComponents(rest)
  return anchor === null ? parts : [anchor, ...parts]
}

export function pyPathParts(path: string): string[] {
  return pathComponents(splitAnchor(path)[1])
}

export function pyPathName(path: string): string {
  const parts = pyPathParts(path)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

export function pyPathSuffix(path: string): string {
  const name = pyPathName(path)
  const at = name.lastIndexOf('.')
  return at > 0 && at < name.length - 1 ? name.slice(at) : ''
}

export function pyPathStem(path: string): string {
  const name = pyPathName(path)
  return name.slice(0, name.length - pyPathSuffix(path).length)
}
