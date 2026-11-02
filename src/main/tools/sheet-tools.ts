import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, extname } from 'path'

import ExcelJS from 'exceljs'
import JSZip from 'jszip'

import { errorMessage, PythonError, ToolError } from '../../shared/utils/exceptions'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pyOr } from '../../shared/utils/pytruth'
import { pyIntValue, pyStr } from '../../shared/utils/pystr'
import { pathIsFile } from '../utils/fs-stat'
import {
  CONTENT_TYPES,
  archiveKeyError,
  badZipFile,
  bareKeyError,
  hasMember,
  manifest,
  memberNames,
  noWorkbookPart,
  openArchive,
  relationshipsOf
} from '../utils/ooxml-package'
import { label, pathArg, type ToolSpec } from './tool-contract'

export function pyCsvReader(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      pushField()
      i += 1
      continue
    }
    if (ch === '\n') {
      pushRow()
      i += 1
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow()
      i += 2
      continue
    }
    if (ch === '\r') {
      pushRow()
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

type CellValue = string | number | boolean | null | { formula?: string; result?: unknown }

function pyValueStr(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return pyFloatStr(value)
  if (typeof value === 'string') return value
  if (typeof value === 'object' && typeof value.formula === 'string') return `=${value.formula}`
  if (value instanceof Date) {
    const pad = (n: number): string => String(n).padStart(2, '0')
    let out =
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    if (value.getMilliseconds() !== 0) out += `.${String(value.getMilliseconds()).padStart(3, '0')}`
    return out
  }
  return String(value)
}

function pyFloatStr(value: number): string {
  return String(value)
}

const NA_TOKENS = new Set(['', 'NaN', 'nan', 'null', 'NULL', 'N/A', 'NA', 'None'])

type Dtype = 'int64' | 'float64' | 'bool' | 'str' | 'object'

type Datum = number | string | boolean | null

interface Column {
  name: string
  dtype: Dtype
  values: Datum[]
}

function parseNumeric(token: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(token)) return null
  const v = Number(token)
  return Number.isNaN(v) ? null : v
}

function csvDatum(token: string): Datum {
  const t = token.trim()
  if (NA_TOKENS.has(t)) return null
  if (t === 'True') return true
  if (t === 'False') return false
  if (/^[+-]?\d+$/u.test(t)) return parseInt(t, 10)
  return parseNumeric(t) ?? t
}

function buildColumns(header: string[], rows: Datum[][]): Column[] {
  return header.map((name, c) => {
    const values = rows.map((r) => r[c] ?? null)
    const present = values.filter((v): v is number | string | boolean => v !== null)
    let dtype: Dtype = 'str'
    if (rows.length === 0) dtype = 'object'
    else if (present.length === 0) dtype = 'float64'
    else if (present.every((v) => typeof v === 'boolean')) dtype = 'bool'
    else if (present.every((v) => typeof v === 'number')) {
      const integral = present.every((v) => Number.isInteger(v)) && present.length === values.length
      dtype = integral ? 'int64' : 'float64'
    }
    return { name, dtype, values }
  })
}

function csvColumns(rows: string[][]): Column[] {
  const header: string[] = rows.length > 0 ? rows[0] : []
  const body: string[][] = rows.length > 1 ? rows.slice(1) : []
  return buildColumns(
    header,
    body.map((r) => r.map(csvDatum))
  )
}

function sheetColumns(worksheet: ExcelJS.Worksheet): Column[] {
  const maxCol = worksheet.actualColumnCount
  const maxRow = worksheet.actualRowCount
  const cell = (r: number, c: number): Datum => {
    const value = worksheet.getRow(r).getCell(c).value
    if (value instanceof Date) return value.toISOString()
    if (value === null || value === undefined) return null
    if (typeof value === 'object' && 'formula' in (value as object)) {
      const result = (value as { result?: unknown }).result
      if (result === null || result === undefined) return null
      return typeof result === 'object' ? String(result) : (result as Datum)
    }
    if (typeof value === 'object' && 'richText' in (value as object)) {
      return (value as { richText: Array<{ text: string }> }).richText.map((p) => p.text).join('')
    }
    if (typeof value === 'object' && 'text' in (value as object)) {
      return (value as { text: string }).text
    }
    return value as Datum
  }
  const header: string[] = []
  for (let c = 1; c <= maxCol; c += 1) header.push(pyValueStr(cell(1, c) as CellValue))
  const rows: Datum[][] = []
  for (let r = 2; r <= maxRow; r += 1) {
    rows.push(Array.from({ length: maxCol }, (_, i) => cell(r, i + 1)))
  }
  return buildColumns(header, rows)
}

