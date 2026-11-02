import { pyFormatThousands } from './pyformat'
import { pyLen, pySlice, pySplitlines, pyStrip } from './pystr'

const ENTRY_MARKER = '## Interaction Log - '
const RECENT_LIMIT = 5

export interface MemoryReportInput {
  text: string
  database: string
  documentKey: string
}

interface MemoryToolRun {
  name: string
  failed: boolean
}

interface MemoryFileChange {
  action: string
  path: string
}

interface MemoryEntry {
  timestamp: string
  mode: string
  suite: string
  model: string
  prompt: string
  tools: MemoryToolRun[]
  files: MemoryFileChange[]
  characters: number
}

const TOOL_HEADER = /^####\s+3\.\d+\s+`([^`]+)`\s+\[(OK|ERROR)\]/
const FILE_HEADER = /^####\s+4\.\d+\s+([A-Za-z]+):\s+`([^`]+)`/

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

function shortTimestamp(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(timestamp) ? timestamp.slice(0, 19) : timestamp
}

function snippet(text: string, limit: number): string {
  const flat = pyStrip(text.replace(/\s+/g, ' '))
  if (flat === '') return ''
  return pyLen(flat) <= limit ? flat : `${pySlice(flat, 0, limit - 1)}…`
}

function entryField(body: string, label: string): string {
  const prefix = `- **${label}:**`
  for (const line of pySplitlines(body)) {
    if (line.startsWith(prefix)) {
      return pyStrip(line.slice(prefix.length)).replaceAll('`', '')
    }
  }
  return ''
}

