import { useEffect, useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import type { RendererState } from '@renderer/state/window-store'
import { groupBuildChanges } from '@renderer/state/build-change-groups'
import type { FileChangeDict } from '@shared/models/file-change'
import type { WindowCommand } from '@shared/types/window'

const BADGE_COLORS: Record<string, [string, string]> = {
  Added: ['#10b981', '#064e3b'],
  Modified: ['#3b82f6', '#1e3a8a'],
  Deleted: ['#ef4444', '#7f1d1d'],
  Generated: ['#a855f7', '#581c87'],
  'Document edited': ['#f59e0b', '#78350f']
}

function breakdown(counts: Record<string, number>): string {
  const parts: string[] = []
  if (counts['Added']) parts.push(`${counts['Added']} added`)
  if (counts['Modified']) parts.push(`${counts['Modified']} modified`)
  if (counts['Deleted']) parts.push(`${counts['Deleted']} deleted`)
  if (counts['Generated']) parts.push(`${counts['Generated']} generated`)
  if (counts['Document edited']) parts.push(`${counts['Document edited']} doc edited`)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

function timePart(timestamp: string): string {
  return timestamp.includes(' ') ? timestamp.split(' ')[timestamp.split(' ').length - 1] : timestamp
}

function ChangeRow({
  item,
  send
}: {
  item: FileChangeDict
  send: (command: WindowCommand) => void
}): React.JSX.Element {
  const [fg, bg] = BADGE_COLORS[item.change_type] ?? ['#9ca3af', '#262626']
  return (
    <div className="cd-row">
      <span className="cd-pill" style={{ color: fg, backgroundColor: bg }}>
        {item.change_type.toUpperCase()}
      </span>
      <span className="cd-row-path">{item.path}</span>
      <span className="cd-row-time">{timePart(item.timestamp)}</span>
      {}
      <button
        className="cd-row-btn accept"
        onClick={() => send({ cmd: 'accept-file', path: item.path })}
        type="button"
      >
        <Glyph glyph="✓" />
      </button>
      <button
        className="cd-row-btn reject"
        onClick={() => send({ cmd: 'reject-file', path: item.path })}
        type="button"
      >
        <Glyph glyph="✕" />
      </button>
    </div>
  )
}

export default function ChangesDrawer({
  state,
  send
}: {
  state: RendererState
  send: (command: WindowCommand) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [showReads, setShowReads] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state.changesExpanded > 0) setExpanded(true)
  }, [state.changesExpanded])
  /* eslint-enable react-hooks/set-state-in-effect */

  const total = state.changes.total_changes
  const reads = state.changes.files_read
  if (total === 0 && reads.length === 0) return null

  const title = `${total} pending change${total !== 1 ? 's' : ''}`
  const counts = state.changes.counts
  const arrow = showReads ? '▴' : '▾'
  const groups = groupBuildChanges(state.changes.changes, state.build, state.activeConversationId)

  return (
    <div className="changes-drawer">
      <div className="cd-summary">
        <div className="cd-left">
          <span className="cd-icon">
            <Glyph glyph="⚡" />
          </span>
          <span className="cd-title">{title}</span>
          <span className="cd-breakdown">{breakdown(counts)}</span>
        </div>
        <div className="cd-actions">
          <button
            className="cd-btn cd-toggle"
            onClick={() => setExpanded((previous) => !previous)}
            type="button"
          >
            {expanded ? 'Hide' : 'Review'}
            <Glyph glyph={expanded ? '▴' : '▾'} />
          </button>
          <button
            className="cd-btn cd-details"
            onClick={() => send({ cmd: 'review-open' })}
            type="button"
          >
            Details
          </button>
          <button
            className="cd-btn cd-accept"
            onClick={() => send({ cmd: 'accept-all' })}
            type="button"
          >
            Accept all
          </button>
          <button
            className="cd-btn cd-reject"
            onClick={() => send({ cmd: 'reject-all' })}
            type="button"
          >
            Reject all
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="cd-panel">
          <div className="cd-scroll">
            {groups === null
              ? state.changes.changes.map((item) => (
                  <ChangeRow item={item} key={item.path} send={send} />
                ))
              : groups.map((group) => (
                  <div className="cd-group" key={group.id}>
                    <div className="cd-group-title">
                      <span>{group.title}</span>
                      <span>{group.items.length}</span>
                    </div>
                    {group.items.map((item) => (
                      <ChangeRow item={item} key={item.path} send={send} />
                    ))}
                  </div>
                ))}
          </div>
          <div className="cd-reads-bar">
            <button
              className="cd-reads-toggle"
              onClick={() => setShowReads((previous) => !previous)}
              type="button"
            >
              <Glyph glyph="📂" />
              {`Files read (${reads.length})`}
              <Glyph glyph={arrow} />
            </button>
          </div>
          {showReads ? (
            <div className="cd-reads-container">
              <div className="cd-reads-scroll">
                {reads.map((read, index) => (
                  <div className="cd-read-row" key={`${read.path}-${index}`}>
                    <span className="cd-read-icon">
                      <Glyph glyph="📄" />
                    </span>
                    <span className="cd-read-path">{read.path}</span>
                    <span className="cd-read-time">{read.time}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
