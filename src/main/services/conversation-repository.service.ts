import Database from 'better-sqlite3'
import { getDatabase } from './database.service'

export interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  summary: string | null
  summary_up_to_message_id: number | null
  parent_conversation_id: string | null
}

export interface MessageRow {
  id: number
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls: string | null
  tool_result: string | null
  model: string | null
  effort_level: string | null
  status: string | null
  duration_ms: number | null
  meta_json: string | null
  created_at: number
}

export interface QueuedMessageRow {
  id: number
  conversation_id: string
  content: string
  position: number
  created_at: number
}

export interface ConversationContentRow {
  id: number
  conversation_id: string
  position: number
  content_json: string
  created_at: number
}

export interface CompactionRow {
  id: number
  conversation_id: string
  created_at: number
  summary: string
  covers_up_to_message_id: number
  first_kept_message_id: number
  split_content_index: number
  messages_summarized_count: number
  messages_kept_count: number
  tokens_before: number
  tokens_after: number
  model_used: string
  trigger: 'auto' | 'manual'
  status: 'success' | 'failed'
  duration_ms: number
  error: string | null
}

export interface CompactionRecordInput {
  summary: string
  coversUpToMessageId: number
  firstKeptMessageId: number
  splitContentIndex: number
  messagesSummarizedCount: number
  messagesKeptCount: number
  tokensBefore: number
  tokensAfter: number
  modelUsed: string
  trigger: 'auto' | 'manual'
  status: 'success' | 'failed'
  durationMs: number
  error?: string | null
  createdAt?: number
}

export interface ConversationListItem {
  id: string
  title: string
  updated_at: number
  created_at: number
  message_count: number
  parent_conversation_id: string | null
  is_sub_agent: boolean
  preview: string
  sub_agent_count: number
}

export interface MessagePage {
  messages: MessageRow[]
  hasMore: boolean
}

export interface MessageOptions {
  toolCalls?: unknown
  toolResult?: unknown
  model?: string
  effortLevel?: string
  status?: string
  durationMs?: number
  meta?: Record<string, unknown>
  createdAt?: number
}

export interface ConversationOptions {
  parentId?: string | null
  createdAt?: number
  updatedAt?: number
}

function clipPreview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean
}

export function deriveTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim()
  if (!clean) return 'New Conversation'
  return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean
}

export class ConversationRepository {
  private db: Database | null = null

  private get dbInstance(): Database {
    if (this.db) return this.db
    this.db = getDatabase()
    return this.db
  }

  constructor(db?: Database) {
    this.db = db ?? null
  }

  // ---------- Conversations ----------