function pyFloatRepr(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

function pyDatumStr(value: Datum): string {
  if (value === null) return 'NaN'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : pyFloatRepr(value)
  return value
}

function formatFloatSeries(values: Array<number | null>): string[] {
  const present = values.filter((v): v is number => v !== null)
  const fixed = present.some((v) => {
    const repr = pyFloatRepr(v)
    const dot = repr.indexOf('.')
    return dot !== -1 && repr.length - dot - 1 > 6
  })
  return values.map((v) => (v === null ? 'NaN' : fixed ? v.toFixed(6) : pyFloatRepr(v)))
}

function seriesToString(index: string[], values: string[]): string {
  const w = Math.max(...index.map((s) => s.length), 1)
  const v = Math.max(...values.map((s) => s.length), 1)
  return index.map((idx, i) => idx.padEnd(w, ' ') + '    ' + values[i].padStart(v, ' ')).join('\n')
}

function frameToString(index: string[], header: string[], rows: string[][]): string {
  const blocks = header.map((h, c) => [h, ...rows.map((row) => ' ' + (row[c] ?? ''))])
  const widths = blocks.map((b) => Math.max(...b.map((s) => s.length)))
  const iw = Math.max(index.length > 0 ? Math.max(...index.map((s) => s.length)) : 0, 0)
  const line = (idx: string, cells: string[]): string => {
    let out = idx.padEnd(iw, ' ') + ' '
    cells.forEach((cell, c) => {
      out += cell.padStart(widths[c], ' ')
      if (c < cells.length - 1) out += ' '
    })
    return out
  }
  const printed = [line('', header)]
  index.forEach((idx, r) =>
    printed.push(
      line(
        idx,
        blocks.map((_, c) => (rows[r] ?? [])[c] ?? '')
      )
    )
  )
  return printed.join('\n')
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return Number.NaN
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const STAT_ORDER = [
  'count',
  'unique',
  'top',
  'freq',
  'mean',
  'std',
  'min',
  '25%',
  '50%',
  '75%',
  'max'
]

function describeToString(columns: Column[]): string {
  const header = columns.map((c) =>
    c.dtype === 'int64' || c.dtype === 'float64' ? ` ${c.name}` : c.name
  )
  const perColumn: Array<Record<string, string>> = columns.map((col) => {
    const present = col.values.filter((v): v is number | string | boolean => v !== null)
    const numeric = col.dtype === 'int64' || col.dtype === 'float64'
    const counts = new Map<string, number>()
    for (const v of present) {
      const key = pyDatumStr(v)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let top: string | null = null
    let freq = 0
    for (const [key, n] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > freq) {
        top = key
        freq = n
      }
    }
    const nums = present.map(Number).sort((a, b) => a - b)
    const stat = (v: number | undefined): number | null =>
      v === undefined || Number.isNaN(v) ? null : v
    const mean = nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : undefined
    if (numeric) {
      const stats = [
        stat(present.length),
        stat(mean),
        stat(sampleStd(nums)),
        stat(nums[0]),
        stat(quantile(nums, 0.25)),
        stat(quantile(nums, 0.5)),
        stat(quantile(nums, 0.75)),
        stat(nums[nums.length - 1])
      ]
      const cells = formatFloatSeries(stats)
      return Object.fromEntries(
        ['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max'].map((key, i) => [key, cells[i]])
      )
    }
    return {
      count: pyDatumStr(present.length),
      unique: pyDatumStr(counts.size),
      top: top === null ? 'NaN' : top,
      freq: present.length === 0 ? 'NaN' : pyDatumStr(freq)
    }
  })

  const index = STAT_ORDER.filter((stat) => perColumn.some((cells) => cells[stat] !== undefined))
  const rows = index.map((stat) => columns.map((_c, i) => perColumn[i][stat] ?? 'NaN'))
  return frameToString(index, header, rows)
}

function pandasSummary(columns: Column[]): string {
  const nRows = Math.max(...columns.map((c) => c.values.length), 0)
  const report = [
    '\nPandas Statistical Summary:',
    `Shape: ${nRows} rows x ${columns.length} columns`,
    'Columns & Types:\n' +
      seriesToString(
        columns.map((c) => c.name),
        columns.map((c) => c.dtype)
      )
  ]
  const nullValues = columns.map((c) => String(c.values.filter((v) => v === null).length))
  if (nullValues.some((n) => n !== '0')) {
    const kept = columns
      .map((c, i) => ({ name: c.name, n: Number(nullValues[i]) }))
      .filter((c) => c.n > 0)
    report.push(
      '\nMissing Values:\n' +
        seriesToString(
          kept.map((c) => c.name),
          kept.map((c) => String(c.n))
        )
    )
  }
  report.push('\nNumeric Describe:\n' + describeToString(columns))
  return report.join('\n')
}

type ExcelJsBuffer = Parameters<ExcelJS.Xlsx['load']>[0]

function asExcelJsBuffer(data: Uint8Array): ExcelJsBuffer {
  return data as unknown as ExcelJsBuffer
}

interface LoadedWorkbook {
  wb: ExcelJS.Workbook
  sheetnames: string[]
}

const SUPPORTED_FORMATS = ['.xlsx', '.xlsm', '.xltx', '.xltm']

function requireWorkbookSuffix(full: string): void {
  const ext = extname(full).toLowerCase()
  if (SUPPORTED_FORMATS.includes(ext)) return
  let msg: string
  if (ext === '.xls')
    msg =
      'openpyxl does not support the old .xls file format, please use xlrd to read this file, ' +
      'or convert it to the more recent .xlsx file format.'
  else if (ext === '.xlsb')
    msg =
      'openpyxl does not support binary format .xlsb, please convert this file to .xlsx ' +
      'format if you want to open it with openpyxl'
  else
    msg =
      `openpyxl does not support ${ext} file format, please check you can open it with Excel first. ` +
      `Supported formats are: ${SUPPORTED_FORMATS.join(',')}`
  throw new PythonError('InvalidFileException', msg)
}

const ARC_WORKBOOK = 'xl/workbook.xml'

const WORKBOOK_TYPES = [
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
]

async function findWorkbookPart(zip: JSZip): Promise<string> {
  const { overrides, defaultTypes } = await manifest(zip)
  for (const type of WORKBOOK_TYPES) {
    const found = overrides.find((entry) => entry.contentType === type)
    if (found) return found.partName
    if (defaultTypes.includes(type)) return ARC_WORKBOOK
  }
  throw noWorkbookPart()
}

async function sheetRoster(zip: JSZip, workbookPart: string): Promise<string[]> {
  const xml = (await zip.file(workbookPart)?.async('string')) ?? ''
  const rels = await relationshipsOf(zip, workbookPart)
  const names: string[] = []
  for (const tag of xml.match(/<sheet\b[^>]*>/gu) ?? []) {
    const attr = (name: string): string =>
      new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag)?.[1] ?? ''
    const id = attr('r:id')
    if (id === '') continue
    const rel = rels.find((candidate) => candidate.id === id)
    if (rel === undefined) throw bareKeyError(id)
    if (!hasMember(zip, rel.target)) continue
    names.push(attr('name'))
  }
  return names
}

async function loadWorkbook(full: string): Promise<LoadedWorkbook> {
  requireWorkbookSuffix(full)
  const archive = await openArchive(full)
  if ('notAZip' in archive) throw badZipFile()
  const { zip } = archive
  if (!hasMember(zip, CONTENT_TYPES)) throw archiveKeyError(CONTENT_TYPES)
  const workbookPart = await findWorkbookPart(zip)
  const sheetnames = await sheetRoster(zip, workbookPart)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(asExcelJsBuffer(await readFile(full)))
  for (const ws of wb.worksheets) if (!sheetnames.includes(ws.name)) wb.removeWorksheet(ws.id)
  return { wb, sheetnames }
}

const PEEK_SIZE = 8

const XLS_SIGNATURES = [
  Buffer.from([0x09, 0x00, 0x04, 0x00, 0x07, 0x00, 0x10, 0x00]),
  Buffer.from([0x09, 0x02, 0x06, 0x00, 0x00, 0x00, 0x10, 0x00]),
  Buffer.from([0x09, 0x04, 0x06, 0x00, 0x00, 0x00, 0x10, 0x00]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
]

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04])

