import { readFile } from 'fs/promises'

import JSZip from 'jszip'

import { PythonError } from '../../shared/utils/exceptions'

export const CONTENT_TYPES = '[Content_Types].xml'
export const ROOT_RELS = '_rels/.rels'
export const OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

export function packageNotFound(full: string): PythonError {
  return new PythonError('PackageNotFoundError', `Package not found at '${full}'`)
}

export function badZipFile(): PythonError {
  return new PythonError('BadZipFile', 'File is not a zip file')
}

export function archiveKeyError(item: string): PythonError {
  return new PythonError('KeyError', `"There is no item named '${item}' in the archive"`)
}

export function bareKeyError(key: string): PythonError {
  return new PythonError('KeyError', `'${key}'`)
}

export function noRelationship(type: string): PythonError {
  return new PythonError('KeyError', `"no relationship of type '${type}' in collection"`)
}

export function noWorkbookPart(): PythonError {
  return new PythonError('OSError', 'File contains no valid workbook part')
}

export type Archive = { zip: JSZip } | { notAZip: true }

export async function openArchive(full: string): Promise<Archive> {
  try {
    return { zip: await JSZip.loadAsync(await readFile(full)) }
  } catch {
    return { notAZip: true }
  }
}

export function hasMember(zip: JSZip, name: string): boolean {
  const entry = zip.files[name]
  return entry !== undefined && !entry.dir
}

export function memberNames(zip: JSZip): string[] {
  return Object.keys(zip.files)
}

export interface ContentTypesEntry {
  partName: string
  contentType: string
}

export async function manifest(
  zip: JSZip
): Promise<{ overrides: ContentTypesEntry[]; defaultTypes: string[] }> {
  const xml = (await zip.file(CONTENT_TYPES)?.async('string')) ?? ''
  const overrides: ContentTypesEntry[] = []
  const defaultTypes: string[] = []
  for (const match of xml.matchAll(/<(Override|Default)\b[^>]*>/gu)) {
    const attr = (name: string): string =>
      new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'u').exec(match[0])?.[1] ?? ''
    if (match[1] === 'Override')
      overrides.push({
        partName: attr('PartName').replace(/^\//u, ''),
        contentType: attr('ContentType')
      })
    else defaultTypes.push(attr('ContentType'))
  }
  return { overrides, defaultTypes }
}

export async function relationshipsOf(
  zip: JSZip,
  partName: string
): Promise<{ id: string; type: string; target: string }[]> {
  const path = partName === '' ? ROOT_RELS : `${dirOf(partName)}/_rels/${baseOf(partName)}.rels`
  const xml = await zip.file(path)?.async('string')
  if (xml === undefined) return []
  const out: { id: string; type: string; target: string }[] = []
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/gu)) {
    const tag = match[0]
    const attr = (name: string): string =>
      new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag)?.[1] ?? ''
    const mode = attr('TargetMode')
    if (mode !== '' && mode.toLowerCase() !== 'internal') continue
    out.push({
      id: attr('Id'),
      type: attr('Type'),
      target: absoluteMember(partName, attr('Target'))
    })
  }
  return out
}

function dirOf(member: string): string {
  const cut = member.lastIndexOf('/')
  return cut < 0 ? '' : member.slice(0, cut)
}

function baseOf(member: string): string {
  return member.slice(member.lastIndexOf('/') + 1)
}

export function absoluteMember(basePart: string, target: string): string {
  const joined = target.startsWith('/') ? target.slice(1) : `${dirOf(basePart)}/${target}`
  return normalizePosix(joined)
}

function normalizePosix(path: string): string {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}
