import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'

import JSZip from 'jszip'
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'

import { PythonError, ToolError } from '../../shared/utils/exceptions'
import { pyFormatThousands, pyRound } from '../../shared/utils/pyformat'
import { pyStr } from '../../shared/utils/pystr'
import { pyTruthy } from '../../shared/utils/pytruth'
import { pathIsFile } from '../utils/fs-stat'
import {
  CONTENT_TYPES,
  OFFICE_DOCUMENT,
  archiveKeyError,
  hasMember,
  noRelationship,
  openArchive,
  packageNotFound,
  relationshipsOf
} from '../utils/ooxml-package'
import { label, pathArg, type ToolSpec } from './tool-contract'

function pySplitWords(text: string): string[] {
  return text.split(/\s+/u).filter((piece) => piece !== '')
}

interface OoxmlDoc {
  documentXml: string
  stylesName: Record<string, string>
  defaultParagraphStyle: string
  core: Record<string, string | null>
}

function elementSpans(xml: string, localName: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const stack: Array<number> = []
  const tokens = new RegExp(
    `<([\\w-]+:)?${localName}(\\s[^>]*)?/?>|</([\\w-]+:)?${localName}>`,
    'gu'
  )
  for (const match of xml.matchAll(tokens)) {
    const text = match[0]
    if (text.startsWith('</')) {
      const start = stack.pop()
      if (start !== undefined) spans.push({ start, end: (match.index ?? start) + text.length })
    } else if (text.endsWith('/>')) {
      spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + text.length })
    } else {
      stack.push(match.index ?? 0)
    }
  }
  return spans
}

function textUnder(xml: string, start: number, end: number): string {
  let result = ''
  for (const match of xml
    .slice(start, end)
    .matchAll(/<[\w-]+:t(?:\s[^>]*)?>([^<]*)<\/[\w-]+:t>/gu)) {
    result += match[1]
  }
  return decodeXmlEntities(result)
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gu, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

function encodeXmlText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

const BABEL_FISH: Record<string, string> = Object.fromEntries(
  (
    [
      ['Caption', 'caption'],
      ['Footer', 'footer'],
      ['Header', 'header'],
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`Heading ${n}`, `heading ${n}`])
    ] as Array<[string, string]>
  ).map(([ui, internal]) => [internal, ui])
)

function babelFish(internalName: string): string {
  return BABEL_FISH[internalName] ?? internalName
}

function topLevelSpans(
  xml: string,
  localName: string,
  containerLocalName = 'tbl'
): Array<{ start: number; end: number }> {
  const spans = elementSpans(xml, localName)
  const containers = elementSpans(xml, containerLocalName)
  if (containers.length === 0) return spans
  return spans.filter((span) => !containers.some((c) => c.start < span.start && span.end <= c.end))
}

interface BodyParagraph {
  text: string
  styleName: string
}

function bodyParagraphs(doc: OoxmlDoc): BodyParagraph[] {
  const body = elementSpans(doc.documentXml, 'body')[0]
  if (!body) return []
  const inner = doc.documentXml.slice(body.start, body.end)
  const result: BodyParagraph[] = []
  for (const span of topLevelSpans(inner, 'p')) {
    const xml = inner.slice(span.start, span.end)
    const styleId = /<[\w-]+:pStyle\s+[\w-]+:val="([^"]*)"/u.exec(xml)?.[1]
    const name = doc.stylesName[styleId ?? doc.defaultParagraphStyle] ?? styleId ?? 'Normal'
    result.push({ text: textUnder(inner, span.start, span.end), styleName: name })
  }
  return result
}

interface OoxmlTable {
  rows: string[][]
}

function bodyTables(doc: OoxmlDoc): OoxmlTable[] {
  const body = elementSpans(doc.documentXml, 'body')[0]
  if (!body) return []
  const inner = doc.documentXml.slice(body.start, body.end)
  const tables: OoxmlTable[] = []
  for (const tableSpan of topLevelSpans(inner, 'tbl')) {
    const tableXml = inner.slice(tableSpan.start, tableSpan.end)
    const rows: string[][] = []
    for (const rowSpan of elementSpans(tableXml, 'tr')) {
      const rowXml = tableXml.slice(rowSpan.start, rowSpan.end)
      const cells: string[] = []
      for (const cellSpan of elementSpans(rowXml, 'tc')) {
        cells.push(textUnder(rowXml, cellSpan.start, cellSpan.end))
      }
      rows.push(cells)
    }
    tables.push({ rows })
  }
  return tables
}