function promptText(body: string): string {
  const lines = pySplitlines(body)
  const heading = lines.findIndex((line) => pyStrip(line) === '### 1. Exact User Prompt')
  if (heading === -1) return ''
  for (let index = heading + 1; index < lines.length; index += 1) {
    const trimmed = pyStrip(lines[index])
    const open = /^(`{3,})[^`]*$/.exec(trimmed)
    if (open === null) {
      if (trimmed.startsWith('### ')) break
      continue
    }
    const fence = open[1]
    const parts: string[] = []
    let length = 0
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const candidate = pyStrip(lines[inner])
      if (candidate === fence) break
      if (candidate === '' || /^`{3,}[A-Za-z0-9_-]*$/.test(candidate)) continue
      parts.push(candidate)
      length += candidate.length
      if (length >= 1000) break
    }
    return parts.join(' ')
  }
  return ''
}

function parseEntry(timestamp: string, body: string): MemoryEntry {
  const tools: MemoryToolRun[] = []
  const files: MemoryFileChange[] = []
  for (const line of pySplitlines(body)) {
    const tool = TOOL_HEADER.exec(line)
    if (tool !== null) {
      tools.push({ name: tool[1], failed: tool[2] === 'ERROR' })
      continue
    }
    const file = FILE_HEADER.exec(line)
    if (file !== null) files.push({ action: file[1], path: file[2] })
  }
  return {
    timestamp,
    mode: entryField(body, 'Mode'),
    suite: entryField(body, 'Active Function Suite'),
    model: entryField(body, 'Model'),
    prompt: promptText(body),
    tools,
    files,
    characters: pyLen(body)
  }
}

function entryStarts(text: string): number[] {
  const starts: number[] = []
  let fence = ''
  let offset = 0
  for (const line of pySplitlines(text, true)) {
    const trimmed = pyStrip(line)
    if (fence === '') {
      const open = /^(`{3,})/.exec(trimmed)
      if (open !== null) fence = open[1]
      else if (trimmed.startsWith(ENTRY_MARKER)) starts.push(offset)
    } else if (trimmed.length >= fence.length && /^`{3,}$/.test(trimmed)) {
      fence = ''
    }
    offset += line.length
  }
  return starts
}

function parseEntries(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  const starts = entryStarts(text)
  for (let index = 0; index < starts.length; index += 1) {
    const at = starts[index]
    const headerEnd = text.indexOf('\n', at)
    const lineEnd = headerEnd === -1 ? text.length : headerEnd
    const timestamp = pyStrip(text.slice(at + ENTRY_MARKER.length, lineEnd).replace(/\r$/, ''))
    const bodyStart = headerEnd === -1 ? text.length : headerEnd + 1
    const bodyEnd = index + 1 < starts.length ? starts[index + 1] : text.length
    entries.push(parseEntry(timestamp, text.slice(bodyStart, bodyEnd)))
  }
  return entries
}

function failureNote(tools: MemoryToolRun[]): string {
  const failed = tools.filter((tool) => tool.failed)
  if (failed.length === 0) return ''
  const names = [...new Set(failed.map((tool) => tool.name))].slice(0, 3).join(', ')
  return failed.length === 1 ? ` · failed: ${names}` : ` · failed ${failed.length}: ${names}`
}

function toolSummary(tools: MemoryToolRun[]): string {
  if (tools.length === 0) return 'none'
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  const names = [...counts.entries()]
    .slice(0, 4)
    .map(([name, count]) => (count === 1 ? name : `${name} ×${count}`))
  if (counts.size > 4) names.push(`+${counts.size - 4} more`)
  return `${plural(tools.length, 'execution')} · ${names.join(', ')}${failureNote(tools)}`
}

function fileSummary(files: MemoryFileChange[]): string {
  if (files.length === 0) return 'none'
  const shown = files.slice(0, 3).map((file) => `${file.action.toLowerCase()} ${file.path}`)
  const extra = files.length > 3 ? `, +${files.length - 3} more` : ''
  return `${plural(files.length, 'change')} · ${shown.join(', ')}${extra}`
}

function aggregateTools(allTools: MemoryToolRun[]): string {
  if (allTools.length === 0) return '- Tool executions: none'
  return `- Tool executions: ${pyFormatThousands(allTools.length)}${failureNote(allTools)}`
}

function aggregateFiles(allFiles: MemoryFileChange[]): string {
  if (allFiles.length === 0) return '- File changes: none'
  const counts = new Map<string, number>()
  for (const file of allFiles) {
    const action = file.action.toLowerCase()
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([action, count]) => `${count} ${action}`)
    .join(', ')
  return `- File changes: ${pyFormatThousands(allFiles.length)} · ${breakdown}`
}

export function buildMemoryHistoryReport(input: MemoryReportInput): string {
  const { text, database, documentKey } = input
  const entries = parseEntries(text)
  const lines = [
    '# Memory History',
    '',
    '## Storage',
    `- Database: ${database}`,
    `- Document key: ${documentKey}`,
    '- Backend: SQLite conversation database',
    `- Journal size: ${pyFormatThousands(pyLen(text))} chars across ` +
      `${pyFormatThousands(pySplitlines(text).length)} lines`,
    '',
    '## Journal',
    `- Logged Interactions: ${pyFormatThousands(entries.length)}`
  ]

  if (entries.length === 0) {
    lines.push('- No interactions logged yet. Each completed turn is appended automatically.')
    return lines.join('\n')
  }

  const allTools = entries.flatMap((entry) => entry.tools)
  const allFiles = entries.flatMap((entry) => entry.files)
  const totalChars = entries.reduce((sum, entry) => sum + entry.characters, 0)
  lines.push(
    `- Oldest entry: ${shortTimestamp(entries[0].timestamp)}`,
    `- Newest entry: ${shortTimestamp(entries[entries.length - 1].timestamp)}`,
    `- Average entry: ${pyFormatThousands(Math.round(totalChars / entries.length))} chars`,
    aggregateTools(allTools),
    aggregateFiles(allFiles)
  )

  const latest = entries[entries.length - 1]
  lines.push(
    '',
    '## Latest interaction',
    `- Logged at: ${shortTimestamp(latest.timestamp)}`,
    `- Mode: ${latest.mode || 'unknown'}`,
    `- Function suite: ${latest.suite || 'default'}`,
    `- Model: ${latest.model || 'unknown'}`,
    `- Prompt: ${snippet(latest.prompt, 160) || '(no prompt text recorded)'}`,
    `- Tools: ${toolSummary(latest.tools)}`,
    `- Files: ${fileSummary(latest.files)}`
  )

  if (entries.length > 1) {
    lines.push('', '## Recent interactions')
    for (const entry of entries.slice(-RECENT_LIMIT).reverse()) {
      const prompt = snippet(entry.prompt, 80) || '(no prompt text recorded)'
      lines.push(
        `- ${shortTimestamp(entry.timestamp)} · ${entry.mode || 'unknown'} · ` +
          `${entry.suite || 'default'} · ${prompt}`
      )
    }
  }

  return lines.join('\n')
}