  createConversation(
    id: string,
    title: string = 'New Conversation',
    parentId: string | null = null,
    options: ConversationOptions = {}
  ): ConversationRow {
    const now = Date.now()
    const createdAt = options.createdAt ?? now
    const updatedAt = options.updatedAt ?? now
    this.dbInstance
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, parent_conversation_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, title, createdAt, updatedAt, parentId)
    return {
      id,
      title,
      created_at: createdAt,
      updated_at: updatedAt,
      summary: null,
      summary_up_to_message_id: null,
      parent_conversation_id: parentId
    }
  }

  listConversations(includeSubAgents: boolean = false, limit = 200, offset = 0): ConversationListItem[] {
    const rows = this.dbInstance
      .prepare(
        `SELECT c.id, c.title, c.updated_at, c.created_at, c.parent_conversation_id,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT COUNT(*) FROM conversations s WHERE s.parent_conversation_id = c.id) AS sub_agent_count,
                (SELECT m.content FROM messages m
                  WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
                  ORDER BY m.id DESC LIMIT 1) AS last_content
         FROM conversations c
         ${includeSubAgents ? '' : 'WHERE c.parent_conversation_id IS NULL'}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<{
      id: string
      title: string
      updated_at: number
      created_at: number
      message_count: number
      parent_conversation_id: string | null
      sub_agent_count: number
      last_content: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      created_at: row.created_at,
      message_count: row.message_count,
      parent_conversation_id: row.parent_conversation_id,
      is_sub_agent: row.parent_conversation_id !== null,
      preview: row.last_content ? clipPreview(row.last_content) : '',
      sub_agent_count: row.sub_agent_count
    }))
  }

  listSubAgents(parentId: string): ConversationListItem[] {
    return (
      this.dbInstance
        .prepare(
          `SELECT c.id, c.title, c.updated_at, c.created_at, c.parent_conversation_id,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                  0 AS sub_agent_count,
                  (SELECT m.content FROM messages m
                    WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
                    ORDER BY m.id DESC LIMIT 1) AS last_content
           FROM conversations c
           WHERE c.parent_conversation_id = ?
           ORDER BY c.created_at ASC, c.id ASC`
        )
        .all(parentId) as Array<{
        id: string
        title: string
        updated_at: number
        created_at: number
        message_count: number
        parent_conversation_id: string | null
        sub_agent_count: number
        last_content: string | null
      }>
    ).map((row) => ({
      id: row.id,
      title: row.title,
      updated_at: row.updated_at,
      created_at: row.created_at,
      message_count: row.message_count,
      parent_conversation_id: row.parent_conversation_id,
      is_sub_agent: true,
      preview: row.last_content ? clipPreview(row.last_content) : '',
      sub_agent_count: 0
    }))
  }

  getConversation(id: string): ConversationRow | null {
    // better-sqlite3 hands back `undefined` for a miss, and `exists()` depends on a real null.
    const row = this.dbInstance.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      ConversationRow | undefined
    return row ?? null
  }

  updateConversation(
    id: string,
    updates: Partial<{ title: string; summary: string; summary_up_to_message_id: number }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (updates.title !== undefined) {
      sets.push('title = ?')
      values.push(updates.title)
    }
    if (updates.summary !== undefined) {
      sets.push('summary = ?')
      values.push(updates.summary)
    }
    if (updates.summary_up_to_message_id !== undefined) {
      sets.push('summary_up_to_message_id = ?')
      values.push(updates.summary_up_to_message_id)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)
    this.dbInstance.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  renameConversation(id: string, title: string): void {
    this.updateConversation(id, { title })
  }

  touchConversation(id: string, at: number = Date.now()): void {
    this.dbInstance.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, id)
  }

  saveSummary(id: string, summary: string, upToMessageId: number): void {
    this.updateConversation(id, { summary, summary_up_to_message_id: upToMessageId })
  }

  clearSummary(id: string): void {
    this.dbInstance
      .prepare(
        'UPDATE conversations SET summary = NULL, summary_up_to_message_id = NULL, updated_at = ? WHERE id = ?'
      )
      .run(Date.now(), id)
  }

  // ---------- Compactions ----------

  /**
   * Saves the record and, for a successful run, the summary it produced in one transaction so a
   * crash can never leave the two half-written.
   */
  saveCompaction(conversationId: string, input: CompactionRecordInput): CompactionRow {
    const createdAt = input.createdAt ?? Date.now()
    const run = this.dbInstance.transaction(() => {
      const info = this.dbInstance
        .prepare(
          `INSERT INTO compactions
             (conversation_id, created_at, summary, covers_up_to_message_id, first_kept_message_id,
              split_content_index, messages_summarized_count, messages_kept_count, tokens_before,
              tokens_after, model_used, trigger, status, duration_ms, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conversationId,
          createdAt,
          input.summary,
          input.coversUpToMessageId,
          input.firstKeptMessageId,
          input.splitContentIndex,
          input.messagesSummarizedCount,
          input.messagesKeptCount,
          input.tokensBefore,
          input.tokensAfter,
          input.modelUsed,
          input.trigger,
          input.status,
          input.durationMs,
          input.error ?? null
        )
      if (input.status === 'success') {
        this.dbInstance
          .prepare(
            `UPDATE conversations
             SET summary = ?, summary_up_to_message_id = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(input.summary, input.coversUpToMessageId, createdAt, conversationId)
      }
      return Number(info.lastInsertRowid)
    })
    const id = run()
    return this.dbInstance.prepare('SELECT * FROM compactions WHERE id = ?').get(id) as CompactionRow
  }

  getLatestCompaction(conversationId: string): CompactionRow | null {
    // better-sqlite3 hands back `undefined` for a miss; callers branch on `null`.
    const row = this.dbInstance
      .prepare(
        `SELECT * FROM compactions
         WHERE conversation_id = ? AND status = 'success'
         ORDER BY covers_up_to_message_id DESC, id DESC LIMIT 1`
      )
      .get(conversationId) as CompactionRow | undefined
    return row ?? null
  }

  listCompactions(conversationId: string): CompactionRow[] {
    return this.dbInstance
      .prepare('SELECT * FROM compactions WHERE conversation_id = ? ORDER BY id ASC')
      .all(conversationId) as CompactionRow[]
  }

  /**
   * Editing a prompt deletes it and everything after. Any summary that kept or covered the deleted
   * rows is no longer trustworthy, so drop those records and fall back to the last valid one.
   */
  invalidateCompactionsFrom(conversationId: string, fromMessageId: number): CompactionRow | null {
    const latest = this.transaction(() => {
      this.dbInstance
        .prepare(
          `DELETE FROM compactions
           WHERE conversation_id = ?
             AND (first_kept_message_id >= ? OR covers_up_to_message_id >= ?)`
        )
        .run(conversationId, fromMessageId, fromMessageId)
      return this.getLatestCompaction(conversationId)
    })
    if (latest === null) this.clearSummary(conversationId)
    else this.saveSummary(conversationId, latest.summary, latest.covers_up_to_message_id)
    return latest
  }

  /**
   * Rolling history back below a split makes that compaction describe deleted entries. Drop those
   * records and fall back to the newest compaction whose kept history still exists.
   */
  invalidateCompactionsAboveSplit(conversationId: string, maxSplit: number): CompactionRow | null {
    const latest = this.transaction(() => {
      this.dbInstance
        .prepare(
          `DELETE FROM compactions
           WHERE conversation_id = ? AND split_content_index > ?`
        )
        .run(conversationId, maxSplit)
      return this.getLatestCompaction(conversationId)
    })
    if (latest === null) this.clearSummary(conversationId)
    else this.saveSummary(conversationId, latest.summary, latest.covers_up_to_message_id)
    return latest
  }

  deleteConversation(id: string): void {
    this.dbInstance.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  lastConversation(): ConversationRow | null {
    const row = this.dbInstance
      .prepare(
        `SELECT * FROM conversations
         WHERE parent_conversation_id IS NULL
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get() as ConversationRow | undefined
    return row ?? null
  }

  // ---------- Messages ----------

  addMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    opts: MessageOptions = {}
  ): number {
    const now = opts.createdAt ?? Date.now()
    const insert = this.dbInstance.prepare(
      `INSERT INTO messages
         (conversation_id, role, content, tool_calls, tool_result, model, effort_level, status,
          duration_ms, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const touch = this.dbInstance.prepare(
      'UPDATE conversations SET updated_at = ? WHERE id = ?'
    )
    const run = this.dbInstance.transaction(() => {
      const info = insert.run(
        conversationId,
        role,
        content,
        opts.toolCalls !== undefined ? JSON.stringify(opts.toolCalls) : null,
        opts.toolResult !== undefined ? JSON.stringify(opts.toolResult) : null,
        opts.model ?? null,
        opts.effortLevel ?? null,
        opts.status ?? null,
        opts.durationMs ?? null,
        opts.meta !== undefined ? JSON.stringify(opts.meta) : null,
        now
      )
      touch.run(now, conversationId)
      return Number(info.lastInsertRowid)
    })
    return run()
  }

  /** Oldest-first window ending at the newest message, used by the timeline. */
  getMessages(conversationId: string, limit: number = 100, offset: number = 0): MessageRow[] {
    return this.dbInstance
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ?
         ORDER BY id ASC
         LIMIT ? OFFSET ?`
      )
      .all(conversationId, limit, offset) as MessageRow[]
  }

  getMessage(messageId: number): MessageRow | null {
    const row = this.dbInstance.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      MessageRow | undefined
    return row ?? null
  }

  /** The latest page, still returned oldest-first so callers can replay it in order. */
  getMessagePage(conversationId: string, limit = 100, beforeId?: number | null): MessagePage {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = (
      beforeId
        ? this.dbInstance
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM messages
                 WHERE conversation_id = ? AND id < ?
                 ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`
            )
            .all(conversationId, beforeId, safeLimit + 1)
        : this.dbInstance
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM messages
                 WHERE conversation_id = ?
                 ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`
            )
            .all(conversationId, safeLimit + 1)
    ) as MessageRow[]
    const hasMore = rows.length > safeLimit
    // Rows are oldest-first.  The window was fetched backwards from the page boundary, so the
    // extra row is always the oldest one and dropping it keeps the 100 closest to that boundary.
    const messages = hasMore ? rows.slice(1) : rows
    return { messages, hasMore }
  }

  getAllMessages(conversationId: string): MessageRow[] {
    return this.dbInstance
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
      .all(conversationId) as MessageRow[]
  }

  getMessageCount(conversationId: string): number {
    const row = this.dbInstance
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { c: number }
    return row.c
  }

  getLastMessageId(conversationId: string): number {
    const row = this.dbInstance
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { id: number }
    return row.id
  }

  updateMessage(
    messageId: number,
    updates: Partial<{
      content: string
      toolCalls: unknown
      toolResult: unknown
      status: string
      durationMs: number
      meta: Record<string, unknown>
      model: string
      effortLevel: string
    }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (updates.content !== undefined) {
      sets.push('content = ?')
      values.push(updates.content)
    }
    if (updates.toolCalls !== undefined) {
      sets.push('tool_calls = ?')
      values.push(JSON.stringify(updates.toolCalls))
    }
    if (updates.toolResult !== undefined) {
      sets.push('tool_result = ?')
      values.push(JSON.stringify(updates.toolResult))
    }
    if (updates.status !== undefined) {
      sets.push('status = ?')
      values.push(updates.status)
    }
    if (updates.durationMs !== undefined) {
      sets.push('duration_ms = ?')
      values.push(updates.durationMs)
    }
    if (updates.meta !== undefined) {
      sets.push('meta_json = ?')
      values.push(JSON.stringify(updates.meta))
    }
    if (updates.model !== undefined) {
      sets.push('model = ?')
      values.push(updates.model)
    }
    if (updates.effortLevel !== undefined) {
      sets.push('effort_level = ?')
      values.push(updates.effortLevel)
    }
    if (sets.length === 0) return
    values.push(messageId)
    this.dbInstance.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteMessage(messageId: number): void {
    this.dbInstance.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
  }

  /** Removes a user row and everything after it, the DB half of "edit this prompt". */
  deleteMessagesFrom(conversationId: string, fromId: number): void {
    const run = this.dbInstance.transaction(() => {
      this.dbInstance
        .prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?')
        .run(conversationId, fromId)
      this.dbInstance
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(Date.now(), conversationId)
    })
    run()
  }

  // ---------- Model contents (the exact history sent to the model) ----------

  appendContent(conversationId: string, contentJson: string): number {
    const nextPosition = this.dbInstance.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM conversation_contents WHERE conversation_id = ?'
    )
    const insert = this.dbInstance.prepare(
      `INSERT INTO conversation_contents (conversation_id, position, content_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    // Position allocation and the insert must not interleave with another append.
    const run = this.dbInstance.transaction(() => {
      const next = nextPosition.get(conversationId) as { position: number }
      const info = insert.run(conversationId, next.position, contentJson, Date.now())
      return Number(info.lastInsertRowid)
    })
    return run()
  }

  getContents(conversationId: string): ConversationContentRow[] {
    return this.dbInstance
      .prepare(
        'SELECT * FROM conversation_contents WHERE conversation_id = ? ORDER BY position ASC'
      )
      .all(conversationId) as ConversationContentRow[]
  }

  getContentCount(conversationId: string): number {
    const row = this.dbInstance
      .prepare('SELECT COUNT(*) AS c FROM conversation_contents WHERE conversation_id = ?')
      .get(conversationId) as { c: number }
    return row.c
  }

  deleteContentsFrom(conversationId: string, position: number): void {
    this.dbInstance
      .prepare('DELETE FROM conversation_contents WHERE conversation_id = ? AND position >= ?')
      .run(conversationId, position)
  }

  // ---------- Queued Messages ----------

  addQueuedMessage(conversationId: string, content: string, position: number): number {
    const now = Date.now()
    const info = this.dbInstance
      .prepare(
        `INSERT INTO queued_messages (conversation_id, content, position, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(conversationId, content, position, now)
    return Number(info.lastInsertRowid)
  }

  getQueuedMessages(conversationId: string): QueuedMessageRow[] {
    return this.dbInstance
      .prepare('SELECT * FROM queued_messages WHERE conversation_id = ? ORDER BY position ASC')
      .all(conversationId) as QueuedMessageRow[]
  }

  updateQueuedMessage(id: number, updates: Partial<{ content: string; position: number }>): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (updates.content !== undefined) {
      sets.push('content = ?')
      values.push(updates.content)
    }
    if (updates.position !== undefined) {
      sets.push('position = ?')
      values.push(updates.position)
    }
    if (sets.length === 0) return
    values.push(id)
    this.dbInstance.prepare(`UPDATE queued_messages SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  replaceQueuedMessages(conversationId: string, contents: string[]): void {
    const run = this.dbInstance.transaction(() => {
      this.dbInstance.prepare('DELETE FROM queued_messages WHERE conversation_id = ?').run(conversationId)
      const insert = this.dbInstance.prepare(
        'INSERT INTO queued_messages (conversation_id, content, position, created_at) VALUES (?, ?, ?, ?)'
      )
      contents.forEach((content, position) => insert.run(conversationId, content, position, Date.now()))
    })
    run()
  }

  updateQueuedMessagePosition(id: number, position: number): void {
    this.updateQueuedMessage(id, { position })
  }

  deleteQueuedMessage(id: number): void {
    this.dbInstance.prepare('DELETE FROM queued_messages WHERE id = ?').run(id)
  }

  clearQueuedMessages(conversationId: string): void {
    this.dbInstance.prepare('DELETE FROM queued_messages WHERE conversation_id = ?').run(conversationId)
  }

  // ---------- Imports ----------

  isImported(path: string, sourceKey: string): boolean {
    return Boolean(
      this.dbInstance
        .prepare('SELECT 1 FROM imported_files WHERE path = ? AND source_key = ?')
        .get(path, sourceKey)
    )
  }

  importedConversation(path: string, sourceKey: string): string | null {
    const row = this.dbInstance
      .prepare('SELECT conversation_id FROM imported_files WHERE path = ? AND source_key = ?')
      .get(path, sourceKey) as { conversation_id: string | null } | undefined
    return row?.conversation_id ?? null
  }

  recordImported(
    path: string,
    sourceKey: string,
    hash: string | null,
    conversationId: string | null
  ): void {
    this.dbInstance
      .prepare(
        `INSERT INTO imported_files (path, source_key, hash, conversation_id, imported_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, source_key) DO UPDATE SET
           hash = excluded.hash,
           conversation_id = excluded.conversation_id,
           imported_at = excluded.imported_at`
      )
      .run(path, sourceKey, hash, conversationId, Date.now())
  }

  // ---------- Transactions ----------

  transaction<T>(fn: () => T): T {
    return this.dbInstance.transaction(fn)()
  }

  /** Runs a write and returns false instead of throwing, for optional live mirroring. */
  tryTransaction<T>(fn: () => T): T | null {
    try {
      return this.transaction(fn)
    } catch {
      return null
    }
  }

  // ---------- Utility ----------

  getSchemaVersion(): number {
    return this.dbInstance.pragma('user_version', { simple: true }) as number
  }

  setSchemaVersion(version: number): void {
    this.dbInstance.pragma(`user_version = ${version}`)
  }

  vacuum(): void {
    this.dbInstance.pragma('VACUUM')
  }
}

export const conversationRepository = new ConversationRepository()