async function openDocxPackage(
  full: string
): Promise<{ zip: JSZip; documentPart: string; documentXml: string }> {
  const archive = await openArchive(full)
  if ('notAZip' in archive) throw packageNotFound(full)
  const { zip } = archive
  if (!hasMember(zip, CONTENT_TYPES)) throw archiveKeyError(CONTENT_TYPES)

  const rels = await relationshipsOf(zip, '')
  const matches = rels.filter((rel) => rel.type === OFFICE_DOCUMENT)
  if (matches.length === 0) throw noRelationship(OFFICE_DOCUMENT)
  if (matches.length > 1)
    throw new PythonError(
      'ValueError',
      `multiple relationships of type '${OFFICE_DOCUMENT}' in collection`
    )

  const documentPart = matches[0].target
  const documentFile = zip.file(documentPart)
  if (documentFile === null) throw archiveKeyError(documentPart)
  return { zip, documentPart, documentXml: await documentFile.async('string') }
}

async function openDocx(full: string): Promise<OoxmlDoc> {
  const { zip, documentXml } = await openDocxPackage(full)
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? ''
  const coreXml = (await zip.file('docProps/core.xml')?.async('string')) ?? ''

  const stylesName: Record<string, string> = {}
  let defaultParagraphStyle = 'Normal'
  for (const span of elementSpans(stylesXml, 'style')) {
    const xml = stylesXml.slice(span.start, span.end)
    const id = /[\w-]+:styleId="([^"]*)"/u.exec(xml)?.[1]
    const name = /<[\w-]+:name\s+[\w-]+:val="([^"]*)"/u.exec(xml)?.[1]
    if (id && name) stylesName[id] = babelFish(name)
    if (id && name && /w:type="paragraph"/u.test(xml) && /w:default="1"/u.test(xml))
      defaultParagraphStyle = id
  }

  const core: Record<string, string | null> = {
    creator: null,
    title: null,
    created: null,
    modified: null
  }
  for (const tag of ['creator', 'title', 'created', 'modified']) {
    const m = new RegExp(`<([\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)<`, 'u').exec(coreXml)
    if (m) core[tag] = decodeXmlEntities(m[2])
  }
  return { documentXml, stylesName, defaultParagraphStyle, core }
}

function pyDateTimeString(iso: string | null): string {
  if (iso === null) return 'None'
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/u.exec(iso)
  if (!m) return iso
  const [, y, mo, d, h, mi, s, frac, zone] = m
  let suffix = ''
  if (zone) suffix = zone === 'Z' ? '+00:00' : `${zone[0]}${zone.slice(1, 3)}:${zone.slice(-2)}`
  return `${y}-${mo}-${d} ${h}:${mi}:${s}${frac ?? ''}${suffix}`
}

const docxRead: ToolSpec = {
  python: 'tool_docx_read',
  params: [
    { name: 'path', required: true },
    { name: 'include_tables', default: true }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`DOCX file not found: ${label(args.path)}`)
    const doc = await openDocx(full)
    const out: string[] = [`# DOCX Document: ${ctx.paths.rel(full)}\n`]
    const paragraphs = bodyParagraphs(doc)
    for (const [index, p] of paragraphs.entries()) {
      const txt = p.text.trim()
      if (!txt) continue
      const styleName = p.styleName || 'Normal'
      if (styleName.includes('Heading 1')) out.push(`## ${txt}`)
      else if (styleName.includes('Heading 2')) out.push(`### ${txt}`)
      else if (styleName.includes('Heading')) out.push(`#### ${txt}`)
      else out.push(`${String(index + 1).padStart(4, ' ')}| ${txt}`)
    }

    const tables = bodyTables(doc)
    if (pyTruthy(args.include_tables) && tables.length > 0) {
      out.push(`\n## Extracted Tables (${tables.length})`)
      for (const [tIdx, table] of tables.entries()) {
        out.push(`\n### Table ${tIdx + 1}`)
        for (const [rIdx, row] of table.rows.entries()) {
          const cells = row.map((c) => c.trim().replaceAll('\n', ' '))
          out.push('| ' + cells.join(' | ') + ' |')
          if (rIdx === 0) out.push('| ' + cells.map(() => '---').join(' | ') + ' |')
        }
      }
    }
    return out.join('\n')
  }
}

