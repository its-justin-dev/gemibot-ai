import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, posix } from 'path'

import * as cheerio from 'cheerio'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'

import { PythonError, ToolError } from '../../shared/utils/exceptions'
import { pyFloatRepr } from '../../shared/utils/pyjson'
import { pyRepr } from '../../shared/utils/pyrepr'
import { pyStr, pyStrip, pyTypeName } from '../../shared/utils/pystr'
import { pyTruthy } from '../../shared/utils/pytruth'
import { pathIsFile } from '../utils/fs-stat'
import { label, pathArg, type ToolSpec } from './tool-contract'

interface XNode {
  type?: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: XNode[]
}

interface OpcRel {
  id: string
  type: string
  target: string
  external: boolean
  part: string
}

const SHAPE_TAGS = new Set([
  'p:sp',
  'p:grpSp',
  'p:graphicFrame',
  'p:cxnSp',
  'p:pic',
  'p:contentPart'
])

const CONTENT_TYPES = '[Content_Types].xml'
const OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const NOTES_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

function keyError(message: string): PythonError {
  return new PythonError('KeyError', `"${message}"`)
}

function parsePart(xml: string): XNode | undefined {
  const $ = cheerio.load(xml.replace(/\r\n?/gu, '\n'), { xml: true })
  for (const node of $.root().children().toArray() as unknown as XNode[]) {
    if (node.type === 'tag') return node
  }
  return undefined
}

function childElements(node: XNode | undefined): XNode[] {
  if (!node) return []
  return (node.children ?? []).filter((child) => child.type === 'tag')
}

function firstChild(node: XNode | undefined, tag: string): XNode | undefined {
  return childElements(node).find((child) => child.name === tag)
}

function elementText(node: XNode | undefined): string {
  if (!node) return ''
  let text = ''
  for (const child of node.children ?? []) {
    if (child.type === 'text' || child.type === 'cdata') text += child.data ?? ''
    else if (child.type === 'tag') break
  }
  return text
}

function runText(run: XNode): string {
  const t = firstChild(run, 'a:t')
  if (!t) throw new PythonError('InvalidXmlError', 'required ``<a:t>`` child element not present')
  return elementText(t)
}

function paragraphText(paragraph: XNode): string {
  let text = ''
  for (const child of childElements(paragraph)) {
    if (child.name === 'a:r') text += runText(child)
    else if (child.name === 'a:br') text += '\v'
    else if (child.name === 'a:fld') text += elementText(firstChild(child, 'a:t'))
  }
  return text
}

function shapeText(shape: XNode): string {
  const txBody = firstChild(shape, 'p:txBody')
  if (!txBody) return ''
  return childElements(txBody)
    .filter((child) => child.name === 'a:p')
    .map(paragraphText)
    .join('\n')
}

