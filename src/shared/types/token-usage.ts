/** Estimated token cost of each part of one model request. Counts only; never content. */
export interface TokenBreakdown {
  system: number
  memory: number
  summary: number
  history: number
  toolDefinitions: number
  toolResults: number
  toolCalls: number
  newMessage: number
  media: number
  other: number
}

export type TokenUsageKind = 'chat' | 'compaction' | 'tool' | 'embedding' | 'image' | 'other'

export interface TokenUsageEntry {
  conversationId: string | null
  /** `main`, `sub-agent 2`, `compaction`, `tool`, ... */
  sender: string
  kind: TokenUsageKind | string
  label: string
  model: string
  requestedModel: string | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  thoughtTokens: number
  totalTokens: number
  /** True when the provider did not report usage and the counts are local estimates. */
  estimated: boolean
  breakdown: TokenBreakdown | null
}

export interface TokenUsageRow extends TokenUsageEntry {
  id: number
  createdAt: number
}

export interface TokenUsageTotals {
  requests: number
  estimatedRequests: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  thoughtTokens: number
  totalTokens: number
}

export interface TokenUsageGroup extends TokenUsageTotals {
  key: string
}

export interface TokenUsageSummary extends TokenUsageTotals {
  byModel: TokenUsageGroup[]
  bySender: TokenUsageGroup[]
  biggest: TokenUsageRow[]
}
