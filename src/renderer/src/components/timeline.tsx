import { useEffect, useRef, useState } from 'react'

import {
  CodeSnippet,
  DiffCard,
  GenericActionBody,
  TerminalCard
} from '@renderer/components/action-bodies'
import { Glyph, GlyphText } from '@renderer/components/icons'
import MarkdownBlocks from '@renderer/components/markdown-blocks'
import ThinkingRow from '@renderer/components/thinking-row'
import {
  DEFAULT_PADY,
  ERROR_PADY_AFTER_SEARCH,
  ERROR_PADY_BEFORE_SEARCH,
  actionHeader,
  actionIcon,
  assistantCopyText,
  assistantLooksLikeError,
  assistantSearchableText,
  payloadArray,
  payloadDict,
  payloadGet,
  payloadText,
  pillLooksLikeError,
  searchableText,
  statusColors,
  toolDisplayName,
  userSearchableText
} from '@renderer/state/card-model'
import type { ChatItem, RendererState } from '@renderer/state/window-store'
import { stripMarkdownMarkers } from '@shared/utils/text'
import { pyStrip, pySplitlines } from '@shared/utils/pystr'
import type { TimelineEventPayload } from '@shared/types/window'

export interface TimelineHandlers {
  copy: (text: string) => void
  copyPath: (rel: string) => void
  openFile: (rel: string) => void
  undo: () => void
  editUser: (rowId: number, text: string, cpIdx: number | null, dbId?: number) => void
  exportTimeline: () => void
  openApiKey: () => void
  loadOlder: () => void
  openConversation: (conversationId: string) => void
  compact: () => void
}

interface Props {
  state: RendererState
  handlers: TimelineHandlers
  children?: React.ReactNode
}

const COMPACTED_TOOLTIP =
  'These messages were summarized for the model and are no longer sent in full.'

function pady(a: number, b: number): React.CSSProperties {
  return { marginBlock: `calc(${a} * var(--u)) calc(${b} * var(--u))` }
}

export default function Timeline({ state, handlers, children }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [restyledErrors, setRestyledErrors] = useState<Set<number>>(new Set())
  const [autoScroll, setAutoScroll] = useState(true)
  const [showJump, setShowJump] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!autoScroll) return
    const node = containerRef.current
    if (node === null) return
    const timer = setTimeout(() => {
      node.scrollTop = node.scrollHeight
    }, 50)
    return () => clearTimeout(timer)
  }, [state.revision, autoScroll])

  const onQueryChange = (value: string): void => {
    setQuery(value)
    setRestyledErrors((previous) => {
      const next = new Set(previous)
      for (const row of state.chat) if (row.type === 'error') next.add(row.id)
      return next
    })
  }

  const filter = query.trim().toLowerCase()
  const visible = (row: ChatItem): boolean => {
    if (filter === '') return true
    if (row.type === 'pill') return true
    if (row.type === 'error') return false
    const searchable =
      row.type === 'assistant'
        ? assistantSearchableText(row.meta, row.text)
        : row.type === 'user'
          ? userSearchableText(row.text)
          : row.type === 'action'
            ? searchableText(row.event)
            : ''
    return searchable.toLowerCase().includes(filter)
  }

  const toggle = (id: number): void =>
    setExpanded((previous) => ({ ...previous, [id]: !previous[id] }))

  const actionIds = state.chat.filter((row) => row.type === 'action').map((row) => row.id)
  const expandAll = (): void => setExpanded(Object.fromEntries(actionIds.map((id) => [id, true])))
  const collapseAll = (): void => setExpanded({})

  const onScroll = (): void => {
    const node = containerRef.current
    if (node === null) return
    const y1 = (node.scrollTop + node.clientHeight) / node.scrollHeight
    if (y1 < 0.98) {
      setAutoScroll(false)
      setShowJump(true)
    } else {
      setAutoScroll(true)
      setShowJump(false)
    }
    if (node.scrollTop < 40 && state.hasMoreHistory) handlers.loadOlder()
  }

  const jumpToLatest = (): void => {
    setAutoScroll(true)
    setShowJump(false)
    const node = containerRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }

  const lastDividerIndex = state.chat.reduce(
    (at, row, index) => (row.type === 'divider' ? index : at),
    -1
  )

  return (
    <div className="chat-area">
      <div className="timeline-toolbar">
        <div className="tb-left">
          <span className="caption">TIMELINE</span>
          <button className="tb-btn expand" onClick={expandAll} type="button">
            Expand All
          </button>
          <button className="tb-btn collapse" onClick={collapseAll} type="button">
            Collapse All
          </button>
          <button className="tb-btn export" onClick={handlers.exportTimeline} type="button">
            Export
          </button>
          <button
            className="tb-btn compact"
            onClick={handlers.compact}
            title="Compact conversation"
            type="button"
          >
            🗜️ Compact
          </button>
          <button className="tb-btn api-key" onClick={handlers.openApiKey} type="button">
            API Key
          </button>
        </div>
        <div className="tb-right">
          <input
            aria-label="Search timeline"
            className="search-entry"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search timeline..."
            value={query}
          />
        </div>
      </div>

      <div className="chat-container" onScroll={onScroll} ref={containerRef}>
        {state.chat.map((row, index) => {
          const dimmed = index < lastDividerIndex && isMessageRow(row)
          return (
            <div
              className={dimmed ? 'compacted-group' : undefined}
              key={row.id}
              title={dimmed ? COMPACTED_TOOLTIP : undefined}
            >
              <TimelineRow
                expanded={expanded[row.id] === true}
                handlers={handlers}
                onToggle={() => toggle(row.id)}
                row={row}
                style={visible(row) ? padyFor(row, restyledErrors) : { display: 'none' }}
              />
            </div>
          )
        })}
        {state.thinking !== null ? <ThinkingRow thinking={state.thinking} /> : null}
      </div>

      {showJump ? (
        <button
          className="jump-btn"
          onClick={jumpToLatest}
          style={{ left: '50%', top: '88%', transform: 'translate(-50%, -50%)' }}
          type="button"
        >
          <Glyph glyph="↓" />
          Jump to latest
        </button>
      ) : null}
      {children}
    </div>
  )
}

