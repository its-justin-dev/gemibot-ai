import '../utils/pdf-runtime'

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import {
  getDocument,
  OPS,
  type PDFDocumentProxy,
  type PDFPageProxy
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PythonError, ToolError } from '../../shared/utils/exceptions'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pyIntValue, pySplitWords, pyStr, pyStrip } from '../../shared/utils/pystr'
import { pyOr, pyTruthy } from '../../shared/utils/pytruth'
import { wrap } from '../../shared/utils/textwrap'
import { pathIsFile } from '../utils/fs-stat'
import { label, pathArg, type ToolSpec } from './tool-contract'

const LETTER: [number, number] = [612, 792]

const ROW_BREAK = new Set<number>([
  OPS.beginText,
  OPS.endText,
  OPS.nextLine,
  OPS.moveText,
  OPS.setLeadingMoveText
])

const SHOW = new Set<number>([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText
])

function textFromOps(fnArray: number[], argsArray: unknown[]): string {
  const rows: string[] = []
  let row = ''
  const flush = (): void => {
    if (row !== '') {
      rows.push(row)
      row = ''
    }
  }
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i]
    if (ROW_BREAK.has(fn)) {
      flush()
      continue
    }
    if (!SHOW.has(fn)) continue
    if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) flush()
    for (const chunk of (argsArray[i] ?? []) as unknown[]) {
      if (!Array.isArray(chunk)) continue
      for (const glyph of chunk) {
        row += String((glyph as { unicode?: unknown })?.unicode ?? '')
      }
    }
  }
  flush()
  return rows.join('\n')
}

async function pageText(page: PDFPageProxy): Promise<string> {
  const list = await page.getOperatorList()
  return textFromOps(list.fnArray, list.argsArray)
}

const ZIP_MAGICS: number[][] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08]
]

const OFFICE_MARKERS: [string, string][] = [
  ['word/', 'docx_read'],
  ['xl/', 'excel_read'],
  ['ppt/', 'pptx_read']
]

/**
 * A Word/Excel/PowerPoint file is a ZIP, and pdfjs answers one with a stream error that tells
 * nobody which tool to use. The container is decided from the bytes, not the extension.
 */
function officeReader(data: Buffer): string | null {
  if (!ZIP_MAGICS.some((magic) => magic.every((byte, i) => data[i] === byte))) return null
  for (const [marker, tool] of OFFICE_MARKERS) {
    if (data.includes(marker)) return tool
  }
  return null
}

async function openPdf(full: string, rel: string): Promise<PDFDocumentProxy> {
  const data = await readFile(full)
  const reader = officeReader(data)
  if (reader !== null) {
    throw new ToolError(`Not a PDF: ${rel} is an Office document. Use ${reader} instead.`)
  }
  try {
    return await getDocument({
      data: new Uint8Array(data),
      disableFontFace: true,
      useSystemFonts: true
    }).promise
  } catch (e) {
    if ((e as Error)?.name === 'PasswordException') {
      throw new PythonError('FileNotDecryptedError', 'File has not been decrypted')
    }
    throw new PythonError('PdfStreamError', 'Stream has ended unexpectedly')
  }
}

function infoText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const pdfRead: ToolSpec = {
  python: 'tool_pdf_read',
  params: [
    { name: 'path', required: true },
    { name: 'start_page', default: 1 },
    { name: 'end_page', default: 20 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`PDF not found: ${label(args.path)}`)
    const startP = Math.max(1, pyIntValue(pyOr(args.start_page, 1)))
    const endP = Math.max(startP, pyIntValue(pyOr(args.end_page, 20)))
    const rel = ctx.paths.rel(full)
    const doc = await openPdf(full, rel)
    const total = doc.numPages
    const out = [`PDF File: ${rel} (Total pages: ${total})`]
    for (let p = startP; p <= Math.min(endP, total); p += 1) {
      const page = await doc.getPage(p)
      out.push(`\n--- Page ${p} / ${total} ---\n${pyStrip(await pageText(page))}`)
    }
    return out.join('\n')
  }
}

const pdfAnalyze: ToolSpec = {
  python: 'tool_pdf_analyze',
  params: [{ name: 'path', required: true }],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`PDF not found: ${label(args.path)}`)
    const rel = ctx.paths.rel(full)
    const doc = await openPdf(full, rel)
    const info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>
    let totalWords = 0
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p)
      totalWords += pySplitWords(await pageText(page)).length
    }
    return (
      `PDF Analysis: ${rel}\n` +
      `- Pages: ${doc.numPages}\n` +
      `- Encrypted: ${pyStr(pyTruthy(info.EncryptFilterName))}\n` +
      `- Title: ${pyOr(infoText(info.Title), 'Unknown')}\n` +
      `- Author: ${pyOr(infoText(info.Author), 'Unknown')}\n` +
      `- Creator: ${pyOr(infoText(info.Creator), 'Unknown')}\n` +
      `- Total Extracted Words: ${pyFormatThousands(totalWords)}`
    )
  }
}

function winAnsiText(font: PDFFont, text: string): string {
  try {
    font.encodeText(text)
    return text
  } catch {}
  let safe = ''
  for (const ch of text) {
    try {
      font.encodeText(ch)
      safe += ch
    } catch {
      safe += '?'
    }
  }
  return safe
}

const pdfWrite: ToolSpec = {
  python: 'tool_pdf_write',
  params: [
    { name: 'path', required: true },
    { name: 'content', required: true },
    { name: 'title', default: 'Document' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('pdf_write', rel))) throw new ToolError('The user denied PDF creation.')
    const content = pyStr(args.content)
    const title = pyStr(args.title)

    const doc = await PDFDocument.create()
    doc.setTitle('untitled')
    doc.setAuthor('anonymous')
    doc.setCreator('anonymous')
    doc.setSubject('unspecified')
    doc.setProducer('ReportLab PDF Library - (opensource)')
    const stamp = new Date()
    doc.setCreationDate(stamp)
    doc.setModificationDate(stamp)

    const titleFont = await doc.embedFont(StandardFonts.HelveticaBold)
    const bodyFont = await doc.embedFont(StandardFonts.Helvetica)
    const height = LETTER[1]
    let page = doc.addPage(LETTER)
    let y = height - 55
    page.drawText(winAnsiText(titleFont, title), { x: 50, y, size: 16, font: titleFont })
    y -= 28

    for (const rawLine of content.replaceAll('\r\n', '\n').split('\n')) {
      const wrapped = wrap(rawLine, 92)
      for (const line of wrapped.length > 0 ? wrapped : ['']) {
        if (y < 55) {
          page = doc.addPage(LETTER)
          y = height - 55
        }
        page.drawText(winAnsiText(bodyFont, line), { x: 50, y, size: 10, font: bodyFont })
        y -= 14
      }
    }

    await mkdir(dirname(full), { recursive: true })
    await ctx.beginBinaryArtifact(full)
    await writeFile(full, await doc.save())
    const summary = `Created PDF ${rel} (title='${title}')`
    await ctx.recordBinaryArtifact(full, 'created', `${summary}\n\n${content}`)
    return summary
  }
}

export const PDF_TOOLS: Record<string, ToolSpec> = {
  pdf_read: pdfRead,
  pdf_analyze: pdfAnalyze,
  pdf_write: pdfWrite
}
