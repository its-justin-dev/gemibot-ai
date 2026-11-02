import { pyFormatFixed } from '../../shared/utils/pyformat'
import { pyJsonDumps } from '../../shared/utils/pyjson'
import { pyTime } from '../../shared/utils/pytime'
import { nowStrftime } from '../../shared/utils/strftime'
import type { TimelineEvent } from '../models/agent-state'
import { onConsoleOutput } from '../utils/console-out'
import type { MemoryIO } from './memory-store.service'

export const CHAT_HEADER =
  '======================== App Memory (Chat and Response) ================================'
export const CONSOLE_HEADER =
  '=========================== App Memory (Console) ==================================='
export const AI_HEADER =
  '=========================== App Memory (AI Written) ==================================='

const RULE = '='.repeat(82)
const START_PREFIX = '<!-- gemibot:conversation:start '
const END_PREFIX = '<!-- gemibot:conversation:end '
const SENTINEL_SUFFIX = ' -->'
const FLUSH_INTERVAL_MS = 1000
const NO_CONSOLE = '(No console output.)'
const NO_AI_NOTES = '(Nothing written by the model yet.)'
/** A whole-file `old_string` is what makes a log unreadable, so long values get summarised. */
const MAX_VALUE_LINES = 24
const MAX_INLINE_CHARS = 320

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\r/g

/** The header of a journal block; `begin()` assigns the id from the ids already recorded. */
export interface JournalMeta {
  model: string
  effort: string
  mode: string
}

type OpenBlock = JournalMeta & { id: string }

interface Entry {
  at: string
  label: string
  body: string
}

/**
 * The app's own record of a conversation, written live into the conversation database.
 *
 * One block per turn, four parts: the header, everything the timeline saw, everything the
 * console printed, and whatever the model wrote for itself. The block always sits at the tail
 * of the document, so a flush truncates back to its start offset and rewrites only that tail —
 * the megabytes of history above it are never re-read or re-written.
 */
export class ConversationJournal {
  private meta: OpenBlock | null = null
  private entries: Entry[] = []
  private consoleLines: string[] = []
  private aiWritten: string[] = []
  private blockStart = 0
  private startedAt = 0
  private finishedAt: number | null = null
  private lastFlushAt = 0
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private detachSink: (() => void) | null = null

  constructor(private readonly memoryIO: MemoryIO) {}

  /** Opens the block for a new turn, closing an abandoned block first if one never ended. */
  async begin(meta: JournalMeta, prompt: string): Promise<void> {
    if (this.meta !== null) await this.end('Superseded by a new turn.')

    this.meta = { ...meta, id: nextConversationId(await this.memoryIO.read()) }
    this.blockStart = await this.memoryIO.size()
    this.startedAt = pyTime()
    this.finishedAt = null
    this.lastFlushAt = 0
    this.entries = [{ at: clock(), label: 'User', body: prompt }]
    this.consoleLines = []
    this.aiWritten = []

    this.detachSink = onConsoleOutput((text, terminator) => {
      if (terminator === '\n') this.recordConsole(text)
    })

    await this.flush()
  }

  record(label: string, body: string): void {
    if (this.meta === null || body.trim() === '') return
    this.entries.push({ at: clock(), label, body })
    this.touch()
  }

  recordEvent(event: TimelineEvent): void {
    if (this.meta === null) return
    const tool = String(event.tool ?? 'action')
    const failed = Boolean(event.is_error)
    const status = String(event.status ?? (failed ? 'Failed' : 'Success'))
    const seconds =
      typeof event.duration === 'number' ? ` ${pyFormatFixed(event.duration, 3)}s` : ''
    const args = (event.args ?? {}) as Record<string, unknown>
    const keys = Object.keys(args)
    const lines = [
      ...(keys.length === 0
        ? ['  args: (none)']
        : ['  args:', ...keys.flatMap((key) => valueLines('    ', key, scalarText(args[key])))]),
      ...valueLines('  ', 'output', scalarText(event.output)),
      ...fileChangeLines(event.file_changes)
    ]
    this.entries.push({
      at: String(event.timestamp ?? clock()),
      label: `${tool} [${status}]${seconds}`,
      body: lines.join('\n')
    })
    this.touch()
  }

