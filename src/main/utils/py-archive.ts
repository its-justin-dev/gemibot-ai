import { gunzipSync, gzipSync } from 'zlib'
import { lstat, readFile, readdir, stat, writeFile } from 'fs/promises'
import { win32 } from 'path'

import { PythonError } from '../../shared/utils/exceptions'
import { pyPathPartsFull } from '../../shared/utils/py-path'
import { pyRepr } from '../../shared/utils/pyrepr'
import { pyCompare } from '../../shared/utils/pystr'

export const ZIP_DEFLATED = 8

export function isIgnoredPath(full: string, ignored: ReadonlySet<string>): boolean {
  return pyPathPartsFull(full).some((part) => ignored.has(part))
}

export async function rglobFiles(dir: string, ignored: ReadonlySet<string>): Promise<string[]> {
  const directories = await iterateDirectories(dir)
  const out: string[] = []
  for (const current of directories) {
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = win32.join(current, name)
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (isIgnoredPath(full, ignored)) continue
      out.push(full)
    }
  }
  return out
}

async function iterateDirectories(dir: string): Promise<string[]> {
  const out = [dir]
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = win32.join(dir, entry.name)
    if ((await lstat(full)).isSymbolicLink()) continue
    out.push(...(await iterateDirectories(full)))
  }
  return out
}

export function zipArcName(name: string): string {
  let arc = splitRoot(name).tail
  arc = win32.normalize(arc)
  while (arc.startsWith('/') || arc.startsWith('\\')) arc = arc.slice(1)
  const nul = arc.indexOf('\u0000')
  if (nul >= 0) arc = arc.slice(0, nul)
  return arc.replaceAll('\\', '/')
}

function splitRoot(path: string): { drive: string; root: string; tail: string } {
  const drive = /^[a-zA-Z]:[\\/]?/.exec(path)?.[0] ?? ''
  const rest = path.slice(drive.length)
  const root = /^[\\/]/.test(rest) ? rest[0] : ''
  return { drive, root, tail: rest.slice(root.length) }
}

function sanitizeWindowsName(name: string): string {
  const translated = name.replace(/[:<>|?"*]/g, '_')
  return translated
    .split('\\')
    .map((part) => part.replace(/[ .]+$/u, ''))
    .filter((part) => part !== '')
    .join('\\')
}

export function zipExtractTarget(targetDir: string, storedName: string, isDir: boolean): string {
  let arcname = splitRoot(storedName.replaceAll('/', '\\')).tail
  arcname = sanitizeWindowsName(
    arcname
      .split('\\')
      .filter((part) => part !== '' && part !== '.' && part !== '..')
      .join('\\')
  )
  if (arcname === '' && !isDir) throw new PythonError('ValueError', 'Empty filename.')
  return win32.normalize(win32.join(targetDir, arcname))
}

export function checkZipDate(date: Date): void {
  const year = date.getFullYear()
  if (year < 1980)
    throw new PythonError('ValueError', 'ZIP does not support timestamps before 1980')
  if (year > 2107) throw new PythonError('error', "'H' format requires 0 <= number <= 65535")
}

export interface TarEntry {
  name: string
  typeflag: string
  mode: number
  mtime: number
  linkName: string
  data: Buffer
}

export async function tarTree(full: string, arcname: string): Promise<TarEntry[]> {
  const info = await statForTar(full)
  if (info.isFile) {
    return [
      {
        name: arcname,
        typeflag: '0',
        mode: info.mode,
        mtime: info.mtime,
        linkName: '',
        data: await readFile(full)
      }
    ]
  }
  const out: TarEntry[] = [
    {
      name: arcname,
      typeflag: '5',
      mode: info.mode,
      mtime: info.mtime,
      linkName: '',
      data: Buffer.alloc(0)
    }
  ]
  const names = (await readdir(full)).sort(pyCompare)
  for (const name of names) {
    out.push(...(await tarTree(win32.join(full, name), `${arcname}/${name}`)))
  }
  return out
}

async function statForTar(full: string): Promise<{ isFile: boolean; mode: number; mtime: number }> {
  const info = await stat(full)
  return {
    isFile: info.isFile(),
    mode: info.isDirectory() ? 0o777 : 0o666,
    mtime: Math.floor(info.mtimeMs / 1000)
  }
}

const BLOCK = 512

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\u0000'
}

function headerBlock(fields: {
  name: string
  mode: number
  size: number
  mtime: number
  typeflag: string
  linkname: string
}): Buffer {
  const block = Buffer.alloc(BLOCK)
  const write = (text: string, offset: number, length: number): void => {
    Buffer.from(text, 'utf8').copy(block, offset, 0, length)
  }
  write(fields.name, 0, 100)
  write(octal(fields.mode & 0o7777, 8), 100, 8)
  write(octal(0, 8), 108, 8)
  write(octal(0, 8), 116, 8)
  write(octal(fields.size, 12), 124, 12)
  write(octal(fields.mtime, 12), 136, 12)
  write('        ', 148, 8)
  block[156] = fields.typeflag.charCodeAt(0)
  write(fields.linkname, 157, 100)
  write('ustar\u0000', 257, 6)
  write('00', 263, 2)
  let sum = 0
  for (const byte of block) sum += byte
  write(octal(sum, 7).slice(0, 6) + '\u0000 ', 148, 8)
  return block
}

function paxBlock(records: [string, string][], mtime: number): Buffer {
  let body = ''
  for (const [key, value] of records) {
    const text = `${key}=${value}\n`
    let digits = String(text.length + 2).length
    for (;;) {
      const size = text.length + digits + 1
      if (String(size).length === digits) {
        body += `${size} ${text}`
        break
      }
      digits = String(size).length
    }
  }
  const data = Buffer.from(body, 'utf8')
  const header = headerBlock({
    name: './PaxHeaders.0/x',
    mode: 0o644,
    size: data.length,
    mtime,
    typeflag: 'x',
    linkname: ''
  })
  return Buffer.concat([header, pad(data)])
}

function pad(data: Buffer): Buffer {
  const rest = data.length % BLOCK
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)])
}