function padyFor(row: ChatItem, restyled: Set<number>): React.CSSProperties {
  if (row.type === 'error')
    return pady(...(restyled.has(row.id) ? ERROR_PADY_AFTER_SEARCH : ERROR_PADY_BEFORE_SEARCH))
  if (row.type === 'assistant' || row.type === 'user' || row.type === 'action')
    return pady(...DEFAULT_PADY[row.type])
  return pady(3, 3)
}

function isMessageRow(row: ChatItem): boolean {
  if (row.type === 'action') {
    // The compaction row marks where history was summarized, so it is not itself summarized
    // content and must stay readable instead of joining the dimmed group above the divider.
    return payloadText(payloadGet(row.event, 'tool', 'tool')) !== 'compact_conversation'
  }
  return row.type === 'assistant' || row.type === 'user'
}

function TimelineRow({
  row,
  style,
  expanded,
  onToggle,
  handlers
}: {
  row: ChatItem
  style: React.CSSProperties
  expanded: boolean
  onToggle: () => void
  handlers: TimelineHandlers
}): React.JSX.Element {
  switch (row.type) {
    case 'assistant':
      return <AssistantRow row={row} style={style} handlers={handlers} />
    case 'user':
      return <UserRow row={row} style={style} handlers={handlers} />
    case 'pill':
      return <PillRow row={row} style={style} />
    case 'error':
      return <ErrorRow row={row} style={style} />
    case 'action':
      return (
        <ActionRow
          event={row.event}
          expanded={expanded}
          onToggle={onToggle}
          style={style}
          handlers={handlers}
        />
      )
    case 'divider':
      return <DividerRow row={row} style={style} />
  }
}

function AssistantRow({
  row,
  style,
  handlers
}: {
  row: Extract<ChatItem, { type: 'assistant' }>
  style: React.CSSProperties
  handlers: TimelineHandlers
}): React.JSX.Element {
  const isError = assistantLooksLikeError(row.text, row.meta)
  return (
    <div className="row-assistant" style={style}>
      <div className={`card card-assistant${isError ? ' is-error' : ''}`}>
        <div className="card-head">
          <span className="assistant-name">GemiBot AI</span>
          <span className="assistant-meta">
            <GlyphText text={row.header} />
          </span>
          <button
            className="card-btn copy"
            onClick={() => handlers.copy(assistantCopyText(row.text, row.associated))}
            type="button"
          >
            <Glyph glyph="📋" />
          </button>
        </div>
        <div className="card-body">
          <MarkdownBlocks onCopy={handlers.copy} text={row.text} />
        </div>
      </div>
    </div>
  )
}

function UserRow({
  row,
  style,
  handlers
}: {
  row: Extract<ChatItem, { type: 'user' }>
  style: React.CSSProperties
  handlers: TimelineHandlers
}): React.JSX.Element {
  return (
    <div className="row-user" style={style}>
      <div className="card card-user">
        <div className="card-head user">
          <span className="user-header">{row.header}</span>
          <button
            className="card-btn"
            onClick={() => handlers.editUser(row.id, pyStrip(row.text), row.cpIdx, row.dbId)}
            type="button"
          >
            <Glyph glyph="✏️" />
            Edit
          </button>
        </div>
        <div className="user-body">{stripMarkdownMarkers(pyStrip(row.text))}</div>
      </div>
    </div>
  )
}