function startsWithBytes(peek: Buffer, signature: Buffer): boolean {
  return peek.length >= signature.length && peek.subarray(0, signature.length).equals(signature)
}

type ExcelFormat = 'none' | 'xls' | 'xlsx' | 'xlsb' | 'ods' | 'zip'

async function excelContentFormat(full: string): Promise<ExcelFormat> {
  const data = await readFile(full)
  const peek = data.subarray(0, PEEK_SIZE)
  if (XLS_SIGNATURES.some((signature) => startsWithBytes(peek, signature))) return 'xls'
  if (!startsWithBytes(peek, ZIP_SIGNATURE)) return 'none'
  const archive = await openArchive(full)
  if ('notAZip' in archive) throw badZipFile()
  const names = new Set(
    memberNames(archive.zip).map((name) => name.replace(/\\/gu, '/').toLowerCase())
  )
  if (names.has(ARC_WORKBOOK)) return 'xlsx'
  if (names.has('xl/workbook.bin')) return 'xlsb'
  if (names.has('content.xml')) return 'ods'
  return 'zip'
}

function importFailed(installName: string, extra = ''): PythonError {
  return new PythonError(
    'ImportError',
    `\`Import ${installName}\` failed. ${extra} Use pip or conda to install the ${installName} package.`
  )
}

