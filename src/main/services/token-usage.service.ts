import { getDatabase } from './database.service'
import type { Content, Part } from '../models/content'
import { isRequestBoundary } from './conversation-history.service'
import type {
  TokenBreakdown,
  TokenUsageEntry,
  TokenUsageGroup,
  TokenUsageRow,
  TokenUsageSummary
} from '../../shared/types/token-usage'

/** Retain enough history to compare scenarios without letting the log grow forever. */
const MAX_ROWS = 100_000
const PRUNE_EVERY = 500

function tokensOf(text: string | undefined | null): number {
  return text ? Math.ceil(text.length / 4) : 0
}

function tokenCount(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.round(number)
}

function jsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return tokensOf(JSON.stringify(value))
  } catch {
    return 0
  }
}

function partTokens(part: Part): {
  text: number
  toolResult: number
  toolCall: number
  media: number
  other: number
} {
  let toolResult = 0
  let toolCall = 0
  let media = 0
  let other = 0
  const output = part.function_response?.response?.['output']
  if (typeof output === 'string') toolResult += tokensOf(output)
  else toolResult += jsonTokens(part.function_response?.response)
  if (part.function_call) toolCall += jsonTokens(part.function_call)
  if (part.inline_data) media += 258
  if (part.file_data) media += 258
  if (part.executable_code) other += jsonTokens(part.executable_code)
  if (part.code_execution_result) other += jsonTokens(part.code_execution_result)
  return {
    text: tokensOf(part.text),
    toolResult,
    toolCall,
    media,
    other
  }
}

/**
 * Splits one request into the parts the settings can independently shrink. The values are local
 * estimates; the provider's own counts remain the source of truth for the totals.
 */
export function estimateRequestBreakdown(input: {
  systemInstruction?: string | null
  toolDeclarations?: unknown
  contents: readonly Content[]
  memoryChars?: number
  summaryChars?: number
}): TokenBreakdown {
  const systemTotal = tokensOf(input.systemInstruction)
  const memory = Math.min(systemTotal, Math.ceil(Math.max(0, input.memoryChars ?? 0) / 4))
  const summary = Math.min(
    Math.max(0, systemTotal - memory),
    Math.ceil(Math.max(0, input.summaryChars ?? 0) / 4)
  )
  const breakdown: TokenBreakdown = {
    system: Math.max(0, systemTotal - memory - summary),
    memory,
    summary,
    history: 0,
    toolDefinitions: jsonTokens(input.toolDeclarations),
    toolResults: 0,
    toolCalls: 0,
    newMessage: 0,
    media: 0,
    other: 0
  }

  let requestIndex = -1
  for (let index = input.contents.length - 1; index >= 0; index--) {
    if (isRequestBoundary(input.contents[index])) {
      requestIndex = index
      break
    }
  }

  input.contents.forEach((content, index) => {
    for (const part of content.parts ?? []) {
      const cost = partTokens(part)
      breakdown.toolResults += cost.toolResult
      breakdown.toolCalls += cost.toolCall
      breakdown.media += cost.media
      breakdown.other += cost.other
      if (cost.text > 0) {
        if (index === requestIndex) breakdown.newMessage += cost.text
        else breakdown.history += cost.text
      }
    }
  })
  return breakdown
}

export class TokenUsageRepository {
  private writes = 0