function PillRow({
  row,
  style
}: {
  row: Extract<ChatItem, { type: 'pill' }>
  style: React.CSSProperties
}): React.JSX.Element {
  const isError = pillLooksLikeError(row.text, row.icon)
  return (
    <div className="row-pill" style={style}>
      <span className={`pill${isError ? ' is-error' : ''}`}>
        <GlyphText text={`${row.icon}  ${row.text}`} />
      </span>
    </div>
  )
}

function ErrorRow({
  row,
  style
}: {
  row: Extract<ChatItem, { type: 'error' }>
  style: React.CSSProperties
}): React.JSX.Element {
  const details = row.details
  const shown = details && pyStrip(details) ? pyStrip(details) : ''
  const height = shown ? Math.min(Math.max(pySplitlines(shown).length * 18, 54), 160) : 0
  return (
    <div className="row-error" style={style}>
      <div className="card card-error">
        <div className="error-head">
          <span className="error-title">
            <GlyphText text={`${row.icon}  ${row.title}`} />
          </span>
          <span className="error-time">{row.header}</span>
        </div>
        <div className="error-message">{stripMarkdownMarkers(pyStrip(row.message))}</div>
        {shown ? (
          <pre
            className="error-details selectable"
            style={{ height: `calc(${height} * var(--u))` }}
          >
            {`Details:\n${shown}`}
          </pre>
        ) : null}
      </div>
    </div>
  )
}

function DividerRow({
  row,
  style
}: {
  row: Extract<ChatItem, { type: 'divider' }>
  style: React.CSSProperties
}): React.JSX.Element {
  const timestamp = payloadText(payloadGet(row.event, 'timestamp', ''))
  return (
    <div className="row-divider" style={style}>
      <span className="divider-line" />
      <span className="divider-label">
        <GlyphText text={`🗜️  Conversation compacted${timestamp ? `  •  ${timestamp}` : ''}`} />
      </span>
      <span className="divider-line" />
    </div>
  )
}