const MISSING_READERS: Record<string, { installName: string; extra: string }> = {
  xls: { installName: 'xlrd', extra: 'Install xlrd >= 2.0.1 for xls Excel support' },
  xlsb: { installName: 'pyxlsb', extra: '' },
  ods: { installName: 'odfpy', extra: '' }
}

async function readExcelWithPandas(full: string): Promise<LoadedWorkbook> {
  const format = await excelContentFormat(full)
  if (format === 'none')
    throw new PythonError(
      'ValueError',
      'Excel file format cannot be determined, you must specify an engine manually.'
    )
  if (format === 'zip')
    throw new PythonError('OptionError', `No such keys(s): 'io.excel.zip.reader'`)
  const missing = MISSING_READERS[format]
  if (missing !== undefined) throw importFailed(missing.installName, missing.extra)
  return loadWorkbook(full)
}

function pandasFirstSheet(loaded: LoadedWorkbook): ExcelJS.Worksheet {
  const name = loaded.sheetnames[0]
  const ws = name === undefined ? undefined : loaded.wb.getWorksheet(name)
  if (ws === undefined) throw new PythonError('IndexError', 'list index out of range')
  return ws
}

function activeSheetName(wb: ExcelJS.Workbook, sheetnames: string[]): string {
  const tab = wb.views?.[0]?.activeTab ?? 0
  return sheetnames[tab] ?? sheetnames[0] ?? ''
}

function sheetExtent(ws: ExcelJS.Worksheet): { rows: number; cols: number } {
  return { rows: ws.actualRowCount, cols: ws.actualColumnCount }
}

function isCsvPath(full: string): boolean {
  return extname(full).toLowerCase() === '.csv'
}

const excelRead: ToolSpec = {
  python: 'tool_excel_read',
  params: [
    { name: 'path', required: true },
    { name: 'sheet', default: null },
    { name: 'max_rows', default: 100 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) {
      throw new ToolError(`Spreadsheet not found: ${label(args.path)}`)
    }
    const maxRows = Math.max(1, Math.min(pyIntValue(pyOr(args.max_rows, 100)), 1000))

    if (isCsvPath(full)) {
      const [text] = await ctx.fileOps.readTextFile(full)
      const reader = pyCsvReader(text)
      const lines = [`CSV File: ${ctx.paths.rel(full)} (${reader.length} total rows)`]
      for (const [idx, row] of reader.slice(0, maxRows).entries()) {
        lines.push(`${String(idx + 1).padStart(4, ' ')}| ` + row.map((c) => pyStr(c)).join(' | '))
      }
      return lines.join('\n')
    }

    const { wb, sheetnames } = await loadWorkbook(full)
    const wanted = args.sheet === null || args.sheet === undefined ? null : pyStr(args.sheet)
    const target =
      wanted !== null && sheetnames.includes(wanted) ? wanted : activeSheetName(wb, sheetnames)
    const ws = wb.getWorksheet(target)
    if (!ws) throw new ToolError(`Spreadsheet not found: ${label(args.path)}`)
    const { rows, cols } = sheetExtent(ws)
    const lines = [
      `Workbook: ${ctx.paths.rel(full)} | Sheets: ${sheetnames.join(', ')}`,
      `Active Sheet: ${target} (${rows} rows x ${cols} cols)\n`
    ]
    for (let r = 1; r <= rows; r += 1) {
      if (r > maxRows) {
        lines.push(`... [truncated after ${maxRows} rows]`)
        break
      }
      const formatted = Array.from({ length: cols }, (_, i) =>
        pyValueStr(ws.getRow(r).getCell(i + 1).value as CellValue)
      )
      if (formatted.some((f) => f !== '')) {
        lines.push(`${String(r).padStart(4, ' ')}| ` + formatted.join(' | '))
      }
    }
    return lines.join('\n')
  }
}