  record(entry: TokenUsageEntry): void {
    const input = tokenCount(entry.inputTokens)
    const output = tokenCount(entry.outputTokens)
    const cached = Math.min(input, tokenCount(entry.cachedTokens))
    const thought = tokenCount(entry.thoughtTokens)
    const total = Math.max(tokenCount(entry.totalTokens), input + output + thought)
    try {
      const db = getDatabase()
      db.prepare(
        `INSERT INTO token_usage (
          conversation_id, sender, kind, label, model, requested_model,
          input_tokens, output_tokens, cached_tokens, thought_tokens, total_tokens,
          estimated, breakdown_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.conversationId,
        entry.sender.slice(0, 80) || 'other',
        entry.kind.slice(0, 40) || 'other',
        entry.label.slice(0, 120),
        entry.model.slice(0, 120),
        entry.requestedModel === null ? null : entry.requestedModel.slice(0, 120),
        input,
        output,
        cached,
        thought,
        total,
        entry.estimated ? 1 : 0,
        entry.breakdown === null ? null : JSON.stringify(entry.breakdown),
        Date.now()
      )
      this.writes += 1
      if (this.writes % PRUNE_EVERY === 0) this.prune()
    } catch {
      /* usage logging must never abort a model request */
    }
  }

  private prune(): void {
    try {
      getDatabase()
        .prepare(
          `DELETE FROM token_usage WHERE id <= (
             SELECT id FROM token_usage ORDER BY id DESC LIMIT 1 OFFSET ?
           )`
        )
        .run(MAX_ROWS)
    } catch {
      /* best effort */
    }
  }

  private filter(conversationId?: string | null): { where: string; params: string[] } {
    return conversationId
      ? { where: ' WHERE conversation_id = ?', params: [conversationId] }
      : { where: '', params: [] }
  }

  summary(conversationId: string | null = null, biggestLimit = 10): TokenUsageSummary {
    const { where, params } = this.filter(conversationId)
    const empty: TokenUsageSummary = {
      requests: 0,
      estimatedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      totalTokens: 0,
      byModel: [],
      bySender: [],
      biggest: []
    }
    try {
      const db = getDatabase()
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS requests,
                  COALESCE(SUM(input_tokens), 0) AS input,
                  COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(cached_tokens), 0) AS cached,
                  COALESCE(SUM(thought_tokens), 0) AS thought,
                  COALESCE(SUM(total_tokens), 0) AS total,
                  COALESCE(SUM(estimated), 0) AS estimated
           FROM token_usage${where}`
        )
        .get(...params) as Record<string, number>
      const group = (column: 'model' | 'sender'): TokenUsageGroup[] =>
        (
          db
            .prepare(
              `SELECT ${column} AS key, COUNT(*) AS requests,
                      COALESCE(SUM(input_tokens), 0) AS input,
                      COALESCE(SUM(output_tokens), 0) AS output,
                      COALESCE(SUM(cached_tokens), 0) AS cached,
                      COALESCE(SUM(thought_tokens), 0) AS thought,
                      COALESCE(SUM(total_tokens), 0) AS total,
                      COALESCE(SUM(estimated), 0) AS estimated
               FROM token_usage${where}
               GROUP BY ${column}
               ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
               LIMIT 20`
            )
            .all(...params) as Array<Record<string, unknown>>
        ).map((row) => ({
          key: String(row['key'] ?? ''),
          requests: Number(row['requests'] ?? 0),
          estimatedRequests: Number(row['estimated'] ?? 0),
          inputTokens: Number(row['input'] ?? 0),
          outputTokens: Number(row['output'] ?? 0),
          cachedTokens: Number(row['cached'] ?? 0),
          thoughtTokens: Number(row['thought'] ?? 0),
          totalTokens: Number(row['total'] ?? 0)
        }))
      const biggest = (
        db
          .prepare(
            `SELECT * FROM token_usage${where}
             ORDER BY input_tokens + output_tokens DESC, id DESC LIMIT ?`
          )
          .all(...params, biggestLimit) as Array<Record<string, unknown>>
      ).map((row) => this.rowFrom(row))
      return {
        requests: Number(totals['requests'] ?? 0),
        estimatedRequests: Number(totals['estimated'] ?? 0),
        inputTokens: Number(totals['input'] ?? 0),
        outputTokens: Number(totals['output'] ?? 0),
        cachedTokens: Number(totals['cached'] ?? 0),
        thoughtTokens: Number(totals['thought'] ?? 0),
        totalTokens: Number(totals['total'] ?? 0),
        byModel: group('model'),
        bySender: group('sender'),
        biggest
      }
    } catch {
      return empty
    }
  }

  totals(conversationId: string | null = null): TokenUsageSummary {
    return this.summary(conversationId, 0)
  }

  private rowFrom(row: Record<string, unknown>): TokenUsageRow {
    let breakdown: TokenBreakdown | null = null
    const raw = row['breakdown_json']
    if (typeof raw === 'string' && raw !== '') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          breakdown = parsed as TokenBreakdown
        }
      } catch {
        breakdown = null
      }
    }
    return {
      id: Number(row['id'] ?? 0),
      conversationId: (row['conversation_id'] as string | null) ?? null,
      sender: String(row['sender'] ?? 'other'),
      kind: String(row['kind'] ?? 'other'),
      label: String(row['label'] ?? ''),
      model: String(row['model'] ?? ''),
      requestedModel: (row['requested_model'] as string | null) ?? null,
      inputTokens: Number(row['input_tokens'] ?? 0),
      outputTokens: Number(row['output_tokens'] ?? 0),
      cachedTokens: Number(row['cached_tokens'] ?? 0),
      thoughtTokens: Number(row['thought_tokens'] ?? 0),
      totalTokens: Number(row['total_tokens'] ?? 0),
      estimated: Number(row['estimated'] ?? 0) !== 0,
      breakdown,
      createdAt: Number(row['created_at'] ?? 0)
    }
  }
}

export const tokenUsageRepository = new TokenUsageRepository()
