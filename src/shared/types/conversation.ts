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
  created_at: number
}

export interface QueuedMessageRow {
  id: number
  conversation_id: string
  content: string
  position: number
  created_at: number
}

export interface ConversationListItem {
  id: string
  title: string
  updated_at: number
  message_count: number
  parent_conversation_id: string | null
  is_sub_agent: boolean
}
