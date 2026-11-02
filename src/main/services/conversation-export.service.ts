import type { CompactionRow, ConversationRow, MessageRow } from './conversation-repository.service'

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
}

function roleLabel(row: MessageRow): string {
  if (row.role === 'user') return 'User'
  if (row.role === 'assistant') return 'Assistant'
  if (row.role === 'tool') return 'Tool'
  return 'System'
}

function toolName(row: MessageRow): string {
  const calls = parseJson(row.tool_calls)
  if (calls && typeof calls === 'object' && !Array.isArray(calls)) {
    const name = (calls as Record<string, unknown>).name
    if (typeof name === 'string' && name) return name
  }
  return row.status === 'failed' ? 'tool (failed)' : 'tool'
}

function duration(row: MessageRow): string {
  if (row.duration_ms === null) return ''
  const seconds = row.duration_ms / 1000
  return seconds >= 0.1 ? ` • ${seconds.toFixed(1)}s` : ''
}

export function exportFileName(title: string, format: 'md' | 'json'): string {
  const base = title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  const stamp = new Date().toISOString().slice(0, 10)
  return `gemibot-${base || 'conversation'}-${stamp}.${format}`
}

export function conversationToMarkdown(
  conversation: ConversationRow,
  messages: MessageRow[],
  compactions: CompactionRow[] = []
): string {
  const lines: string[] = [
    `# ${conversation.title}`,
    '',
    `- **Conversation ID:** \`${conversation.id}\``,
    `- **Created:** ${iso(conversation.created_at)}`,
    `- **Updated:** ${iso(conversation.updated_at)}`,
    `- **Messages:** ${messages.length}`
  ]
  if (conversation.parent_conversation_id) {
    lines.push(`- **Parent conversation:** \`${conversation.parent_conversation_id}\``)
  }
  if (conversation.summary) {
    lines.push('', '## Summary', '', conversation.summary)
  }
  if (compactions.length > 0) {
    lines.push('', '## Compaction History', '')
    for (const record of compactions) {
      lines.push(
        `### Compaction — ${iso(record.created_at)} • ${record.trigger === 'auto' ? 'Auto' : 'Manual'}`,
        '',
        `- **Status:** ${record.status}`,
        `- **Model used:** ${record.model_used || 'unknown'}`,
        `- **Messages summarized:** ${record.messages_summarized_count}`,
        `- **Messages kept:** ${record.messages_kept_count}`,
        `- **Tokens before:** ${record.tokens_before}`,
        `- **Tokens after:** ${record.tokens_after}`,
        `- **Duration:** ${record.duration_ms}ms`,
        `- **Covers up to message:** ${record.covers_up_to_message_id}`,
        `- **First kept message:** ${record.first_kept_message_id}`
      )
      if (record.error) lines.push(`- **Error:** ${record.error}`)
      if (record.summary) lines.push('', '#### Summary of the earlier conversation', '', record.summary)
      lines.push('')
    }
  }
  lines.push('', '---', '')

  for (const row of messages) {
    const meta: string[] = [iso(row.created_at)]
    if (row.model) meta.push(row.model)
    if (row.effort_level) meta.push(row.effort_level)
    if (row.role === 'tool') {
      meta.push(toolName(row))
      if (row.status) meta.push(row.status)
      meta.push(duration(row).replace(/^ • /, ''))
    } else if (row.status && row.status !== 'success') {
      meta.push(row.status)
    }
    const heading = `### ${roleLabel(row)}${meta.filter(Boolean).length > 0 ? ` — ${meta.filter(Boolean).join(' • ')}` : ''}`
    lines.push(heading, '')
    if (row.role === 'tool') {
      lines.push('```', row.content, '```')
    } else {
      lines.push(row.content)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

export function conversationToJson(
  conversation: ConversationRow,
  messages: MessageRow[],
  compactions: CompactionRow[] = []
): string {
  const payload = {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: iso(conversation.created_at),
      updatedAt: iso(conversation.updated_at),
      summary: conversation.summary,
      parentConversationId: conversation.parent_conversation_id
    },
    messages: messages.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      model: row.model,
      effortLevel: row.effort_level,
      status: row.status,
      durationMs: row.duration_ms,
      createdAt: iso(row.created_at),
      toolCalls: parseJson(row.tool_calls),
      toolResult: parseJson(row.tool_result)
    })),
    compactions: compactions.map((record) => ({
      id: record.id,
      createdAt: iso(record.created_at),
      summary: record.summary,
      coversUpToMessageId: record.covers_up_to_message_id,
      firstKeptMessageId: record.first_kept_message_id,
      splitContentIndex: record.split_content_index,
      messagesSummarizedCount: record.messages_summarized_count,
      messagesKeptCount: record.messages_kept_count,
      tokensBefore: record.tokens_before,
      tokensAfter: record.tokens_after,
      modelUsed: record.model_used,
      trigger: record.trigger,
      status: record.status,
      durationMs: record.duration_ms,
      error: record.error
    }))
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
