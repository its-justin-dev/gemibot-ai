import type { WindowEvent } from '../../shared/types/window'
import type { CompactionSaveInput } from '../../shared/types/compaction'
import { nowStrftime } from '../../shared/utils/strftime'
import type { Content } from '../models/content'
import { contentModelDumpJson, contentModelValidateJson } from '../models/content'
import {
  conversationRepository,
  deriveTitle,
  type CompactionRow,
  type ConversationListItem,
  type ConversationRepository,
  type ConversationRow,
  type MessageOptions,
  type MessagePage,
  type MessageRow
} from './conversation-repository.service'

/**
 * The bridge between the engine's live state and the SQLite conversation store.
 *
 * A locked or corrupt database must never abort a turn: the engine keeps working from RAM while
 * the user is told that the chat is not being saved. There is no file fallback.
 */

const HEADER_BULLET = '  •  '

export interface TimelineRowMeta {
  event?: WindowEvent
  cpIdx?: number | null
  contentIndex?: number | null
  hidden?: boolean
}

export interface UserRecordOptions {
  cpIdx?: number | null
  contentIndex?: number | null
  model?: string
  effortLevel?: string
  event?: WindowEvent
  hidden?: boolean
}

export interface AssistantRecordOptions {
  contentIndex?: number | null
  model?: string
  effortLevel?: string
  event?: WindowEvent
  meta?: string
}

export interface ActionRecordOptions {
  contentIndex?: number | null
  model?: string
  effortLevel?: string
}

export interface ConversationPage {
  rows: MessageRow[]
  hasMore: boolean
}

export function parseRowMeta(row: MessageRow): TimelineRowMeta | null {
  if (!row.meta_json) return null
  try {
    const value = JSON.parse(row.meta_json) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as TimelineRowMeta
    }
  } catch {}
  return null
}

function rowTime(createdAt: number): string {
  const date = Number.isFinite(createdAt) ? new Date(createdAt) : new Date()
  return nowStrftime('%H:%M:%S', date)
}

/**
 * Turns a stored row back into the timeline widget it represented. App-written rows carry the
 * exact event in `meta_json`; rows imported from an older store are rebuilt from their columns.
 */
export function eventFromRow(row: MessageRow): WindowEvent | null {
  const meta = parseRowMeta(row)
  if (meta?.event) return meta.event
  if (meta?.hidden) return null
  const timestamp = rowTime(row.created_at)
  if (row.role === 'user') {
    if (row.content.startsWith('/') || row.content.startsWith('!')) return null
    return {
      kind: 'user',
      text: row.content,
      cpIdx: meta?.cpIdx ?? null,
      header: ['You', timestamp].join(HEADER_BULLET),
      timestamp
    }
  }
  if (row.role === 'assistant') {
    const label = row.model || 'GemiBot AI'
    return {
      kind: 'assistant',
      text: row.content,
      meta: '',
      header: [label, timestamp].join(HEADER_BULLET),
      timestamp
    }
  }
  return null
}

export function storedContentIndex(row: MessageRow): number | null {
  const meta = parseRowMeta(row)
  return typeof meta?.contentIndex === 'number' ? meta.contentIndex : null
}

function parsedJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function toolNameOfRow(row: MessageRow): string {
  const meta = parseRowMeta(row)
  const event = meta?.event
  if (event !== undefined && event.kind === 'action') {
    const name = (event.event as Record<string, unknown> | undefined)?.['tool']
    if (typeof name === 'string' && name) return name
  }
  const calls = parsedJson(row.tool_calls)
  if (calls && typeof calls === 'object' && !Array.isArray(calls)) {
    const name = (calls as Record<string, unknown>)['name']
    if (typeof name === 'string' && name) return name
  }
  return 'tool'
}

function toolResponseOfRow(row: MessageRow): Record<string, unknown> {
  const result = parsedJson(row.tool_result)
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }
  return { output: typeof result === 'string' ? result : row.content }
}

export type PersistenceErrorReporter = (message: string, details: string) => void

export class ConversationPersistence {
  private current: string | null = null
  private readonly repo: ConversationRepository
  private errorReporter: PersistenceErrorReporter | null = null
  private lastFailure: { key: string; at: number } | null = null

  constructor(repo: ConversationRepository = conversationRepository) {
    this.repo = repo
  }

  setErrorReporter(reporter: PersistenceErrorReporter | null): void {
    this.errorReporter = reporter
  }