const docxAnalyze: ToolSpec = {
  python: 'tool_docx_analyze',
  params: [{ name: 'path', required: true }],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`DOCX file not found: ${label(args.path)}`)
    const doc = await openDocx(full)
    const paragraphs = bodyParagraphs(doc)
    const paras = paragraphs.map((p) => p.text.trim()).filter((t) => t !== '')
    const words = paras.reduce((sum, p) => sum + pySplitWords(p).length, 0)
    const chars = paras.reduce((sum, p) => sum + p.length, 0)
    const headings = paragraphs
      .filter((p) => p.styleName.includes('Heading') && p.text.trim() !== '')
      .map((p) => `${p.styleName}: ${p.text.trim()}`)
    const stylesUsed = [
      ...new Set(paragraphs.map((p) => p.styleName).filter((s) => s !== ''))
    ].sort()
    const tables = bodyTables(doc)
    const sections = (doc.documentXml.match(/<[\w-]+:sectPr[\s/>]/gu) ?? []).length
    const report = [
      `DOCX Structural & Content Analysis: ${ctx.paths.rel(full)}`,
      `- Author: ${doc.core.creator || 'Unknown'}`,
      `- Title: ${doc.core.title || '(untitled)'}`,
      `- Created: ${pyDateTimeString(doc.core.created)} | Modified: ${pyDateTimeString(doc.core.modified)}`,
      `- Non-empty Paragraphs: ${paras.length}`,
      `- Total Words: ${pyFormatThousands(words)} (~${Math.max(1, pyRound(words / 200))} min read)`,
      `- Total Characters: ${pyFormatThousands(chars)}`,
      `- Tables Count: ${tables.length}`,
      `- Sections Count: ${sections}`,
      `- Styles Used: ${stylesUsed.join(', ') || 'Default'}`,
      '\nHeading Outline:'
    ]
    report.push(...headings.slice(0, 40).map((h) => `  - ${h}`))
    if (headings.length === 0) report.push('  (No heading styles detected)')
    return report.join('\n')
  }
}

const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '000000' }
}

const LIST_NUMBERING = {
  config: [
    {
      reference: 'gemibot-list-number',
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }
      ]
    }
  ]
}

function appendMarkdownNodes(content: string): {
  children: Array<Paragraph | Table>
  paragraphs: number
  tables: number
} {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const children: Array<Paragraph | Table> = []
  let paragraphCount = 0
  let tableCount = 0
  let tableBuffer: string[] = []

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return
    const rows = tableBuffer
      .filter((r) => !/^\|?[\s\-:|]+\|?$/u.test(r.trim()))
      .map((r) =>
        r
          .trim()
          .replace(/^\|/u, '')
          .replace(/\|$/u, '')
          .split('|')
          .map((c) => c.trim())
      )
    if (rows.length > 0) {
      const cols = Math.max(...rows.map((r) => r.length))
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: TABLE_BORDERS,
          rows: rows.map(
            (rowData) =>
              new TableRow({
                children: Array.from(
                  { length: cols },
                  (_, c) =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun(rowData[c] ?? '')] })]
                    })
                )
              })
          )
        })
      )
      tableCount += 1
    }
    tableBuffer = []
  }

  for (const line of lines) {
    const stripped = line.trim()
    if (stripped.startsWith('|') && stripped.endsWith('|')) {
      tableBuffer.push(stripped)
      continue
    }
    flushTable()
    if (!stripped) continue
    if (stripped.startsWith('# ')) {
      children.push(
        new Paragraph({ text: stripped.slice(2).trim(), heading: HeadingLevel.HEADING_1 })
      )
      paragraphCount += 1
    } else if (stripped.startsWith('## ')) {
      children.push(
        new Paragraph({ text: stripped.slice(3).trim(), heading: HeadingLevel.HEADING_2 })
      )
      paragraphCount += 1
    } else if (stripped.startsWith('### ')) {
      children.push(
        new Paragraph({ text: stripped.slice(4).trim(), heading: HeadingLevel.HEADING_3 })
      )
      paragraphCount += 1
    } else if (stripped.startsWith('- ') || stripped.startsWith('* ')) {
      children.push(new Paragraph({ text: stripped.slice(2).trim(), bullet: { level: 0 } }))
      paragraphCount += 1
    } else if (/^\d+\.\s+/u.test(stripped)) {
      children.push(
        new Paragraph({
          text: stripped.replace(/^\d+\.\s+/u, ''),
          numbering: { reference: 'gemibot-list-number', level: 0 }
        })
      )
      paragraphCount += 1
    } else {
      children.push(new Paragraph({ text: stripped }))
      paragraphCount += 1
    }
  }
  flushTable()
  return { children, paragraphs: paragraphCount, tables: tableCount }
}

