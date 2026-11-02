import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'

import { AppConstants } from '../../shared/constants/app-constants'
import { nowStrftime } from '../../shared/utils/strftime'
import { contentModelValidateJson } from '../models/content'
import {
  conversationRepository,
  deriveTitle,
  type ConversationRepository
} from './conversation-repository.service'
import { out } from '../utils/console-out'

/**
 * The only module allowed to read the last file-backed session (`/.gemibot/session.json`).
 *
 * SQLite is the live store; this import runs once per source and then never again.  The old
 * file is never modified or removed, and the import is recorded in `imported_files`, so
 * running the app twice imports nothing twice.
 */

export interface LegacyImportReport {
  imported: number
  warnings: string[]
  errors: string[]
  sessionFile: string | null
}

interface ParsedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: number
  model?: string
  effortLevel?: string
  status?: string
  durationMs?: number
  toolCalls?: unknown
  toolResult?: unknown
  /** A timeline event (`action` payload) rebuilt from a tool row. */
  event?: Record<string, unknown>
}

export class LegacyImportService {
  private readonly repo: ConversationRepository

  constructor(repo?: ConversationRepository) {
    this.repo = repo ?? conversationRepository
  }

  async importExistingSessions(root?: string): Promise<LegacyImportReport> {
    const base = resolve(root ?? process.cwd())
    const report: LegacyImportReport = {
      imported: 0,
      warnings: [],
      errors: [],
      sessionFile: null
    }

    const sessionFile = join(base, AppConstants.SESSION_DIR, 'session.json')
    const session = await this.readText(sessionFile)
    if (session !== null) {
      report.sessionFile = sessionFile
      try {
        if (await this.importSession(sessionFile, session, report)) report.imported += 1
      } catch (error) {
        report.errors.push(`session.json: ${messageOf(error)}`)
        out(`Legacy import error (session.json): ${messageOf(error)}`)
      }
    }

    if (report.imported > 0) {
      out(`Legacy import: imported ${report.imported} conversation(s).`)
    }
    for (const warning of report.warnings) out(`Legacy import warning: ${warning}`)
    for (const error of report.errors) out(`Legacy import error: ${error}`)
    return report
  }

  private async importSession(
    path: string,
    text: string,
    report: LegacyImportReport
  ): Promise<boolean> {
    if (this.repo.isImported(path, 'session:v1')) return false
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch (error) {
      report.warnings.push(`session.json could not be parsed: ${messageOf(error)}`)
      this.repo.recordImported(path, 'session:v1', hash(text), null)
      return false
    }

    const timeline = Array.isArray(data['timeline_history'])
      ? (data['timeline_history'] as Record<string, unknown>[])
      : []
    const contents = Array.isArray(data['contents']) ? (data['contents'] as unknown[]) : []
    if (timeline.length === 0 && contents.length === 0) return false

    const mtime = await fileMtime(path)
    const when = mtime > 0 ? mtime : Date.now()
    const messages: ParsedMessage[] = []
    let lastSeconds = -1
    let dayOffset = 0

    for (const turn of timeline) {
      const prompt = typeof turn['prompt'] === 'string' ? turn['prompt'] : ''
      const time = typeof turn['timestamp'] === 'string' ? turn['timestamp'] : ''
      const parsedTime = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
      if (parsedTime !== null) {
        const seconds =
          Number(parsedTime[1]) * 3600 + Number(parsedTime[2]) * 60 + Number(parsedTime[3])
        if (lastSeconds >= 0 && seconds < lastSeconds) dayOffset += 1
        lastSeconds = seconds
      }
      const createdAt = dateTimeAt(when, time, dayOffset)
      if (prompt.trim() !== '') {
        messages.push({ role: 'user', content: prompt, createdAt })
      }
      const replies = Array.isArray(turn['replies']) ? (turn['replies'] as unknown[]) : []
      for (const reply of replies) {
        if (typeof reply !== 'string' || reply.trim() === '') continue
        messages.push({ role: 'assistant', content: reply, createdAt })
      }
      const events = Array.isArray(turn['events']) ? (turn['events'] as unknown[]) : []
      for (const event of events) {
        if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
        const ev = event as Record<string, unknown>
        const output = typeof ev['output'] === 'string' ? ev['output'] : ''
        messages.push({
          role: 'tool',
          content: output,
          createdAt,
          status: ev['is_error'] === true ? 'failed' : 'success',
          durationMs:
            typeof ev['duration'] === 'number' ? Math.round(ev['duration'] * 1000) : undefined,
          toolCalls: ev['args'],
          toolResult: { output, is_error: ev['is_error'] === true, status: ev['status'] },
          event: ev
        })
      }
    }

    if (messages.length === 0 && contents.length > 0) {
      for (const content of contents) messages.push(...messagesFromContent(content))
    }

    const firstUser = messages.find((msg) => msg.role === 'user')
    const conversationId = uniqueId('conv_import')
    this.repo.transaction(() => {
      this.repo.createConversation(
        conversationId,
        firstUser ? deriveTitle(firstUser.content) : 'Imported session',
        null,
        { createdAt: when, updatedAt: when }
      )
      for (const msg of messages) {
        this.addRow(conversationId, msg, null, null)
      }
      for (const content of contents) {
        const json = typeof content === 'string' ? content : JSON.stringify(content)
        try {
          contentModelValidateJson(json)
          this.repo.appendContent(conversationId, json)
        } catch (error) {
          const warning = `session.json contains an unreadable model turn: ${messageOf(error)}`
          report.warnings.push(warning)
          this.repo.addMessage(conversationId, 'system', json, {
            createdAt: when,
            status: 'warning',
            meta: {
              event: {
                kind: 'error',
                title: 'Unreadable model turn',
                message: warning,
                details: json,
                icon: '⚠️',
                header: 'Import'
              }
            }
          })
        }
      }
      this.repo.touchConversation(conversationId, when)
      this.repo.recordImported(path, 'session:v1', hash(text), conversationId)
    })
    out(`Legacy import: restored the previous session as a conversation.`)
    return true
  }