  /** One card per failure window, so a broken store cannot flood the timeline. */
  private failed(action: string, error: unknown): void {
    const details = error instanceof Error ? error.message : String(error)
    const key = `${action}:${details}`
    const now = Date.now()
    if (this.lastFailure?.key === key && now - this.lastFailure.at < 15_000) return
    this.lastFailure = { key, at: now }
    try {
      this.errorReporter?.(`Could not ${action}.`, details)
    } catch {}
  }

  get conversationId(): string | null {
    return this.current
  }

  use(conversationId: string | null): void {
    this.current = conversationId
  }

  exists(conversationId: string | null = this.current): boolean {
    if (!conversationId) return false
    try {
      return this.repo.getConversation(conversationId) !== null
    } catch (error) {
      this.failed('read the conversation store', error)
      return false
    }
  }

  create(title: string = 'New Conversation', parentId: string | null = null): string | null {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    try {
      this.repo.createConversation(id, title, parentId)
      return id
    } catch (error) {
      this.failed('create a conversation', error)
      return null
    }
  }

  /** A child store for one sub-agent, linked through `parent_conversation_id`. */
  child(parentId: string, title: string): ConversationPersistence | null {
    const id = this.create(title, parentId)
    if (!id) return null
    const child = new ConversationPersistence(this.repo)
    child.use(id)
    return child
  }

  ensure(title: string = 'New Conversation'): string | null {
    if (this.current && this.exists()) return this.current
    const id = this.create(title)
    if (id) this.current = id
    return this.current
  }

  start(title: string, prompt?: string): string | null {
    const id = this.create(title, null)
    if (!id) return null
    this.current = id
    if (prompt) this.rename(id, deriveTitle(prompt))
    return id
  }

  list(includeSubAgents = false, limit = 200, offset = 0): ConversationListItem[] {
    try {
      return this.repo.listConversations(includeSubAgents, limit, offset)
    } catch (error) {
      this.failed('load the conversation list', error)
      return []
    }
  }

  listSubAgents(parentId: string): ConversationListItem[] {
    try {
      return this.repo.listSubAgents(parentId)
    } catch (error) {
      this.failed('load sub-agent conversations', error)
      return []
    }
  }

  get(conversationId: string): ConversationRow | null {
    try {
      return this.repo.getConversation(conversationId)
    } catch (error) {
      this.failed('load the conversation', error)
      return null
    }
  }

  last(): ConversationRow | null {
    try {
      return this.repo.lastConversation()
    } catch (error) {
      this.failed('find the last conversation', error)
      return null
    }
  }

  rename(conversationId: string, title: string): boolean {
    try {
      this.repo.renameConversation(conversationId, title)
      return true
    } catch (error) {
      this.failed('rename the conversation', error)
      return false
    }
  }

  remove(conversationId: string): boolean {
    try {
      this.repo.deleteConversation(conversationId)
      if (this.current === conversationId) this.current = null
      return true
    } catch (error) {
      this.failed('delete the conversation', error)
      return false
    }
  }

  touch(conversationId: string | null = this.current): void {
    if (!conversationId) return
    try {
      this.repo.touchConversation(conversationId)
    } catch (error) {
      this.failed('update the conversation', error)
    }
  }

  // ---------- Exact model history ----------

  appendContent(content: Content, conversationId: string | null = this.current): number | null {
    if (!conversationId) return null
    try {
      return this.repo.appendContent(conversationId, contentModelDumpJson(content))
    } catch (error) {
      this.failed('save the model history', error)
      return null
    }
  }

  contents(conversationId: string | null = this.current): Content[] {
    if (!conversationId) return []
    try {
      const stored = this.repo.getContents(conversationId)
      if (stored.length > 0) {
        const result: Content[] = []
        for (const row of stored) {
          try {
            result.push(contentModelValidateJson(row.content_json))
          } catch {}
        }
        // Never overwrite stored history just because a row became unreadable; the exact model
        // history is the source of truth and a rebuild cannot reproduce function calls.
        return result
      }
      // Markdown imports have timeline rows but no exact model contents.  Rebuilding once and
      // saving it means a later turn keeps the imported history instead of sending only the new
      // prompt, and the next reopen reads the same history back.
      const rebuilt = this.contentsFromMessages(conversationId)
      if (rebuilt.length > 0) {
        this.repo.transaction(() => {
          this.repo.deleteContentsFrom(conversationId, 0)
          for (const content of rebuilt) {
            this.repo.appendContent(conversationId, contentModelDumpJson(content))
          }
        })
      }
      return rebuilt
    } catch (error) {
      this.failed('load the conversation history', error)
      return []
    }
  }

