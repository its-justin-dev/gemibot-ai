import type { CompactionResult, CompactionStartInfo, CompactionTrigger } from '../types/compaction'
import type { TimelineEventPayload } from '../types/window'

/**
 * The timeline payload shared by the main window and sub-agent rows. Keeping the shape in one
 * place means a replayed DB row and a live event render identically.
 */
export function compactionRunningEvent(
  info: CompactionStartInfo,
  timestamp: string
): TimelineEventPayload {
  return {
    type: 'action',
    tool: 'compact_conversation',
    args: {
      compaction_id: info.key,
      trigger: info.trigger,
      trigger_label: info.trigger === 'auto' ? 'Auto' : 'Manual',
      model: info.model,
      tokens_before: info.tokensBefore,
      before_percent: info.beforePercent,
      budget_tokens: info.budgetTokens,
      threshold_percent: info.thresholdPercent
    },
    output: 'Compacting conversation...',
    is_error: false,
    status: 'Running',
    duration: 0,
    timestamp,
    file_changes: []
  }
}

export function compactionFinalEvent(
  result: CompactionResult,
  timestamp: string
): TimelineEventPayload {
  const summary = result.status === 'success' ? (result.summary ?? '') : ''
  const output =
    result.status === 'success'
      ? `${result.messagesSummarized} messages summarized • context ${result.beforePercent}% -> ${result.afterPercent}%`
      : `Compaction failed: ${result.error ?? 'unknown error'}`
  return {
    type: 'action',
    tool: 'compact_conversation',
    args: {
      compaction_id: result.key,
      trigger: result.trigger,
      trigger_label: result.trigger === 'auto' ? 'Auto' : 'Manual',
      model: result.modelUsed,
      tokens_before: result.tokensBefore,
      tokens_after: result.tokensAfter,
      before_percent: result.beforePercent,
      after_percent: result.afterPercent,
      messages_summarized: result.messagesSummarized,
      messages_kept: result.messagesKept,
      summary,
      error: result.error
    },
    output,
    is_error: result.status === 'failed',
    status: result.status === 'success' ? 'Success' : 'Failed',
    duration: result.durationMs / 1000,
    timestamp,
    file_changes: []
  }
}

export function compactionDividerEvent(
  values: {
    trigger: CompactionTrigger
    messagesSummarized: number
    tokensBefore: number
    tokensAfter: number
  },
  timestamp: string
): TimelineEventPayload {
  return {
    type: 'compaction-divider',
    tool: 'compact_conversation',
    args: {
      trigger: values.trigger,
      messages_summarized: values.messagesSummarized,
      tokens_before: values.tokensBefore,
      tokens_after: values.tokensAfter
    },
    output: '',
    is_error: false,
    status: 'Success',
    duration: 0,
    timestamp,
    file_changes: []
  }
}