  private addRow(
    conversationId: string,
    msg: ParsedMessage,
    model: string | null,
    effort: string | null
  ): void {
    const options: Parameters<ConversationRepository['addMessage']>[3] = {
      createdAt: msg.createdAt,
      model: msg.model ?? model ?? undefined,
      effortLevel: msg.effortLevel ?? effort ?? undefined,
      status: msg.status,
      durationMs: msg.durationMs,
      toolCalls: msg.toolCalls,
      toolResult: msg.toolResult
    }
    if (msg.event !== undefined) {
      options.meta = { event: { kind: 'action', event: msg.event } }
    }
    this.repo.addMessage(conversationId, msg.role, msg.content, options)
  }

  private async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  }
}

function messagesFromContent(value: unknown): ParsedMessage[] {
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  let content: { role?: string | null; parts?: unknown[] | null }
  try {
    content = contentModelValidateJson(json) as { role?: string | null; parts?: unknown[] | null }
  } catch {
    return [{ role: 'system', content: json, createdAt: Date.now(), status: 'warning' }]
  }
  const texts: string[] = []
  for (const part of content.parts ?? []) {
    if (part === null || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (typeof p['text'] === 'string' && p['thought'] !== true) texts.push(p['text'])
  }
  if (texts.length === 0) return []
  const role = content.role === 'model' || content.role === 'assistant' ? 'assistant' : 'user'
  return [{ role, content: texts.join('\n').trim(), createdAt: Date.now() }]
}

async function fileMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

function timestampFor(date: string, time: string, dayOffset: number): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
  if (parts === null) return Date.now() + dayOffset * 86_400_000
  const year = Number(parts[1])
  const month = Number(parts[2]) - 1
  const day = Number(parts[3])
  const hour = clock ? Number(clock[1]) : 0
  const minute = clock ? Number(clock[2]) : 0
  const second = clock ? Number(clock[3]) : 0
  return new Date(year, month, day, hour, minute, second).getTime() + dayOffset * 86_400_000
}

function dateTimeAt(when: number, time: string, dayOffset: number): number {
  const base = new Date(when)
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
  if (clock === null) return when
  const date = nowStrftime('%Y-%m-%d', base)
  return timestampFor(date, time, dayOffset)
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const legacyImport = new LegacyImportService()