export async function writeTarGz(file: string, entries: TarEntry[]): Promise<void> {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data =
      entry.typeflag === '0' || entry.typeflag === '\u0000' ? entry.data : Buffer.alloc(0)
    if (name.length > 99) blocks.push(paxBlock([['path', entry.name]], entry.mtime))
    blocks.push(
      headerBlock({
        name: name.length > 99 ? entry.name.slice(0, 99) : entry.name,
        mode: entry.mode,
        size: data.length,
        mtime: entry.mtime,
        typeflag: entry.typeflag,
        linkname: entry.linkName.length > 99 ? entry.linkName.slice(0, 99) : entry.linkName
      })
    )
    if (data.length > 0) blocks.push(pad(data))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  await writeFile(file, gzipSync(Buffer.concat(blocks), { level: 9 }))
}

function tarOpenFailure(gz: string, bz2: string, xz: string, tar: string): PythonError {
  return new PythonError(
    'ReadError',
    'file could not be opened successfully:\n' +
      `- method gz: ReadError(${pyRepr(gz)})\n` +
      `- method bz2: ReadError(${pyRepr(bz2)})\n` +
      `- method xz: ReadError(${pyRepr(xz)})\n` +
      `- method tar: ReadError(${pyRepr(tar)})`
  )
}

class HeaderError extends Error {}

function nti(block: Buffer, at: number, length: number): number {
  const field = block.subarray(at, at + length)
  if (field[0] === 0o200 || field[0] === 0o377) {
    let n = 0
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]
    return field[0] === 0o377 ? -(256 ** (field.length - 1) - n) : n
  }
  const nul = field.indexOf(0)
  const raw = nul < 0 ? field : field.subarray(0, nul)
  for (const byte of raw) if (byte > 0x7f) throw new HeaderError('invalid header')
  const text = raw.toString('latin1').trim()
  const digits = /^([+-]?)(?:0o)?([0-7]+)$/iu.exec(text === '' ? '0' : text)
  if (!digits) throw new HeaderError('invalid header')
  return (digits[1] === '-' ? -1 : 1) * Number.parseInt(digits[2], 8)
}

function textField(block: Buffer, at: number, length: number): string {
  const field = block.subarray(at, at + length)
  const nul = field.indexOf(0)
  return (nul < 0 ? field : field.subarray(0, nul)).toString('utf8')
}

function calcChksums(block: Buffer): [number, number] {
  let unsigned = 256
  let signed = 256
  for (let i = 0; i < BLOCK; i++) {
    if (i >= 148 && i < 156) continue
    unsigned += block[i]
    signed += block[i] < 128 ? block[i] : block[i] - 256
  }
  return [unsigned, signed]
}

interface HeaderFields {
  name: string
  typeflag: string
  mode: number
  mtime: number
  size: number
  linkName: string
}

function fromBuf(block: Buffer, dircheck: boolean): HeaderFields {
  if (block.length === 0) throw new HeaderError('empty header')
  if (block.length !== BLOCK) throw new HeaderError('truncated header')
  if (block.every((byte) => byte === 0)) throw new HeaderError('end of file header')
  const chksum = nti(block, 148, 8)
  const sums = calcChksums(block)
  if (chksum !== sums[0] && chksum !== sums[1]) throw new HeaderError('bad checksum')
  let name = textField(block, 0, 100)
  const mode = nti(block, 100, 8)
  nti(block, 108, 8)
  nti(block, 116, 8)
  const size = nti(block, 124, 12)
  const mtime = nti(block, 136, 12)
  let typeflag = String.fromCharCode(block[156])
  const linkName = textField(block, 157, 257)
  nti(block, 329, 8)
  nti(block, 337, 8)
  const prefix = textField(block, 345, 155)
  if (dircheck && typeflag === '\u0000' && name.endsWith('/')) typeflag = '5'
  if (typeflag === '5') name = name.replace(/\/+$/u, '')
  if (prefix && typeflag !== 'L' && typeflag !== 'K' && typeflag !== 'S') name = `${prefix}/${name}`
  return { name, typeflag, mode, mtime, size, linkName }
}

