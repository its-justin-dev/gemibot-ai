import { link, readFile, stat, symlink, writeFile } from 'fs/promises'
import { dirname, win32 } from 'path'

import JSZip from 'jszip'

import { AppConstants } from '../../shared/constants/app-constants'
import { PythonError, ToolError } from '../../shared/utils/exceptions'
import { pyBytesRepr } from '../../shared/utils/pyrepr'
import { pyStr, pyStrip, pyTypeName } from '../../shared/utils/pystr'
import {
  checkZipDate,
  readTarMembers,
  rglobFiles,
  tarTree,
  writeTarGz,
  zipArcName,
  zipExtractTarget
} from '../utils/py-archive'
import { mkdirParents, osError, statNotFoundWinError2 } from '../utils/py-oserror'
import { qrPayloadBytes, qrPayloadSummary, qrPngBytes, qrSymbol } from '../utils/py-qrcode'
import { pathArg, type ToolContext, type ToolSpec } from './tool-contract'

function actionText(value: unknown): string {
  return value instanceof Uint8Array ? pyBytesRepr(value) : pyStr(value)
}

function normalizedAction(value: unknown): string | null {
  if (typeof value === 'string') return pyStrip(value.toLowerCase())
  if (value instanceof Uint8Array) return null
  throw new PythonError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'lower'`)
}

function truncateAtNul(path: string): string {
  const nul = path.indexOf('\u0000')
  return nul < 0 ? path : path.slice(0, nul)
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return info !== null && info.isFile()
}

async function raise<T>(at: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof PythonError || error instanceof ToolError) throw error
    throw osError(error, at)
  }
}

async function writeZip(
  dst: string,
  entries: { name: string; data: Buffer; date: Date }[]
): Promise<void> {
  const zip = new JSZip()
  const generate = (): Promise<Buffer> =>
    zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
  for (const entry of entries) {
    try {
      checkZipDate(entry.date)
    } catch (error) {
      await writeFile(dst, await generate())
      throw error
    }
    zip.file(entry.name, entry.data, { date: entry.date, createFolders: false })
  }
  await writeFile(dst, await generate())
}

async function extractZip(zip: JSZip, dst: string, ctx: ToolContext): Promise<void> {
  for (const key of Object.keys(zip.files)) {
    const entry = zip.files[key]
    const name = entry.unsafeOriginalName ?? key
    const isDir = name.endsWith('/')
    const target = truncateAtNul(zipExtractTarget(dst, name, isDir))
    if (isDir || entry.dir) {
      await mkdirParents(target).catch(() => undefined)
      continue
    }
    await mkdirParents(dirname(target)).catch(() => undefined)
    const data = await entry.async('nodebuffer')
    await commitExtracted(ctx, dst, target, () => writeFile(target, data))
  }
}

async function commitExtracted(
  ctx: ToolContext,
  dst: string,
  target: string,
  write: () => Promise<void>
): Promise<void> {
  if (!insideDir(dst, target)) {
    throw new PythonError('ReadError', `Member '${target}' would be extracted outside '${dst}'`)
  }
  await ctx.beginBinaryArtifact(target)
  await write()
  await notePendingArtifact(ctx, target, 'Extracted from archive')
}

/** Archives never appeared in the v1 timeline; keep the drawer/undo entry without a diff card. */
async function notePendingArtifact(
  ctx: ToolContext,
  target: string,
  summary: string
): Promise<void> {
  const rel = ctx.paths.rel(target)
  const pending = ctx.changeTracker.pendingChanges.get(ctx.changeTracker.normalizePath(rel))
  if (!pending) return
  await ctx.changeTracker.recordChange(rel, target, pending.change_type, summary, true)
}

function insideDir(parent: string, target: string): boolean {
  const rel = win32.relative(win32.resolve(parent), win32.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !win32.isAbsolute(rel)
}

async function extractTar(
  members: Awaited<ReturnType<typeof readTarMembers>>,
  dst: string,
  ctx: ToolContext
): Promise<void> {
  const written = new Set<string>()
  for (const member of members) {
    const isDir = member.typeflag === '5'
    const target = truncateAtNul(zipExtractTarget(dst, member.name, isDir))
    if (!isDir && !insideDir(dst, target)) {
      throw new PythonError(
        'ReadError',
        `Member '${member.name}' would be extracted outside '${dst}'`
      )
    }
    if (isDir) {
      await mkdirParents(target).catch(() => undefined)
      written.add(member.name)
      continue
    }
    if (member.typeflag === '2') {
      const linkTarget = win32.resolve(win32.dirname(target), member.linkName)
      if (win32.isAbsolute(member.linkName) || !insideDir(dst, linkTarget)) {
        throw new PythonError(
          'ReadError',
          `Link '${member.name}' points outside '${dst}'`
        )
      }
      await mkdirParents(dirname(target)).catch(() => undefined)
      await commitExtracted(ctx, dst, target, () => symlink(member.linkName, target))
      written.add(member.name)
      continue
    }
    if (member.typeflag === '1') {
      const source = written.has(member.linkName)
        ? truncateAtNul(zipExtractTarget(dst, member.linkName, false))
        : null
      if (!source) throw new PythonError('KeyError', `"linkname '${member.linkName}' not found"`)
      await mkdirParents(dirname(target)).catch(() => undefined)
      await commitExtracted(ctx, dst, target, () => link(source, target))
      written.add(member.name)
      continue
    }
    await mkdirParents(dirname(target)).catch(() => undefined)
    await commitExtracted(ctx, dst, target, () => writeFile(target, member.data))
    written.add(member.name)
  }
}

const archiveManage: ToolSpec = {
  python: 'tool_archive_manage',
  params: [
    { name: 'action', required: true },
    { name: 'source', required: true },
    { name: 'destination', required: true }
  ],
  run: async (ctx, args) => {
    const src = await ctx.paths.resolve(pathArg(args.source))
    const dst = await ctx.paths.resolve(pathArg(args.destination))
    if (
      !(await ctx.allowed(
        'archive_manage',
        `${actionText(args.action)}: ${ctx.paths.rel(src)} -> ${ctx.paths.rel(dst)}`
      ))
    )
      throw new ToolError('The user denied archive operation.')

    const act = normalizedAction(args.action)
    if (act === 'zip') {
      await mkdirParents(dirname(dst))
      const entries: { name: string; data: Buffer; date: Date }[] = []
      if (await isFile(src)) {
        entries.push({
          name: zipArcName(win32.basename(src)),
          data: await readFile(src),
          date: (await stat(src)).mtime
        })
      } else {
        for (const full of await rglobFiles(src, AppConstants.IGNORED))
          entries.push({
            name: zipArcName(win32.relative(src, full)),
            data: await readFile(full),
            date: (await stat(full)).mtime
          })
      }
      await ctx.beginBinaryArtifact(dst)
      await raise(dst, () => writeZip(dst, entries))
      const summary = `Created ZIP archive ${ctx.paths.rel(dst)}`
      await notePendingArtifact(ctx, dst, summary)
      return summary
    }

    if (act === 'unzip') {
      await mkdirParents(dst)
      const bytes = await raise(src, () => readFile(src))
      let zip: JSZip
      try {
        zip = await JSZip.loadAsync(bytes)
      } catch {
        throw new PythonError('BadZipFile', 'File is not a zip file')
      }
      await raise(dst, () => extractZip(zip, dst, ctx))
      return `Extracted ${ctx.paths.rel(src)} to ${ctx.paths.rel(dst)}`
    }

    if (act === 'tar') {
      await mkdirParents(dirname(dst))
      if (!(await stat(src).catch(() => null))) throw statNotFoundWinError2(src)
      const tree = await tarTree(src, zipArcName(win32.basename(src)))
      await ctx.beginBinaryArtifact(dst)
      await raise(dst, () => writeTarGz(dst, tree))
      const summary = `Created TAR.GZ archive ${ctx.paths.rel(dst)}`
      await notePendingArtifact(ctx, dst, summary)
      return summary
    }

    if (act === 'untar') {
      await mkdirParents(dst)
      const members = await raise(src, () => readTarMembers(src))
      await raise(dst, () => extractTar(members, dst, ctx))
      return `Extracted ${ctx.paths.rel(src)} to ${ctx.paths.rel(dst)}`
    }

    throw new ToolError(`Unknown archive action: ${actionText(args.action)}`)
  }
}

const qrGenerate: ToolSpec = {
  python: 'tool_qr_generate',
  params: [
    { name: 'data', required: true },
    { name: 'output_path', required: true }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.output_path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('qr_generate', rel)))
      throw new ToolError('The user denied QR generation.')

    await mkdirParents(dirname(full))
    const symbol = qrSymbol(qrPayloadBytes(args.data))
    await ctx.beginBinaryArtifact(full)
    await raise(full, () => writeFile(full, qrPngBytes(symbol)))
    const summary = `Generated QR code at ${rel} for payload: ${qrPayloadSummary(args.data)}`
    await ctx.recordBinaryArtifact(full, 'created', summary)
    return summary
  }
}

export const ARCHIVE_TOOLS: Record<string, ToolSpec> = {
  archive_manage: archiveManage,
  qr_generate: qrGenerate
}
