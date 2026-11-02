import { ACTION_ICONS, STATUS_COLORS, TOOL_DISPLAY_NAMES } from '@shared/constants/timeline'
import { pyFloatRepr, pyJsonDumps } from '@shared/utils/pyjson'
import { pyLen, pySlice, pyStrip, pyStr, pyTitle } from '@shared/utils/pystr'
import { nowStrftime } from '@shared/utils/strftime'
import { stripMarkdownMarkers } from '@shared/utils/text'
import type { TimelineEventPayload } from '@shared/types/window'

export function toolDisplayName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool] ?? pyTitle(tool.replaceAll('_', ' '))
}

export function actionIcon(tool: string): string {
  return ACTION_ICONS[tool] ?? '⚙️'
}

export function statusColors(status: string): [string, string] {
  return STATUS_COLORS[status] ?? ['#94a3b8', '#1e293b']
}

export function assistantLooksLikeError(body: string, meta: string): boolean {
  return meta === 'Network Error' || meta === 'Error' || pyStrip(body).startsWith('Error:')
}

export function pillLooksLikeError(text: string, icon: string): boolean {
  return (
    icon === '❌' ||
    icon === '⚠️' ||
    text.toLowerCase().includes('error') ||
    text.toLowerCase().includes('failed')
  )
}

export function actionSummary(event: TimelineEventPayload): string {
  const tool = text(get(event, 'tool', 'tool'))
  const args = dict(get(event, 'args', {}))
  const fileChanges = array(get(event, 'file_changes', []))

  switch (tool) {
    case 'read_file':
      return `Read ${text(get(args, 'path', ''))} (lines ${text(get(args, 'start_line', 1))}-${text(get(args, 'end_line', 'end'))})`
    case 'write_file':
      return `Created/Overwrote ${text(get(args, 'path', ''))}`
    case 'edit_file':
      return `Modified ${text(get(args, 'path', ''))}`
    case 'delete_file':
      return `Deleted ${text(get(args, 'path', ''))}`
    case 'run_command':
    case 'run_command_outside_target':
      return `$ ${text(get(args, 'command', ''))}`
    case 'glob_files':
    case 'grep_files':
      return `Pattern: ${text(get(args, 'pattern', ''))}`
    case 'web_fetch':
      return `Fetched URL: ${text(get(args, 'url', ''))}`
    case 'todo_write':
      return `Updated tasks (${array(get(args, 'todos', [])).length} items)`
    case 'agent_mode': {
      const level = text(get(args, 'level', 'standard'))
      const deep = Boolean(get(args, 'deep', false))
      const model = text(get(args, 'model', ''))
      const steps = text(get(args, 'steps', ''))
      return `${deep ? 'Deep' : pyTitle(level)} mode${model !== '' ? ` · ${model}` : ''} · ${steps} steps`
    }
    case 'final_check':
      return 'Compared the request and todos before finishing'
    case 'loop_stop':
      return `Stopped a repeated failing call: ${text(get(args, 'tool', ''))} (${text(get(args, 'repeats', 0))}x)`
    case 'step_limit':
      return `Reached the ${text(get(args, 'steps', 0))}-step limit`
    case 'compact_conversation': {
      const status = text(get(event, 'status', ''))
      if (status === 'Running') return 'Compacting conversation...'
      const summarized = text(get(args, 'messages_summarized', 0))
      const before = text(get(args, 'before_percent', 0))
      const after = text(get(args, 'after_percent', 0))
      if (text(get(args, 'error', '')) !== '') return text(get(event, 'output', 'Compaction failed'))
      return `${summarized} messages summarized • context ${before}% -> ${after}%`
    }
    default:
      if (fileChanges.length > 0) return `${fileChanges.length} file change(s)`
      return `Ran ${toolDisplayName(tool)}`
  }
}

export function truncateSummary(summary: string): string {
  return pyLen(summary) > 75 ? `${pySlice(summary, 0, 75)}...` : summary
}

export function searchableText(event: TimelineEventPayload): string {
  const tool = text(get(event, 'tool', 'tool'))
  const args = pyJsonDumps(dict(get(event, 'args', {})))
  const output = text(get(event, 'output', ''))
  return `${tool} ${actionSummary(event)} ${args} ${output}`
}

export function userSearchableText(body: string): string {
  return `user ${stripMarkdownMarkers(body.trim())}`
}

export function assistantSearchableText(meta: string, body: string): string {
  return `assistant ${meta} ${body}`
}

