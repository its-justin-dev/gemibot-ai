import type { TokenUsageTotals } from './token-usage'

export type CompactionTrigger = 'auto' | 'manual'

export type CompactionStatus = 'failed' | 'success'

export interface CompactionSettings {
  enabled: boolean
  /** Auto-compaction fires when used tokens reach this percentage of the request budget. */
  thresholdPercent: number
  /** Step B aims the kept history at this percentage after summarization. */
  targetPercent: number
  /** Whole user turns kept verbatim; the split never lands inside one. */
  recentMessages: number
  summarizerModel: string
}

export interface ContextUsage {
  usedTokens: number
  /** The effective ceiling for this model (window and app cap combined). */
  budgetTokens: number
  /** The model's real input window, for the tooltip. */
  limitTokens: number
  percent: number
  thresholdPercent: number
  model: string
  /** Real provider counts for this conversation, when the window has an active one. */
  tokenUsage?: TokenUsageTotals
}

export interface CompactionRecord {
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
  trigger: CompactionTrigger
  status: CompactionStatus
  duration_ms: number
  error: string | null
}

export interface CompactionSaveInput {
  summary: string
  splitContentIndex: number
  messagesSummarizedCount: number
  messagesKeptCount: number
  tokensBefore: number
  tokensAfter: number
  modelUsed: string
  trigger: CompactionTrigger
  status: CompactionStatus
  durationMs: number
  error?: string | null
  createdAt?: number
}

export interface CompactionStartInfo {
  key: string
  trigger: CompactionTrigger
  model: string
  tokensBefore: number
  beforePercent: number
  budgetTokens: number
  thresholdPercent: number
}

export interface CompactionResult {
  key: string
  trigger: CompactionTrigger
  status: CompactionStatus
  summary: string | null
  modelUsed: string
  tokensBefore: number
  tokensAfter: number
  beforePercent: number
  afterPercent: number
  messagesSummarized: number
  messagesKept: number
  durationMs: number
  error: string | null
  splitContentIndex: number
  firstKeptMessageId: number
  coversUpToMessageId: number
}

/** The subset of a compaction a sub-agent row shows inline. */
export interface CompactionView {
  key: string
  trigger: CompactionTrigger
  status: 'running' | CompactionStatus
  modelUsed: string
  tokensBefore: number
  tokensAfter: number | null
  beforePercent: number
  afterPercent: number | null
  messagesSummarized: number
  messagesKept: number
  durationMs: number
  error: string | null
  summary?: string | null
  createdAt: number
}