  private contentsFromMessages(conversationId: string): Content[] {
    const contents: Content[] = []
    for (const row of this.repo.getAllMessages(conversationId)) {
      const meta = parseRowMeta(row)
      if (meta?.hidden) continue
      if (row.role === 'user') {
        if (row.content.startsWith('/') || row.content.startsWith('!')) continue
        contents.push({ role: 'user', parts: [{ text: row.content }] })
      } else if (row.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: row.content }] })
      } else if (row.role === 'tool') {
        const name = toolNameOfRow(row)
        const callArgs = parsedJson(row.tool_calls)
        // The response needs a preceding call with the same name; without it the model API
        // rejects the rebuilt history as an orphan function response.
        contents.push({
          role: 'model',
          parts: [
            {
              function_call: {
                name,
                args:
                  callArgs !== null && typeof callArgs === 'object' && !Array.isArray(callArgs)
                    ? (callArgs as Record<string, unknown>)
                    : {}
              }
            }
          ]
        })
        contents.push({
          role: 'user',
          parts: [{ function_response: { name, response: toolResponseOfRow(row) } }]
        })
      }
    }
    return contents
  }

  contentCount(conversationId: string | null = this.current): number {
    if (!conversationId) return 0
    try {
      return this.repo.getContentCount(conversationId)
    } catch (error) {
      this.failed('count the conversation history', error)
      return 0
    }
  }

  truncateContents(length: number, conversationId: string | null = this.current): void {
    if (!conversationId) return
    try {
      this.repo.deleteContentsFrom(conversationId, length)
    } catch (error) {
      this.failed('trim the saved history', error)
    }
  }

  // ---------- Timeline rows ----------

  recordUser(
    text: string,
    options: UserRecordOptions = {},
    conversationId: string | null = this.current
  ): number | null {
    if (!conversationId) return null
    const meta: TimelineRowMeta = {}
    if (options.event) meta.event = options.event
    if (options.cpIdx !== undefined) meta.cpIdx = options.cpIdx
    if (options.contentIndex !== undefined) meta.contentIndex = options.contentIndex
    if (options.hidden) meta.hidden = true
    return this.addRow(
      conversationId,
      'user',
      text,
      {
        model: options.model,
        effortLevel: options.effortLevel,
        meta: Object.keys(meta).length > 0 ? (meta as Record<string, unknown>) : undefined
      }
    )
  }

  recordAssistant(
    text: string,
    options: AssistantRecordOptions = {},
    conversationId: string | null = this.current
  ): number | null {
    if (!conversationId) return null
    const meta: TimelineRowMeta = {}
    if (options.event) meta.event = options.event
    if (options.meta !== undefined) (meta as Record<string, unknown>)['meta'] = options.meta
    if (options.contentIndex !== undefined) meta.contentIndex = options.contentIndex
    return this.addRow(conversationId, 'assistant', text, {
      model: options.model,
      effortLevel: options.effortLevel,
      status: 'success',
      meta: meta as Record<string, unknown>
    })
  }

  recordAction(
    event: Record<string, unknown>,
    options: ActionRecordOptions = {},
    conversationId: string | null = this.current
  ): number | null {
    if (!conversationId) return null
    const output = typeof event.output === 'string' ? event.output : safeJson(event.output)
    const duration = typeof event.duration === 'number' ? event.duration : null
    const meta: TimelineRowMeta = {
      event: { kind: 'action', event },
      contentIndex: options.contentIndex ?? null
    }
    return this.addRow(conversationId, 'tool', output, {
      toolCalls: event.args,
      toolResult: {
        output,
        is_error: Boolean(event.is_error),
        status: typeof event.status === 'string' ? event.status : undefined
      },
      model: options.model,
      effortLevel: options.effortLevel,
      status: event.is_error ? 'failed' : 'success',
      durationMs: duration === null ? undefined : Math.round(duration * 1000),
      meta: meta as Record<string, unknown>
    })
  }

  /** Stores a rendered chat row (user, assistant, action, pill, error) exactly as shown. */
  recordEvent(
    event: WindowEvent,
    options: ActionRecordOptions & { cpIdx?: number | null; hidden?: boolean } = {},
    conversationId: string | null = this.current
  ): number | null {
    switch (event.kind) {
      case 'user':
        return this.recordUser(
          event.text,
          {
            cpIdx: options.cpIdx ?? event.cpIdx,
            contentIndex: options.contentIndex,
            model: options.model,
            effortLevel: options.effortLevel,
            event,
            hidden: options.hidden
          },
          conversationId
        )
      case 'assistant':
        return this.recordAssistant(
          event.text,
          {
            contentIndex: options.contentIndex,
            model: options.model,
            effortLevel: options.effortLevel,
            event,
            meta: event.meta
          },
          conversationId
        )
      case 'action':
        return this.recordAction(
          event.event,
          {
            contentIndex: options.contentIndex,
            model: options.model,
            effortLevel: options.effortLevel
          },
          conversationId
        )
      case 'pill':
        return this.addRow(
          conversationId,
          'system',
          event.text,
          {
            model: options.model,
            effortLevel: options.effortLevel,
            meta: { event, contentIndex: options.contentIndex ?? null }
          }
        )
      case 'error':
        return this.addRow(
          conversationId,
          'system',
          `${event.title}: ${event.message}`.trim(),
          {
            model: options.model,
            effortLevel: options.effortLevel,
            status: 'failed',
            meta: { event, contentIndex: options.contentIndex ?? null }
          }
        )
      default:
        return null
    }
  }

  private addRow(
    conversationId: string | null,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    options: MessageOptions
  ): number | null {
    if (!conversationId) return null
    try {
      const id = this.repo.addMessage(conversationId, role, content, options)
      return Number.isFinite(id) ? id : null
    } catch (error) {
      this.failed('save a message', error)
      return null
    }
  }

  message(messageId: number): MessageRow | null {
    try {
      return this.repo.getMessage(messageId)
    } catch (error) {
      this.failed('load a message', error)
      return null
    }
  }

  page(
    beforeId: number | null = null,
    limit = 100,
    conversationId: string | null = this.current
  ): ConversationPage {
    if (!conversationId) return { rows: [], hasMore: false }
    try {
      const result: MessagePage = this.repo.getMessagePage(conversationId, limit, beforeId)
      return { rows: result.messages, hasMore: result.hasMore }
    } catch (error) {
      this.failed('load the message history', error)
      return { rows: [], hasMore: false }
    }
  }

  allMessages(conversationId: string | null = this.current): MessageRow[] {
    if (!conversationId) return []
    try {
      return this.repo.getAllMessages(conversationId)
    } catch (error) {
      this.failed('load all messages', error)
      return []
    }
  }

  lastMessageId(conversationId: string | null = this.current): number {
    if (!conversationId) return 0
    try {
      const id = this.repo.getLastMessageId(conversationId)
      return Number.isFinite(id) ? id : 0
    } catch (error) {
      this.failed('read the last message id', error)
      return 0
    }
  }

  /** Deletes a row and everything after it, plus the model history it introduced. */
  clearFrom(
    messageId: number,
    contentIndex: number | null,
    conversationId: string | null = this.current
  ): boolean {
    if (!conversationId) return false
    try {
      this.repo.transaction(() => {
        this.repo.deleteMessagesFrom(conversationId, messageId)
        if (contentIndex !== null && contentIndex >= 0) {
          this.repo.deleteContentsFrom(conversationId, contentIndex)
        }
      })
      return true
    } catch (error) {
      this.failed('remove messages from the store', error)
      return false
    }
  }

  // ---------- Queue ----------

  loadQueue(conversationId: string | null = this.current): string[] {
    if (!conversationId) return []
    try {
      return this.repo.getQueuedMessages(conversationId).map((row) => row.content)
    } catch (error) {
      this.failed('load the queued messages', error)
      return []
    }
  }

  saveQueue(contents: string[], conversationId: string | null = this.current): void {
    if (!conversationId) return
    try {
      this.repo.replaceQueuedMessages(conversationId, contents)
    } catch (error) {
      this.failed('save the queued messages', error)
    }
  }

  // ---------- Summary ----------

  saveSummary(
    summary: string,
    upToMessageId?: number,
    conversationId: string | null = this.current
  ): void {
    if (!conversationId) return
    try {
      const upTo = upToMessageId ?? this.lastMessageId(conversationId)
      this.repo.saveSummary(conversationId, summary, upTo)
    } catch (error) {
      this.failed('save the conversation summary', error)
    }
  }

  getSummary(conversationId: string | null = this.current): string | null {
    if (!conversationId) return null
    try {
      return this.repo.getConversation(conversationId)?.summary ?? null
    } catch (error) {
      this.failed('load the conversation summary', error)
      return null
    }
  }

  // ---------- Compaction ----------

  saveCompaction(input: CompactionSaveInput): CompactionRow | null {
    const conversationId = this.current
    if (!conversationId) return null
    try {
      const boundary = this.compactionBoundary(conversationId, input.splitContentIndex)
      return this.repo.saveCompaction(conversationId, {
        summary: input.summary,
        coversUpToMessageId: boundary.coversUpToMessageId,
        firstKeptMessageId: boundary.firstKeptMessageId,
        splitContentIndex: input.splitContentIndex,
        messagesSummarizedCount: input.messagesSummarizedCount,
        messagesKeptCount: input.messagesKeptCount,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
        modelUsed: input.modelUsed,
        trigger: input.trigger,
        status: input.status,
        durationMs: input.durationMs,
        error: input.error ?? null,
        createdAt: input.createdAt
      })
    } catch (error) {
      this.failed('save the compaction record', error)
      return null
    }
  }

  latestCompaction(conversationId: string | null = this.current): CompactionRow | null {
    if (!conversationId) return null
    try {
      return this.repo.getLatestCompaction(conversationId)
    } catch (error) {
      this.failed('load the latest compaction', error)
      return null
    }
  }

  listCompactions(conversationId: string | null = this.current): CompactionRow[] {
    if (!conversationId) return []
    try {
      return this.repo.listCompactions(conversationId)
    } catch (error) {
      this.failed('load the compaction history', error)
      return []
    }
  }

  /**
   * The split is an index into the exact model history.  The first user row at or after it is the
   * first message sent in full, and everything before that row is covered by the summary.
   */
  private compactionBoundary(
    conversationId: string,
    splitContentIndex: number
  ): { coversUpToMessageId: number; firstKeptMessageId: number } {
    const rows = this.repo.getAllMessages(conversationId)
    let firstKeptMessageId = 0
    for (const row of rows) {
      if (row.role !== 'user') continue
      const index = storedContentIndex(row)
      if (index !== null && index >= splitContentIndex) {
        firstKeptMessageId = row.id
        break
      }
    }
    if (firstKeptMessageId === 0) {
      const last = rows.length > 0 ? rows[rows.length - 1].id : 0
      firstKeptMessageId = last + 1
    }
    return {
      firstKeptMessageId,
      coversUpToMessageId: Math.max(0, firstKeptMessageId - 1)
    }
  }

  /** Editing a prompt removes the summary records that covered the removed rows. */
  invalidateCompactionsFrom(
    messageId: number,
    conversationId: string | null = this.current
  ): CompactionRow | null {
    if (!conversationId) return null
    try {
      return this.repo.invalidateCompactionsFrom(conversationId, messageId)
    } catch (error) {
      this.failed('invalidate the compaction history', error)
      return null
    }
  }

  /** Rolling history back below a split removes the compactions that described the lost entries. */
  invalidateCompactionsAboveSplit(
    maxSplit: number,
    conversationId: string | null = this.current
  ): CompactionRow | null {
    if (!conversationId) return null
    try {
      return this.repo.invalidateCompactionsAboveSplit(conversationId, maxSplit)
    } catch (error) {
      this.failed('invalidate the compaction history', error)
      return null
    }
  }

  /** Replaces a running action row with its final event, without appending a second row. */
  updateActionEvent(messageId: number, event: Record<string, unknown>): void {
    try {
      const row = this.repo.getMessage(messageId)
      if (row === null) return
      const meta = parseRowMeta(row) ?? {}
      meta.event = { kind: 'action', event }
      const output = typeof event.output === 'string' ? event.output : safeJson(event.output)
      const duration = typeof event.duration === 'number' ? event.duration : null
      this.repo.updateMessage(messageId, {
        content: output,
        status: event.is_error ? 'failed' : 'success',
        durationMs: duration === null ? 0 : Math.round(duration * 1000),
        meta: meta as Record<string, unknown>
      })
    } catch (error) {
      this.failed('update the compaction record', error)
    }
  }
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const conversationPersistence = new ConversationPersistence()
