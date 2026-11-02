import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { Glyph } from '@renderer/components/icons'
import OptionMenu from '@renderer/components/option-menu'
import type { RendererState, StaticCatalogs } from '@renderer/state/window-store'
import { pyStrip } from '@shared/utils/pystr'
import type { WindowAction, WindowCommand } from '@shared/types/window'

const MIN_WIDTH_PX = 190
const OTHER_PANES_PX = 520

const QUICK_ACTIONS: [WindowAction, string][] = [
  ['todos', '📋 Active task list (/todos)'],
  ['settings', '⚙️ User preferences (/settings)'],
  ['undo', '↩️ Revert last file edit (/undo)'],
  ['revert', '⏪ Roll back checkpoint (/revert)'],
  ['memory', '🧠 View memory history (/memory)'],
  ['pip', '📦 Install deps (/libraries)'],
  ['usage', '📊 Token statistics (/usage)'],
  ['token', '🪙 Token usage & limits (/token)'],
  ['clear', '🧹 Clear chat & memory (/clear)']
]

interface Props {
  state: RendererState
  catalogs: StaticCatalogs
  send: (command: WindowCommand) => void
}

export default function Sidebar({ state, catalogs, send }: Props): React.JSX.Element {
  const [path, setPath] = useState(state.targetEntry)
  const [collapsed, setCollapsed] = useState(false)
  const [widthUnits, setWidthUnits] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [quickAction, setQuickAction] = useState(QUICK_ACTIONS[0][1])
  const sideRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; units: number } | null>(null)
  const scale = state.fontScale.scale
  const activeConversation =
    state.conversations.find((item) => item.id === state.activeConversationId) ?? null

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setPath(state.targetEntry), [state.targetEntry])

  const apply = (): void => send({ cmd: 'target-apply', path: pyStrip(path) })

  const startRename = (id: string, title: string): void => {
    setRenamingId(id)
    setRenameText(title)
    setConfirmDeleteId(null)
  }

  const commitRename = (): void => {
    if (renamingId === null) return
    const title = pyStrip(renameText).trim()
    if (title !== '') send({ cmd: 'conversation-rename', id: renamingId, title })
    setRenamingId(null)
  }

  const requestDelete = (id: string): void => {
    if (confirmDeleteId === id) {
      send({ cmd: 'conversation-delete', id })
      setConfirmDeleteId(null)
      return
    }
    setConfirmDeleteId(id)
    setRenamingId(null)
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pane = sideRef.current
    if (pane === null) return
    dragRef.current = { x: event.clientX, units: pane.getBoundingClientRect().width / scale }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    setDragging(true)
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    if (start === null) return
    const min = MIN_WIDTH_PX / scale
    const max = Math.max(min, (window.innerWidth - OTHER_PANES_PX) / scale)
    const next = start.units + (event.clientX - start.x) / scale
    setWidthUnits(Math.min(max, Math.max(min, next)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  return (
    <div
      className={`sidebar${collapsed ? ' collapsed' : ''}${widthUnits === null ? '' : ' sized'}`}
      ref={sideRef}
      style={widthUnits === null ? undefined : ({ '--sw': String(widthUnits) } as CSSProperties)}
    >
      {!collapsed ? (
        <>
          <div
            aria-orientation="vertical"
            className={`sidebar-resizer${dragging ? ' dragging' : ''}`}
            onDoubleClick={() => setWidthUnits(null)}
            onPointerCancel={endDrag}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            role="separator"
            title="Drag to resize the sidebar, double-click to reset"
          />
          {dragging ? <div className="sidebar-drag-shield" /> : null}
        </>
      ) : null}
      <button
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="sidebar-toggle"
        onClick={() => setCollapsed((previous) => !previous)}
        type="button"
      >
        {collapsed ? '⟩' : '⟨'}
      </button>
      <div className="side-content">
        <div className="target-box">
          <span className="head">
            <Glyph glyph="📁" />
            WORKSPACE
          </span>
          <span className="path" title={state.bar.activeTarget}>
            {state.bar.activeTarget}
          </span>
          <input
            aria-label="Workspace path"
            className="target-entry"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply()
            }}
            placeholder="Enter folder path..."
            value={path}
          />
          {state.targetError !== null ? (
            <span className="target-err">{state.targetError}</span>
          ) : null}
          <div className="target-buttons">
            <button className="btn-apply" onClick={apply} type="button">
              Apply
            </button>
            <button
              className="btn-browse"
              onClick={() => send({ cmd: 'target-browse' })}
              type="button"
            >
              Browse
            </button>
            <button
              className="btn-default"
              onClick={() => send({ cmd: 'target-clear' })}
              type="button"
            >
              Default
            </button>
          </div>
        </div>

        <span className="side-heading">FUNCTION SUITE</span>
        <OptionMenu
          ariaLabel="Function suite"
          className="func-menu"
          onSelect={(display) => send({ cmd: 'function-change', display })}
          value={state.bar.functionMenu}
          values={catalogs.funcOptions}
          wrapClassName="side"
        />
        <span className="side-heading actions">QUICK ACTIONS</span>
        <OptionMenu
          ariaLabel="Quick actions"
          className="func-menu"
          onSelect={(display) => {
            setQuickAction(display)
            const action = QUICK_ACTIONS.find(([, text]) => text === display)
            if (action !== undefined) send({ cmd: 'action', name: action[0] })
          }}
          value={quickAction}
          values={QUICK_ACTIONS.map(([, text]) => text)}
          wrapClassName="side quick-actions-wrap"
        />

        <span className="side-heading actions conversations">CONVERSATIONS</span>
        <button
          className="quick-action conversation-new"
          onClick={() => send({ cmd: 'conversation-new' })}
          type="button"
        >
          <Glyph glyph="＋" />
          New conversation
        </button>
        <div className="conversation-list">
          {state.conversations.length === 0 ? (
            <span className="conversation-empty">No saved conversations yet</span>
          ) : (
            state.conversations.map((item) => (
              <button
                className={`conversation-item${
                  item.id === state.activeConversationId ? ' active' : ''
                }`}
                key={item.id}
                onClick={() => send({ cmd: 'conversation-open', id: item.id })}
                title={`${item.title} — ${item.messageCount} messages`}
                type="button"
              >
                {item.title}
              </button>
            ))
          )}
        </div>
        {activeConversation !== null ? (
          <div className="conversation-actions">
            {renamingId === activeConversation.id ? (
              <input
                aria-label="Conversation title"
                autoFocus
                className="conversation-rename"
                onBlur={commitRename}
                onChange={(event) => setRenameText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') setRenamingId(null)
                }}
                value={renameText}
              />
            ) : (
              <button
                className="conversation-btn"
                onClick={() => startRename(activeConversation.id, activeConversation.title)}
                type="button"
              >
                Rename
              </button>
            )}
            <button
              className={`conversation-btn${confirmDeleteId === activeConversation.id ? ' danger' : ''}`}
              onClick={() => requestDelete(activeConversation.id)}
              type="button"
            >
              {confirmDeleteId === activeConversation.id ? 'Confirm delete' : 'Delete'}
            </button>
            <button
              className="conversation-btn"
              onClick={() =>
                send({ cmd: 'conversation-export', id: activeConversation.id, format: 'md' })
              }
              type="button"
            >
              Export .md
            </button>
            <button
              className="conversation-btn"
              onClick={() =>
                send({ cmd: 'conversation-export', id: activeConversation.id, format: 'json' })
              }
              type="button"
            >
              Export .json
            </button>
          </div>
        ) : null}
        <button
          className="quick-action conversation-folder"
          onClick={() => send({ cmd: 'open-data-folder' })}
          type="button"
        >
          <Glyph glyph="🗂️" />
          Data folder
        </button>
      </div>
      <span className="stats-line" title={state.bar.stats}>
        {state.bar.stats}
      </span>
    </div>
  )
}