function partNameOf(baseDir: string, target: string): string {
  const joined = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`
  return posix.normalize(joined).replace(/^\/+/u, '')
}

function hasPart(zip: JSZip, partName: string): boolean {
  const entry = zip.files[partName]
  return entry !== undefined && !entry.dir
}

function relsPathOf(partName: string): string {
  const dir = posix.dirname(partName)
  const base = posix.basename(partName)
  if (dir === '.' || dir === '/') return '_rels/.rels'
  return `${dir}/_rels/${base}.rels`
}

async function relsFor(zip: JSZip, partName: string): Promise<OpcRel[]> {
  const xml = await zip.file(relsPathOf(partName))?.async('string')
  if (xml === undefined) return []
  const root = parsePart(xml)
  const baseDir = partName === '' ? '' : posix.dirname(partName)
  const rels: OpcRel[] = []
  for (const elm of childElements(root).filter((child) => child.name === 'Relationship')) {
    const target = elm.attribs?.Target ?? ''
    rels.push({
      id: elm.attribs?.Id ?? '',
      type: elm.attribs?.Type ?? '',
      target,
      external: (elm.attribs?.TargetMode ?? '') === 'External',
      part: partNameOf(baseDir, target)
    })
  }
  const valid: OpcRel[] = []
  for (const rel of rels) {
    if (!rel.external && !hasPart(zip, rel.part)) continue
    valid.push(rel)
  }
  return valid
}

function relOfType(rels: OpcRel[], type: string): OpcRel {
  const matches = rels.filter((rel) => rel.type === type)
  if (matches.length === 0) throw keyError(`no relationship of type '${type}' in collection`)
  if (matches.length > 1)
    throw new PythonError('ValueError', `multiple relationships of type '${type}' in collection`)
  return matches[0]
}

function notesRelOrNone(rels: OpcRel[]): OpcRel | null {
  try {
    return relOfType(rels, NOTES_SLIDE)
  } catch (error) {
    if (error instanceof PythonError && error.name === 'KeyError') return null
    throw error
  }
}

function relById(rels: OpcRel[], id: string): OpcRel {
  const rel = rels.find((candidate) => candidate.id === id)
  if (!rel) throw keyError(`no relationship with key '${id}'`)
  return rel
}

function targetPart(rel: OpcRel): string {
  if (rel.external) {
    throw new PythonError(
      'ValueError',
      '`.target_part` property on _Relationship is undefined when target-mode is external'
    )
  }
  return rel.part
}

async function partXml(zip: JSZip, partName: string): Promise<XNode | undefined> {
  return parsePart(await zip.file(partName)!.async('string'))
}

function slideSpTree(slide: XNode | undefined): XNode {
  const cSld = firstChild(slide, 'p:cSld')
  if (!cSld)
    throw new PythonError('InvalidXmlError', 'required ``<p:cSld>`` child element not present')
  const spTree = firstChild(cSld, 'p:spTree')
  if (!spTree)
    throw new PythonError('InvalidXmlError', 'required ``<p:spTree>`` child element not present')
  return spTree
}

function slideShapes(spTree: XNode): XNode[] {
  return childElements(spTree).filter(
    (child) => child.name !== undefined && SHAPE_TAGS.has(child.name)
  )
}

function notesText(notesSlide: XNode | undefined): string | null {
  for (const shape of childElements(slideSpTree(notesSlide))) {
    if (shape.name !== 'p:sp') continue
    const ph = firstChild(firstChild(firstChild(shape, 'p:nvSpPr'), 'p:nvPr'), 'p:ph')
    if (!ph || (ph.attribs?.type ?? '') !== 'body') continue
    return shapeText(shape)
  }
  return null
}

const pptxRead: ToolSpec = {
  python: 'tool_pptx_read',
  params: [{ name: 'path', required: true }],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) throw new ToolError(`PPTX not found: ${label(args.path)}`)

    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(await readFile(full))
    } catch {
      throw new PythonError('PackageNotFoundError', `Package not found at '${full}'`)
    }
    if (!hasPart(zip, CONTENT_TYPES)) throw keyError(`no member '/${CONTENT_TYPES}' in package`)

    const presentation = targetPart(relOfType(await relsFor(zip, ''), OFFICE_DOCUMENT))
    const presRels = await relsFor(zip, presentation)
    const slidePartNames: string[] = []
    const sldIdLst = firstChild(await partXml(zip, presentation), 'p:sldIdLst')
    for (const sldId of childElements(sldIdLst)) {
      if (sldId.name !== 'p:sldId') continue
      const rId = sldId.attribs?.['r:id'] ?? 'None'
      slidePartNames.push(targetPart(relById(presRels, rId)))
    }

    const out = [
      `PowerPoint Presentation: ${ctx.paths.rel(full)} (${slidePartNames.length} slides)`
    ]
    let index = 0
    for (const partName of slidePartNames) {
      index += 1
      const shapes = slideShapes(slideSpTree(await partXml(zip, partName)))
      const lines: string[] = [`\n--- Slide ${index} ---`]
      for (const shape of shapes) {
        if (shape.name !== 'p:sp') continue
        const txt = pyStrip(shapeText(shape))
        if (txt !== '') lines.push(txt)
      }
      const notesRel = notesRelOrNone(await relsFor(zip, partName))
      if (notesRel) {
        const text = notesText(await partXml(zip, targetPart(notesRel)))
        const notes = text === null ? '' : pyStrip(text)
        if (notes !== '') lines.push(`[Speaker Notes]: ${notes}`)
      }
      out.push(lines.join('\n'))
    }
    return out.join('\n')
  }
}

function escapeCtrlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B-\x1F]/gu, (ch) => {
    return `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`
  })
}

function pyValueStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number')
    return Number.isInteger(value) && Number.isFinite(value) ? String(value) : pyFloatRepr(value)
  if (value === null || value === undefined || typeof value === 'boolean') return pyStr(value)
  return pyValueRepr(value)
}

function pyValueRepr(value: unknown): string {
  if (typeof value === 'string') return pyRepr(value)
  if (Array.isArray(value)) return `[${value.map(pyValueRepr).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pyRepr(key)}: ${pyValueRepr(item)}`
    )
    return `{${entries.join(', ')}}`
  }
  return pyValueStr(value)
}

function textRuns(paragraph: string): string[] {
  return paragraph.split(/[\n\v]/u)
}

function textParagraphs(text: string, firstOfFrame: boolean): string[] {
  return firstOfFrame ? text.split('\n') : [text]
}

function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return Array.from(value)
  if (value !== null && typeof value === 'object') return Object.keys(value)
  throw new PythonError('TypeError', `'${pyTypeName(value)}' object is not iterable`)
}

function requireText(value: unknown): string {
  if (typeof value !== 'string')
    throw new PythonError(
      'AttributeError',
      `'${pyTypeName(value)}' object has no attribute 'split'`
    )
  return value
}

const EMU = 914400
const TITLE_BOX = { x: 685800 / EMU, y: 2130425 / EMU, w: 7772400 / EMU, h: 1470025 / EMU }
const SUBTITLE_BOX = { x: 1371600 / EMU, y: 3886200 / EMU, w: 6400800 / EMU, h: 1752600 / EMU }
const HEAD_BOX = { x: 457200 / EMU, y: 274638 / EMU, w: 8229600 / EMU, h: 1143000 / EMU }
const BODY_BOX = { x: 457200 / EMU, y: 1600200 / EMU, w: 8229600 / EMU, h: 4525963 / EMU }

interface FrameItem {
  text: string
  options: { softBreakBefore: boolean; breakLine: boolean }
}

function textFrameItems(values: unknown[], asFrame: boolean): FrameItem[] {
  const paragraphs: string[] = []
  values.forEach((value, index) => {
    paragraphs.push(...textParagraphs(requireText(value), asFrame && index === 0))
  })
  const items: FrameItem[] = []
  paragraphs.forEach((paragraph, pIndex) => {
    const runs = textRuns(paragraph)
    runs.forEach((run, rIndex) => {
      items.push({
        text: escapeCtrlChars(run),
        options: {
          softBreakBefore: rIndex > 0,
          breakLine: rIndex === runs.length - 1 && pIndex + 1 < paragraphs.length
        }
      })
    })
  })
  return items
}

function addFrame(
  slide: PptxGenJS.Slide,
  values: unknown[],
  asFrame: boolean,
  box: { x: number; y: number; w: number; h: number },
  fontSize: number
): void {
  const items = textFrameItems(values, asFrame)
  if (items.every((item) => item.text === '')) return
  slide.addText(items, { ...box, fontSize })
}

const pptxWrite: ToolSpec = {
  python: 'tool_pptx_write',
  params: [
    { name: 'path', required: true },
    { name: 'title', required: true },
    { name: 'slides', required: true },
    { name: 'subtitle', default: 'Generated by GemiBot AI' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('pptx_write', rel)))
      throw new ToolError('The user denied PPTX creation.')

    const pptx = new PptxGenJS()
    pptx.defineLayout({ name: 'GEMIBOT_4_3', width: 10, height: 7.5 })
    pptx.layout = 'GEMIBOT_4_3'

    const cover = pptx.addSlide()
    addFrame(cover, [requireText(args.title)], true, TITLE_BOX, 44)
    addFrame(
      cover,
      [pyTruthy(args.subtitle) ? requireText(args.subtitle) : ''],
      true,
      SUBTITLE_BOX,
      32
    )

    const definitions = pyIterate(pyTruthy(args.slides) ? args.slides : [])
    for (const raw of definitions) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new PythonError(
          'AttributeError',
          `'${pyTypeName(raw)}' object has no attribute 'get'`
        )
      const definition = raw as Record<string, unknown>
      const slide = pptx.addSlide()
      addFrame(
        slide,
        [Object.hasOwn(definition, 'heading') ? definition.heading : 'Slide'],
        true,
        HEAD_BOX,
        44
      )
      const bullets = pyIterate(Object.hasOwn(definition, 'bullets') ? definition.bullets : []).map(
        (bullet) => pyValueStr(bullet)
      )
      addFrame(slide, bullets, true, BODY_BOX, 32)
      if (pyTruthy(definition.notes)) slide.addNotes(escapeCtrlChars(pyValueStr(definition.notes)))
    }

    await mkdir(dirname(full), { recursive: true })
    await ctx.beginBinaryArtifact(full)
    await writeFile(full, (await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array)
    const summary = `Created PowerPoint ${rel} (${1 + definitions.length} total slides)`
    await ctx.recordBinaryArtifact(full, 'created', summary)
    return summary
  }
}

export const PPTX_TOOLS: Record<string, ToolSpec> = {
  pptx_read: pptxRead,
  pptx_write: pptxWrite
}