const docxWrite: ToolSpec = {
  python: 'tool_docx_write',
  params: [
    { name: 'path', required: true },
    { name: 'content', required: true },
    { name: 'title', default: null },
    { name: 'author', default: 'GemiBot AI' },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('docx_write', rel))) {
      throw new ToolError('The user denied DOCX creation.')
    }
    const title = args.title === null || args.title === undefined ? null : pyStr(args.title)
    const author = pyStr(args.author) || 'GemiBot AI'
    const content = pyStr(args.content)

    const { children, paragraphs, tables } = appendMarkdownNodes(content)
    const doc = new Document({
      numbering: LIST_NUMBERING,
      sections: [
        {
          children: [
            ...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []),
            ...children
          ]
        }
      ],
      creator: author,
      ...(title ? { title } : {})
    })
    await mkdir(dirname(full), { recursive: true })
    await ctx.beginBinaryArtifact(full)
    await writeFile(full, await Packer.toBuffer(doc))
    const summary = `Wrote DOCX file ${rel} (${paragraphs + (title ? 1 : 0)} paragraphs, ${tables} tables)`
    await ctx.recordBinaryArtifact(
      full,
      'created',
      `${summary}\n\nContent:\n${content}`,
      pyStr(args.what),
      pyStr(args.why)
    )
    return summary
  }
}

function markdownToOoxml(
  content: string,
  styleIds: { bullet: string | null; number: string | null }
): string {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const parts: string[] = []
  let tableBuffer: string[] = []

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return
    const rows = tableBuffer
      .filter((r) => !/^\|?[\s\-:|]+\|?$/u.test(r.trim()))
      .map((r) =>
        r
          .trim()
          .replace(/^\|/u, '')
          .replace(/\|$/u, '')
          .split('|')
          .map((c) => c.trim())
      )
    if (rows.length > 0) {
      const cols = Math.max(...rows.map((r) => r.length))
      const border = '<w:tblBorders>'
      const bordersXml = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
        .join('')
      const body = rows
        .map(
          (rowData) =>
            '<w:tr>' +
            Array.from({ length: cols }, (_, c) => {
              const text = rowData[c] ?? ''
              return (
                '<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">' +
                encodeXmlText(text) +
                '</w:t></w:r></w:p></w:tc>'
              )
            }).join('') +
            '</w:tr>'
        )
        .join('')
      parts.push(
        `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}${bordersXml}</w:tblBorders></w:tblPr>${body}</w:tbl>`
      )
    }
    tableBuffer = []
  }

  const run = (text: string): string =>
    `<w:r><w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`
  const paragraph = (text: string, pPr: string): string =>
    `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(text)}</w:p>`

  for (const line of lines) {
    const stripped = line.trim()
    if (stripped.startsWith('|') && stripped.endsWith('|')) {
      tableBuffer.push(stripped)
      continue
    }
    flushTable()
    if (!stripped) continue
    if (stripped.startsWith('# ')) {
      parts.push(paragraph(stripped.slice(2).trim(), '<w:pStyle w:val="Heading1"/>'))
    } else if (stripped.startsWith('## ')) {
      parts.push(paragraph(stripped.slice(3).trim(), '<w:pStyle w:val="Heading2"/>'))
    } else if (stripped.startsWith('### ')) {
      parts.push(paragraph(stripped.slice(4).trim(), '<w:pStyle w:val="Heading3"/>'))
    } else if (stripped.startsWith('- ') || stripped.startsWith('* ')) {
      const pPr = styleIds.bullet
        ? `<w:pStyle w:val="${styleIds.bullet}"/>`
        : '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
      parts.push(paragraph(stripped.slice(2).trim(), pPr))
    } else if (/^\d+\.\s+/u.test(stripped)) {
      const pPr = styleIds.number
        ? `<w:pStyle w:val="${styleIds.number}"/>`
        : '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
      parts.push(paragraph(stripped.replace(/^\d+\.\s+/u, ''), pPr))
    } else {
      parts.push(paragraph(stripped, ''))
    }
  }
  flushTable()
  return parts.join('')
}