const excelAnalyze: ToolSpec = {
  python: 'tool_excel_analyze',
  params: [{ name: 'path', required: true }],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsFile(full))) {
      throw new ToolError(`Spreadsheet not found: ${label(args.path)}`)
    }
    const report = [`Spreadsheet Analysis: ${ctx.paths.rel(full)}`]

    try {
      const { wb, sheetnames } = await loadWorkbook(full)
      report.push(`Sheets (${sheetnames.length}): ${sheetnames.join(', ')}`)
      for (const name of sheetnames) {
        const ws = wb.getWorksheet(name)
        if (!ws) continue
        const { rows, cols } = sheetExtent(ws)
        let formulaCount = 0
        let nonEmpty = 0
        for (let r = 1; r <= rows; r += 1) {
          for (let c = 1; c <= cols; c += 1) {
            const value = ws.getRow(r).getCell(c).value
            if (value !== null && value !== undefined) {
              nonEmpty += 1
              const text =
                typeof value === 'object' && 'formula' in (value as object)
                  ? `=${(value as { formula: string }).formula}`
                  : typeof value === 'object' && 'sharedFormula' in (value as object)
                    ? `=${(value as { sharedFormula: string }).sharedFormula}`
                    : value
              if (typeof text === 'string' && text.startsWith('=')) formulaCount += 1
            }
          }
        }
        report.push(
          `  - [${name}]: ${rows} rows x ${cols} cols | ` +
            `Populated cells: ${pyFormatThousands(nonEmpty)} | Formulas: ${formulaCount}`
        )
      }
    } catch (e) {
      report.push(`openpyxl inspection note: ${errorMessage(e)}`)
    }

    try {
      const columns = isCsvPath(full)
        ? csvColumns(pyCsvReader((await ctx.fileOps.readTextFile(full))[0]))
        : sheetColumns(pandasFirstSheet(await readExcelWithPandas(full)))
      report.push(pandasSummary(columns))
    } catch (e) {
      report.push(`Pandas statistical summary note: ${errorMessage(e)}`)
    }
    return report.join('\n')
  }
}

const excelWrite: ToolSpec = {
  python: 'tool_excel_write',
  params: [
    { name: 'path', required: true },
    { name: 'headers', required: true },
    { name: 'rows', required: true },
    { name: 'sheet_name', default: 'Sheet1' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    if (!(await ctx.allowed('excel_write', rel))) {
      throw new ToolError('The user denied Excel write.')
    }
    const headers = args.headers as unknown[]
    const rows = (args.rows ?? []) as unknown[][]
    const sheetName = pyStr(pyOr(args.sheet_name, 'Sheet1')) || 'Sheet1'

    const exists = await pathIsFile(full)
    let wb = new ExcelJS.Workbook()
    if (exists) wb = (await loadWorkbook(full)).wb
    let ws = wb.getWorksheet(sheetName)
    if (!ws) ws = wb.addWorksheet(sheetName)
    if (exists) ws.spliceRows(1, ws.rowCount)

    if (Array.isArray(headers) && headers.length > 0) {
      ws.addRow(headers.map((h) => (h === null ? '' : h)))
      for (let c = 1; c <= headers.length; c += 1) {
        const cell = ws.getRow(1).getCell(c)
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }
        cell.alignment = { horizontal: 'center' }
      }
    }

    const parsed = (val: unknown): string | number => {
      if (typeof val !== 'string') return (val ?? '') as string | number
      if (/^-?\d+$/u.test(val)) return parseInt(val, 10)
      if (/^-?\d+\.\d+$/u.test(val)) return parseFloat(val)
      return val
    }
    for (const row of rows) {
      if (Array.isArray(row)) ws.addRow(row.map(parsed))
    }

    for (let c = 1; c <= ws.columnCount; c += 1) {
      let maxLen = 0
      for (let r = 1; r <= ws.rowCount; r += 1) {
        const v = ws.getRow(r).getCell(c).value
        maxLen = Math.max(maxLen, pyValueStr(v as CellValue).length)
      }
      const letter = ws.getColumn(c).letter
      if (letter) ws.getColumn(c).width = Math.min(Math.max(maxLen + 3, 12), 50)
    }

    await mkdir(dirname(full), { recursive: true })
    await ctx.beginBinaryArtifact(full)
    await writeFile(full, Buffer.from(await wb.xlsx.writeBuffer()))
    const summary = `Wrote Excel workbook ${rel} [sheet=${sheetName}, headers=${headers.length}, rows=${rows.length}]`
    await ctx.recordBinaryArtifact(full, 'created', summary)
    return summary
  }
}

export const EXCEL_TOOLS: Record<string, ToolSpec> = {
  excel_read: excelRead,
  excel_analyze: excelAnalyze,
  excel_write: excelWrite
}