function openFailure(offset: number, error: unknown): PythonError | null {
  if (!(error instanceof HeaderError)) return null
  if (error.message === 'end of file header' || offset !== 0) return null
  return new PythonError(
    'ReadError',
    error.message === 'empty header' ? 'empty file' : error.message
  )
}

interface Member {
  header: HeaderFields
  data: Buffer
  offset: number
}

function readBlocks(bytes: Buffer, at: number, dircheck: boolean): Member {
  const header = fromBuf(bytes.subarray(at, at + BLOCK), dircheck)
  const start = at + BLOCK
  return {
    header,
    data: header.typeflag === '5' ? Buffer.alloc(0) : bytes.subarray(start, start + header.size),
    offset: start + Math.ceil(header.size / BLOCK) * BLOCK
  }
}

function walkTar(bytes: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let at = 0
  let pendingLink: string | null = null
  for (;;) {
    let member: Member
    try {
      member = readBlocks(bytes, at, true)
    } catch (error) {
      const failure = openFailure(at, error)
      if (failure) throw failure
      return out
    }
    at = member.offset

    const kind = member.header.typeflag
    let records: Map<string, string> | null = null
    let nameKey: string | null = null
    let linkKey: string | null = null
    if (kind === 'L') {
      records = new Map([['path', paxText(member.data)]])
      nameKey = 'path'
    } else if (kind === 'x' || kind === 'g') {
      records = parsePax(member.data)
      nameKey = 'path'
      linkKey = 'linkpath'
    } else if (kind === 'K') {
      pendingLink = paxText(member.data)
      continue
    }
    if (records !== null) {
      try {
        member = readBlocks(bytes, at, false)
      } catch (error) {
        if (error instanceof HeaderError) throw new PythonError('ReadError', error.message)
        throw error
      }
      at = member.offset
    }
    out.push(entryOf(member.header, member.data, records, pendingLink, nameKey, linkKey))
    pendingLink = null
  }
}

function entryOf(
  header: HeaderFields,
  data: Buffer,
  records: Map<string, string> | null,
  pendingLink: string | null,
  nameKey: string | null,
  linkKey: string | null
): TarEntry {
  const path = records && nameKey ? records.get(nameKey) : undefined
  const link = records && linkKey ? records.get(linkKey) : undefined
  return {
    name: path ?? header.name,
    typeflag: header.typeflag === '\u0000' ? '0' : header.typeflag,
    mode: header.mode,
    mtime: header.mtime,
    linkName: pendingLink ?? link ?? header.linkName,
    data
  }
}

function paxText(data: Buffer): string {
  const nul = data.indexOf(0)
  return (nul < 0 ? data : data.subarray(0, nul)).toString('utf8')
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let at = 0
  while (at < data.length && data[at] !== 0x00) {
    let digits = at
    while (digits < data.length && data[digits] >= 0x30 && data[digits] <= 0x39) digits++
    if (digits === at || digits >= data.length || data[digits] !== 0x20) break
    const length = Number.parseInt(data.subarray(at, digits).toString('latin1'), 10)
    if (length < 5 || at + length > data.length || data[at + length - 1] !== 0x0a) break
    const body = data.subarray(digits + 1, at + length - 1)
    const equals = body.indexOf(0x3d)
    if (equals <= 0) break
    records.set(
      body.subarray(0, equals).toString('utf8'),
      body.subarray(equals + 1).toString('utf8')
    )
    at += length
  }
  return records
}

const GZIP_MAGIC = [0x1f, 0x8b]
const BZIP2_MAGIC = [0x42, 0x5a, 0x68]
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a]

export async function readTarMembers(file: string): Promise<TarEntry[]> {
  const raw = await readFile(file)
  let bytes = raw
  let gzError: string | null = null
  if (startsWith(raw, GZIP_MAGIC)) {
    try {
      bytes = gunzipSync(raw)
    } catch {
      throw new PythonError(
        'EOFError',
        'Compressed file ended before the end-of-stream marker was reached'
      )
    }
  } else if (startsWith(raw, BZIP2_MAGIC) || startsWith(raw, XZ_MAGIC)) {
    throw tarOpenFailure(
      'not a gzip file',
      'not a bzip2 file',
      'not an lzma file',
      'truncated header'
    )
  } else {
    gzError = raw.length === 0 ? 'empty file' : 'not a gzip file'
  }
  try {
    return walkTar(bytes)
  } catch (error) {
    if (error instanceof PythonError && error.name === 'ReadError')
      throw tarOpenFailure(
        gzError ?? error.message,
        'not a bzip2 file',
        'not an lzma file',
        error.message
      )
    throw error
  }
}

function startsWith(data: Buffer, magic: number[]): boolean {
  return magic.every((byte, i) => data[i] === byte)
}

export function ntJoin(base: string, name: string): string {
  if (name === '') return `${base}\\`
  const root = splitRoot(name)
  if (root.drive || root.root) {
    const drive = root.drive || splitRoot(base).drive
    return `${drive}${root.root || '\\'}${root.tail}`
  }
  return `${base}\\${name}`
}