  recordConsole(text: string): void {
    if (this.meta === null) return
    // `out()` hands over one complete console write, which may itself span lines when the
    // caller prefixes it with a blank separator.
    const clean = text.replace(ANSI_RE, '')
    if (clean.trim() === '') return
    this.consoleLines.push(clean)
    this.touch()
  }

  /** Text the model appended after our block; it becomes part 4 and leaves the file tail. */
  recordAiWritten(text: string): void {
    const clean = text.replace(/^\n+|\n+$/g, '')
    if (clean !== '') this.aiWritten.push(clean)
  }

  /** Closes the block, freezing Duration. Idempotent, and safe to call when never opened. */
  async end(note?: string): Promise<void> {
    if (this.meta === null) return
    if (note) this.record('Turn', note)
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.finishedAt = pyTime()
    this.detachSink?.()
    this.detachSink = null
    await this.flush()
    this.meta = null
  }

  /** Rewrites the block at most once a second, with the trailing flush always honoured. */
  private touch(): void {
    if (this.timer !== null) return
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - this.lastFlushAt))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, wait)
    this.timer.unref?.()
  }

  private async flush(): Promise<void> {
    if (this.meta === null) return
    if (this.finishedAt === null && Date.now() - this.lastFlushAt < FLUSH_INTERVAL_MS) return
    const id = this.meta.id
    this.lastFlushAt = Date.now()
    // Serialised so a slow disk can never interleave two truncations.
    this.writing = this.writing.then(() => this.writeBlock(id))
    await this.writing
  }

  private async writeBlock(id: string): Promise<void> {
    try {
      const io = this.memoryIO
      const startMark = `${START_PREFIX}${id}${SENTINEL_SUFFIX}`
      const endMark = `${END_PREFIX}${id}${SENTINEL_SUFFIX}`
      const size = await io.size()
      let offset = Math.min(this.blockStart, size)
      let tail = size > offset ? await io.tail(offset) : ''

      if (!tail.startsWith(startMark)) {
        // Something rewrote or truncated the tail; relocate the block, else start a new one.
        const whole = await io.read()
        const at = whole.indexOf(startMark)
        offset = at === -1 ? size : Buffer.byteLength(whole.slice(0, at), 'utf-8')
        tail = size > offset ? await io.tail(offset) : ''
      }

      const endAt = tail.indexOf(endMark)
      if (endAt !== -1) {
        this.recordAiWritten(tail.slice(endAt + endMark.length))
      }

      const block = this.render(id)
      if (block === null) return
      await io.replaceTail(offset, block)
      this.blockStart = offset
    } catch {
      // Journalling must never break the turn it is recording.
    }
  }

  private render(id: string): string | null {
    const meta = this.meta
    if (meta === null) return null
    const seconds = pyFormatFixed((this.finishedAt ?? pyTime()) - this.startedAt, 1)
    const body = [
      RULE,
      `Conversation ID: ${id}`,
      `Date: ${nowStrftime('%Y-%m-%d', new Date(this.startedAt * 1000))}`,
      `Time: ${nowStrftime('%H:%M:%S', new Date(this.startedAt * 1000))}`,
      `Model: ${meta.model}`,
      `Effort: ${meta.effort}`,
      `Mode: ${meta.mode.toUpperCase()}`,
      `Duration: ${seconds}s`,
      RULE,
      '',
      CHAT_HEADER,
      '',
      ...this.entries.map(entryBlock),
      CONSOLE_HEADER,
      '',
      ...(this.consoleLines.length > 0 ? this.consoleLines : [NO_CONSOLE]),
      '',
      AI_HEADER,
      '',
      ...(this.aiWritten.length > 0 ? [this.aiWritten.join('\n\n')] : [NO_AI_NOTES]),
      ''
    ].join('\n')

    // Fenced so a markdown editor shows the block verbatim instead of re-rendering every
    // heading, table pipe and `#` that the console or the model's own notes contain.
    const fence = fenceFor(body)
    return [
      `${START_PREFIX}${id}${SENTINEL_SUFFIX}`,
      `${fence}text`,
      body,
      fence,
      `${END_PREFIX}${id}${SENTINEL_SUFFIX}`,
      ''
    ].join('\n')
  }
}