function ActionRow({
  event,
  style,
  expanded,
  onToggle,
  handlers
}: {
  event: TimelineEventPayload
  style: React.CSSProperties
  expanded: boolean
  onToggle: () => void
  handlers: TimelineHandlers
}): React.JSX.Element {
  const tool = payloadText(payloadGet(event, 'tool', 'tool'))
  const isSubAgent = (event as Record<string, unknown>).type === 'sub-agent'
  const isCompaction =
    !isSubAgent &&
    ((event as Record<string, unknown>).type === 'compaction-divider' ||
      tool === 'compact_conversation')
  const header = isSubAgent ? subAgentHeader(event) : actionHeader(event)
  const [statusColor, statusBg] = statusColors(header.status)

  return (
    <div className="row-action" style={style}>
      <div className={`action-card${isCompaction ? ' is-compaction' : ''}`}>
        <div
          aria-expanded={expanded}
          className="action-head"
          onClick={onToggle}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
              keyEvent.preventDefault()
              onToggle()
            }
          }}
          role="button"
          tabIndex={0}
        >
          <span className="action-chevron">
            <Glyph glyph={expanded ? '▼' : '▶'} />
          </span>
          <span className="action-icon">
            <Glyph glyph={isSubAgent ? '🤖' : actionIcon(tool)} />
          </span>
          <span className="action-tool">
            {isSubAgent
              ? subAgentLabel((event as Record<string, unknown>).subAgentIdx)
              : toolDisplayName(tool)}
          </span>
          <span className="action-summary">
            {isSubAgent
              ? subAgentSummary(event)
              : header.summary}
          </span>
          <span className="action-badges">
            {}
            <span className="action-status" style={{ color: statusColor, background: statusBg }}>
              {` ${(isCompaction || isSubAgent) && header.status === 'Running' ? '⟳ Running' : header.status} `}
            </span>
            <span className="action-time">{header.badges}</span>
          </span>
        </div>
        {expanded ? (
          <div className="action-details">
            {isSubAgent ? (
              <SubAgentBody event={event} onOpenConversation={handlers.openConversation} />
            ) : isCompaction ? (
              <CompactionBody event={event} />
            ) : (
              <ActionBody event={event} handlers={handlers} tool={tool} />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ActionBody({
  event,
  tool,
  handlers
}: {
  event: TimelineEventPayload
  tool: string
  handlers: TimelineHandlers
}): React.JSX.Element {
  const args = payloadDict(payloadGet(event, 'args', {}))
  const rawOutput = payloadText(payloadGet(event, 'output', ''))
  const fileChanges = payloadArray(payloadGet(event, 'file_changes', []))

  if (tool === 'run_command' || tool === 'run_command_outside_target')
    return (
      <TerminalCard
        command={payloadText(payloadGet(args, 'command', ''))}
        onCopy={handlers.copy}
        output={rawOutput}
        status={payloadGet(event, 'status', undefined)}
      />
    )

  if (fileChanges.length > 0)
    return (
      <>
        {fileChanges.map((change, index) => (
          <DiffCard
            change={payloadDict(change)}
            key={index}
            onCopyCode={handlers.copy}
            onCopyPath={handlers.copyPath}
            onOpen={handlers.openFile}
            onUndo={handlers.undo}
          />
        ))}
      </>
    )

  if (tool === 'read_file')
    return (
      <CodeSnippet
        code={rawOutput}
        onCopy={handlers.copy}
        path={payloadText(payloadGet(args, 'path', ''))}
      />
    )

  return <GenericActionBody args={args} output={rawOutput} />
}

function CompactionBody({ event }: { event: TimelineEventPayload }): React.JSX.Element {
  const args = payloadDict(payloadGet(event, 'args', {}))
  const status = payloadText(payloadGet(event, 'status', ''))
  const trigger = payloadText(payloadGet(args, 'trigger_label', payloadGet(args, 'trigger', 'Auto')))
  const model = payloadText(payloadGet(args, 'model', ''))
  const before = payloadText(payloadGet(args, 'tokens_before', 0))
  const after = payloadText(payloadGet(args, 'tokens_after', before))
  const beforePercent = payloadText(payloadGet(args, 'before_percent', 0))
  const afterPercent = payloadText(payloadGet(args, 'after_percent', beforePercent))
  const summarized = payloadText(payloadGet(args, 'messages_summarized', 0))
  const kept = payloadText(payloadGet(args, 'messages_kept', 0))
  const summary = payloadText(payloadGet(args, 'summary', ''))
  const error = payloadText(payloadGet(args, 'error', ''))
  const failed = status === 'Failed'

  return (
    <div style={{ margin: 'calc(6 * var(--u)) calc(8 * var(--u))' }}>
      <div className="md-heading">Compaction Details</div>
      <div className="md-paragraph">
        {`Trigger: ${trigger}  •  Summarizer: ${model || 'default'}`}
      </div>
      <div className="md-paragraph">
        {`Messages summarized: ${summarized}  •  Kept verbatim: ${kept}`}
      </div>
      <div className="md-paragraph">
        {`Context: ${beforePercent}% -> ${afterPercent}%  •  Tokens: ${before} -> ${after}`}
      </div>
      {status === 'Running' ? (
        <div className="md-paragraph" style={{ color: '#60a5fa' }}>
          Summarizing older messages. The chat stays usable and this turn waits for the result.
        </div>
      ) : null}
      {failed ? (
        <>
          <div className="md-heading">Error</div>
          <div className="md-paragraph" style={{ color: '#fca5a5' }}>
            {error || 'Compaction failed.'}
          </div>
          <div className="md-paragraph" style={{ color: '#94a3b8' }}>
            The original history is intact and is still being sent in full.
          </div>
        </>
      ) : null}
      {summary ? (
        <details className="compaction-summary">
          <summary>Read-only summary</summary>
          <pre>{summary}</pre>
        </details>
      ) : null}
    </div>
  )
}

const SUB_AGENT_STATUS_NAMES: Record<string, string> = {
  running: 'Running',
  switching: 'Switching',
  succeeded: 'Success',
  failed: 'Failed'
}

function subAgentLabel(idx: unknown): string {
  return typeof idx === 'number' ? `Sub-Agent ${idx}` : 'Sub-Agent'
}

function subAgentHeader(event: TimelineEventPayload): {
  status: string
  summary: string
  badges: string
} {
  const rawStatus = payloadText(payloadGet(event, 'status', 'running'))
  const status = SUB_AGENT_STATUS_NAMES[rawStatus.toLowerCase()] ?? rawStatus
  const model = payloadText(payloadGet(event, 'model', ''))
  const duration = payloadText(payloadGet(event, 'duration', ''))
  const timestamp = payloadText(payloadGet(event, 'timestamp', ''))
  const task = payloadText(payloadGet(event, 'task', ''))
  const summary = task !== '' ? task : subAgentLabel((event as Record<string, unknown>).subAgentIdx)
  const badges = [model, duration !== '' ? `${duration}s` : '', timestamp]
    .filter((part) => part !== '')
    .join(' • ')
  return { status, summary, badges }
}

function subAgentSummary(event: TimelineEventPayload): string {
  const task = payloadText(payloadGet(event, 'task', ''))
  return task !== '' ? task : subAgentLabel((event as Record<string, unknown>).subAgentIdx)
}

function SubAgentBody({
  event,
  onOpenConversation
}: {
  event: TimelineEventPayload
  onOpenConversation: (conversationId: string) => void
}): React.JSX.Element {
  const conversationId = payloadText(payloadGet(event, 'conversationId', ''))
  const label = subAgentLabel((event as Record<string, unknown>).subAgentIdx)
  const model = payloadText(payloadGet(event, 'model', ''))
  const effort = payloadText(payloadGet(event, 'effort', ''))
  const task = payloadText(payloadGet(event, 'task', ''))
  const result = payloadText(payloadGet(event, 'result', ''))
  const error = payloadText(payloadGet(event, 'error', ''))
  const switches = (payloadArray(payloadGet(event, 'model_switches', [])) as Record<string, unknown>[]).map(
    (s) => `${payloadText(payloadGet(s, 'fromModel', ''))} → ${payloadText(payloadGet(s, 'toModel', ''))}: ${payloadText(
      payloadGet(s, 'reason', '')
    )}`
  )
  const compactions = (payloadArray(payloadGet(event, 'compactions', [])) as Record<string, unknown>[]).map(
    (item) => payloadDict(item)
  )

  return (
    <div style={{ margin: 'calc(6 * var(--u)) calc(8 * var(--u))' }}>
      <div className="md-heading">{label} Details</div>
      {task ? (
        <>
          <div className="md-heading">Sub-Task</div>
          <div className="md-paragraph">{task}</div>
        </>
      ) : null}
      {model || effort ? (
        <>
          <div className="md-heading">Configuration</div>
          <div className="md-paragraph">
            {`Model: ${model || 'default'}  •  Effort: ${effort || 'Medium'}`}
          </div>
        </>
      ) : null}
      {switches.length > 0 ? (
        <>
          <div className="md-heading">Model Switches</div>
          {switches.map((s, i) => (
            <div key={i} className="md-paragraph" style={{ color: '#f59e0b' }}>
              {s}
            </div>
          ))}
        </>
      ) : null}
      {compactions.length > 0 ? (
        <>
          <div className="md-heading">Compactions</div>
          {compactions.map((item, i) => {
            const when = payloadText(payloadGet(item, 'trigger', 'auto'))
            const state = payloadText(payloadGet(item, 'status', ''))
            const summarized = payloadText(payloadGet(item, 'messagesSummarized', 0))
            const beforePercent = payloadText(payloadGet(item, 'beforePercent', 0))
            const afterPercent = payloadText(payloadGet(item, 'afterPercent', beforePercent))
            const error = payloadText(payloadGet(item, 'error', ''))
            const summary = payloadText(payloadGet(item, 'summary', ''))
            return (
              <div className="subagent-compaction" key={i}>
                <div className="subagent-compaction-head">
                  <span className="action-icon">
                    <Glyph glyph="🗜️" />
                  </span>
                  <span className="subagent-compaction-title">Compact Conversation</span>
                  <span className="subagent-compaction-meta">
                    {`${when === 'manual' ? 'Manual' : 'Auto'} • ${state}`}
                  </span>
                  <span className="subagent-compaction-meta">
                    {`${summarized} messages • ${beforePercent}% -> ${afterPercent}%`}
                  </span>
                </div>
                {error ? (
                  <div className="md-paragraph" style={{ color: '#fca5a5' }}>
                    {error}
                  </div>
                ) : null}
                {summary ? (
                  <details className="compaction-summary">
                    <summary>Read-only summary</summary>
                    <pre>{summary}</pre>
                  </details>
                ) : null}
              </div>
            )
          })}
        </>
      ) : null}
      {error ? (
        <>
          <div className="md-heading">Error</div>
          <div className="md-paragraph" style={{ color: '#fca5a5' }}>
            {error}
          </div>
        </>
      ) : null}
      {result ? (
        <>
          <div className="md-heading">Result</div>
          <div className="md-paragraph">{result}</div>
        </>
      ) : null}
      {conversationId ? (
        <button
          className="tb-btn"
          onClick={() => onOpenConversation(conversationId)}
          style={{ marginTop: 'calc(6 * var(--u))' }}
          type="button"
        >
          Open conversation
        </button>
      ) : null}
    </div>
  )
}