export function actionHeader(event: TimelineEventPayload): {
  summary: string
  badges: string
  status: string
} {
  const status = text(get(event, 'status', 'Success'))
  return {
    summary: truncateSummary(actionSummary(event)),
    badges: `${text(get(event, 'duration', 0))}s • ${text(get(event, 'timestamp', nowStrftime('%H:%M:%S')))}`,
    status
  }
}

export const DEFAULT_PADY: Record<'assistant' | 'user' | 'action', [number, number]> = {
  assistant: [8, 12],
  user: [12, 6],
  action: [3, 3]
}

export const ERROR_PADY_BEFORE_SEARCH: [number, number] = [8, 12]
export const ERROR_PADY_AFTER_SEARCH: [number, number] = [4, 4]

export function actionCopyText(event: TimelineEventPayload): string {
  const tool = text(get(event, 'tool', 'tool'))
  const status = text(get(event, 'status', 'Success'))
  const duration = text(get(event, 'duration', 0))
  const timestamp = text(get(event, 'timestamp', nowStrftime('%H:%M:%S')))
  const args = dict(get(event, 'args', {}))
  const rawOutput = text(get(event, 'output', ''))
  const fileChanges = dictArray(get(event, 'file_changes', []))
  const lines = [
    `Tool: ${toolDisplayName(tool)} (${tool})`,
    `Status: ${status}`,
    `Duration: ${duration}s`,
    `Timestamp: ${timestamp}`,
    `Arguments: ${pyJsonDumps(args, { indent: 2 })}`
  ]
  if (rawOutput) lines.push(`\nOutput:\n${rawOutput}`)
  if (fileChanges.length > 0) {
    lines.push('\nFile Changes:')
    for (const chg of fileChanges) {
      lines.push(`  - ${text(get(chg, 'path', ''))}: ${text(get(chg, 'change_type', 'modified'))}`)
    }
  }
  return lines.join('\n')
}

export function assistantCopyText(body: string, associated: TimelineEventPayload[]): string {
  const parts = [`=== GemiBot AI Response ===\n\n${pyStrip(body)}`]
  if (associated.length > 0) {
    parts.push('\n\n=== Associated Actions ===\n')
    associated.forEach((event, i) => {
      const tool = text(get(event, 'tool', 'tool'))
      const args = dict(get(event, 'args', {}))
      const rawOutput = text(get(event, 'output', ''))
      const fileChanges = dictArray(get(event, 'file_changes', []))
      parts.push(
        `\n${i + 1}. ${toolDisplayName(tool)} (${tool})`,
        `   Status: ${text(get(event, 'status', 'Success'))} | Duration: ${text(get(event, 'duration', 0))}s | Time: ${text(get(event, 'timestamp', nowStrftime('%H:%M:%S')))}`
      )
      switch (tool) {
        case 'read_file':
          parts.push(
            `   Read: ${text(get(args, 'path', ''))} (lines ${text(get(args, 'start_line', 1))}-${text(get(args, 'end_line', 'end'))})`
          )
          break
        case 'write_file':
          parts.push(`   Created/Overwrote: ${text(get(args, 'path', ''))}`)
          break
        case 'edit_file':
          parts.push(`   Modified: ${text(get(args, 'path', ''))}`)
          break
        case 'delete_file':
          parts.push(`   Deleted: ${text(get(args, 'path', ''))}`)
          break
        case 'run_command':
        case 'run_command_outside_target':
          parts.push(`   Command: ${text(get(args, 'command', ''))}`)
          break
        case 'todo_write':
          parts.push(`   Updated tasks (${array(get(args, 'todos', [])).length} items)`)
          break
        case 'compact_conversation':
          parts.push(
            `   ${text(get(args, 'messages_summarized', 0))} messages summarized ` +
              `(${text(get(args, 'before_percent', 0))}% -> ${text(get(args, 'after_percent', 0))}%)`
          )
          break
      }
      if (rawOutput && pyLen(rawOutput) < 500) parts.push(`   Output: ${rawOutput}`)
      if (fileChanges.length > 0) {
        parts.push('   File Changes:')
        for (const chg of fileChanges) {
          parts.push(
            `     - ${text(get(chg, 'path', ''))}: ${text(get(chg, 'change_type', 'modified'))}`
          )
        }
      }
    })
  }
  return parts.join('\n')
}

function dictArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(dict) : []
}

export { get as payloadGet, text as payloadText, dict as payloadDict, array as payloadArray }

function get(source: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback
}

function text(value: unknown): string {
  if (typeof value === 'number' && !Number.isInteger(value)) return pyFloatRepr(value)
  return pyStr(value)
}

function dict(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