function entryBlock(entry: Entry): string {
  const body = entry.body.replace(/\s+$/, '')
  const lines = [`[${entry.at}] ${entry.label}`]
  for (const line of body.split('\n')) lines.push(`  ${line}`)
  return `${lines.join('\n')}\n`
}

function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return pyJsonDumps(value, { ensureAscii: false })
}

/** `key: value` on one line, or `key:` with the value indented below it. */
function valueLines(prefix: string, key: string, raw: string): string[] {
  const text = raw.replace(ANSI_RE, '').replace(/\s+$/, '')
  if (text === '') return [`${prefix}${key}: (empty)`]
  const lines = text.split('\n')
  if (lines.length === 1) {
    const one = lines[0]
    if (one.length <= MAX_INLINE_CHARS) return [`${prefix}${key}: ${one}`]
    return [
      `${prefix}${key}: ${one.slice(0, MAX_INLINE_CHARS)} ... ${one.length - MAX_INLINE_CHARS} more char(s)`
    ]
  }
  const shown = lines.slice(0, MAX_VALUE_LINES)
  const out = [`${prefix}${key}:`, ...shown.map((line) => `${prefix}  ${line}`)]
  if (lines.length > shown.length) {
    out.push(`${prefix}  ... ${lines.length - shown.length} more line(s)`)
  }
  return out
}

function fileChangeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const lines: string[] = []
  for (const change of value) {
    const c = change as Record<string, unknown> | null
    if (c === null || typeof c !== 'object') continue
    lines.push(`  ${String(c.action ?? 'change').toUpperCase()} ${String(c.path ?? '?')}`)
  }
  return lines
}

function clock(): string {
  return nowStrftime('%H:%M:%S')
}

/** `CONV-00000000000001`, one past the highest id already recorded in the memory document. */
export function nextConversationId(memoryText: string): string {
  let max = 0
  const re = /Conversation ID: CONV-(\d+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(memoryText)) !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return `CONV-${String(max + 1).padStart(14, '0')}`
}

/**
 * What the model is fed from memory: each journal block collapses to its part 4, so the app's
 * live transcript and console noise never displace the model's own notes.
 */
export function stripForPrompt(text: string): string {
  const startRe = /<!-- gemibot:conversation:start (CONV-\d+) -->/g
  const blocks: { start: number; end: number; id: string }[] = []
  let match: RegExpExecArray | null
  while ((match = startRe.exec(text)) !== null) {
    const id = match[1]
    const endMark = `${END_PREFIX}${id}${SENTINEL_SUFFIX}`
    const end = text.indexOf(endMark, match.index)
    blocks.push({
      start: match.index,
      end: end === -1 ? text.length : end + endMark.length,
      id
    })
  }
  if (blocks.length === 0) return text

  let out = text
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { start, end } = blocks[i]
    const body = out.slice(start, end)
    const aiAt = body.indexOf(AI_HEADER)
    // Part 4 runs from its header down to the fence that closes the block, if it is fenced.
    const notes = aiAt === -1 ? '' : partFour(body.slice(aiAt + AI_HEADER.length))
    const kept = notes === '' || notes === NO_AI_NOTES ? '' : `${notes}\n`
    out = out.slice(0, start) + kept + out.slice(end)
  }
  return out
}

function partFour(afterHeader: string): string {
  const lines = afterHeader.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^`{3,}$/.test(lines[i].trim())) return lines.slice(0, i).join('\n').trim()
  }
  return afterHeader.trim()
}