const docxEdit: ToolSpec = {
  python: 'tool_docx_edit',
  params: [
    { name: 'path', required: true },
    { name: 'find_text', default: null },
    { name: 'replace_text', default: null },
    { name: 'append_markdown', default: null },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    if (!(await pathIsFile(full))) throw new ToolError(`DOCX file not found: ${label(args.path)}`)
    if (!(await ctx.allowed('docx_edit', rel))) {
      throw new ToolError('The user denied DOCX editing.')
    }
    const findText =
      args.find_text === null || args.find_text === undefined ? null : pyStr(args.find_text)
    const replaceText =
      args.replace_text === null || args.replace_text === undefined
        ? null
        : pyStr(args.replace_text)
    const appendMarkdown =
      args.append_markdown === null || args.append_markdown === undefined
        ? null
        : pyStr(args.append_markdown)

    const { zip, documentPart, documentXml: documentPartXml } = await openDocxPackage(full)
    let documentXml = documentPartXml
    let replacements = 0

    if (findText) {
      const rep = replaceText ?? ''
      let result = ''
      let cursor = 0
      for (const span of elementSpans(documentXml, 'p')) {
        const paragraph = documentXml.slice(span.start, span.end)
        if (!paragraph.includes(findText)) continue
        let updated = paragraph
        for (const runSpan of elementSpans(paragraph, 'r')) {
          const run = paragraph.slice(runSpan.start, runSpan.end)
          if (run.includes(findText)) {
            updated =
              updated.slice(0, runSpan.start) +
              run.split(findText).join(rep) +
              updated.slice(runSpan.end)
            replacements += 1
          }
        }
        if (updated.includes(findText)) {
          updated = updated.split(findText).join(rep)
          replacements += 1
        }
        result += documentXml.slice(cursor, span.start) + updated
        cursor = span.end
      }
      result += documentXml.slice(cursor)
      documentXml = result
    }

    if (appendMarkdown) {
      const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? ''
      const styleIds = {
        bullet: /w:styleId="(ListBullet)"/u.exec(stylesXml)?.[1] ?? null,
        number: /w:styleId="(ListNumber)"/u.exec(stylesXml)?.[1] ?? null
      }
      const close = documentXml.lastIndexOf('</w:body>')
      const insert = markdownToOoxml(appendMarkdown, styleIds)
      documentXml = documentXml.slice(0, close) + insert + documentXml.slice(close)
    }

    zip.file(documentPart, documentXml)
    await ctx.beginBinaryArtifact(full)
    await writeFile(full, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    const summary = `Updated DOCX ${rel} (replacements=${replacements}, appended=${
      appendMarkdown ? 'True' : 'False'
    })`
    await ctx.recordBinaryArtifact(full, 'modified', summary, pyStr(args.what), pyStr(args.why))
    return summary
  }
}

export const DOCX_TOOLS: Record<string, ToolSpec> = {
  docx_read: docxRead,
  docx_analyze: docxAnalyze,
  docx_write: docxWrite,
  docx_edit: docxEdit
}
