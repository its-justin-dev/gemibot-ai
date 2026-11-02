import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { pySlice, pyStrip } from '@shared/utils/pystr'
import type { RendererState } from '@renderer/state/window-store'
import type { WindowCommand } from '@shared/types/window'

// Drag floor, in --u units: the .btn-box stack is Send 32u + 4u gap + Stop 24u, so the
// textarea can never shrink past the buttons it sits beside.
const MIN_HEIGHT_UNITS = 60
const CHROME_PX = 380

interface Props {
  state: RendererState
  send: (command: WindowCommand) => void
}

/** Maximum characters to show in queue preview */
const QUEUE_PREVIEW_LENGTH = 60

export default function InputDock({ state, send }: Props): React.JSX.Element {
  const [text, setText] = useState(state.input.text)
  const [heightUnits, setHeightUnits] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  // Track the edited message itself, not its position: the queue shifts whenever the head is
  // delivered, and a stale index would overwrite a different message.
  const [editingText, setEditingText] = useState<string | null>(null)
  const editingIndex = editingText === null ? null : state.queue.indexOf(editingText)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const dragRef = useRef<{ y: number; units: number } | null>(null)
  const scale = state.fontScale.scale
  const usage = state.contextUsage
  const tokens = usage?.tokenUsage

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setText(state.input.text)
    if (state.input.focus) boxRef.current?.focus()
  }, [state.input])
  /* eslint-enable react-hooks/set-state-in-effect */

  const submit = (): void => {
    if (editingIndex !== null) {
      // Saving an in-progress queue edit
      const msg = pyStrip(text)
      if (msg && editingIndex >= 0) {
        send({ cmd: 'queue-edit', index: editingIndex, text: msg })
      }
      setEditingText(null)
      setText('')
      return
    }
    // Always send as 'send'; the main process decides whether to send immediately
    // or add to the queue based on isGenerating.
    const msg = pyStrip(text)
    if (msg) {
      send({ cmd: 'send', text: msg })
      // The queue branch does not send an input event back, so clear locally or the next
      // Enter would queue the same text again.
      setText('')
    }
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = boxRef.current
    if (box === null) return
    dragRef.current = { y: event.clientY, units: box.getBoundingClientRect().height / scale }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    setDragging(true)
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragRef.current
    if (start === null) return
    const min = MIN_HEIGHT_UNITS
    const max = Math.max(min, (window.innerHeight - CHROME_PX) / scale)
    const next = start.units + (start.y - event.clientY) / scale
    setHeightUnits(Math.min(max, Math.max(min, next)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  const handleSendNow = (index: number): void => {
    send({ cmd: 'queue-send-now', index })
  }

  const handleEdit = (index: number): void => {
    setEditingText(state.queue[index] ?? null)
    setText(state.queue[index] ?? '')
  }

  const handleDelete = (index: number): void => {
    send({ cmd: 'queue-delete', index })
  }

  const cancelEdit = (): void => {
    setEditingText(null)
    setText('')
  }

  const isEditing = (index: number): boolean => editingIndex === null ? false : editingIndex === index

  return (
    <div
      className={`input-dock${heightUnits === null ? '' : ' sized'}`}
      style={heightUnits === null ? undefined : ({ '--ih': String(heightUnits) } as CSSProperties)}
    >
      <div
        aria-orientation="horizontal"
        className={`input-resizer${dragging ? ' dragging' : ''}`}
        onDoubleClick={() => setHeightUnits(null)}
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        role="separator"
        title="Drag to resize the input, double-click to reset"
      />
      {dragging ? <div className="input-drag-shield" /> : null}
      <div className="hint">
        <span className="hint-text">
          {
            'Press Enter to send  •  Shift+Enter for newline  •  Type /command or !shell command directly'
          }
        </span>
        {usage !== null ? (
          <span
            className={`context-usage${
              usage.percent >= usage.thresholdPercent
                ? ' is-high'
                : usage.percent >= usage.thresholdPercent - 10
                  ? ' is-warn'
                  : ''
            }`}
            title={
              `Context: ${usage.usedTokens.toLocaleString()} / ${usage.budgetTokens.toLocaleString()} tokens used ` +
              `(${usage.percent}%). Model window: ${usage.limitTokens.toLocaleString()}. ` +
              `Auto-compaction runs at ${usage.thresholdPercent}%.` +
              (tokens === undefined
                ? ''
                : `\nConversation: ${tokens.inputTokens.toLocaleString()} in / ` +
                  `${tokens.outputTokens.toLocaleString()} out / ` +
                  `${tokens.cachedTokens.toLocaleString()} cached over ` +
                  `${tokens.requests.toLocaleString()} request${tokens.requests === 1 ? '' : 's'}` +
                  (tokens.estimatedRequests > 0
                    ? ` (${tokens.estimatedRequests.toLocaleString()} estimated).`
                    : '.'))
            }
          >
            <span className="context-bar">
              <span
                className="context-fill"
                style={{ width: `${Math.max(0, Math.min(100, usage.percent))}%` }}
              />
            </span>
            {`${usage.percent}%`}
          </span>
        ) : null}
      </div>
      {state.queue.length > 0 && (
        <div className="queue-panel">
          <span className="queue-panel-header">Queue</span>
          <div className="queue-panel-list" style={{ maxHeight: `calc(${window.innerHeight - CHROME_PX - 80}px)` }}>
            {state.queue.map((msg, idx) => {
              const editing = isEditing(idx)
              return (
                <div
                  key={idx}
                  className="queue-item"
                >
                  <span className="queue-item-preview">{pySlice(msg, 0, QUEUE_PREVIEW_LENGTH)}...</span>
                  <div className="queue-item-actions">
                    {editing ? (
                      <>
                        <button
                          className="queue-btn queue-save"
                          onClick={(e) => {
                            e.stopPropagation()
                            submit()
                          }}
                          type="button"
                        >
                          ✓
                        </button>
                        <button
                          className="queue-btn queue-cancel"
                          onClick={(e) => {
                            e.stopPropagation()
                            cancelEdit()
                          }}
                          type="button"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="queue-btn queue-send-now"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSendNow(idx)
                          }}
                          type="button"
                        >
                          ✓
                        </button>
                        <button
                          className="queue-btn queue-edit"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleEdit(idx)
                          }}
                          type="button"
                        >
                          ✏️
                        </button>
                        <button
                          className="queue-btn queue-delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(idx)
                          }}
                          type="button"
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {state.queue.length > 8 && (
            <span className="queue-scroll-hint">↑ Scrollable ({state.queue.length} messages)</span>
          )}
        </div>
      )}
      <div className="entry-row">
        <textarea
          aria-label="Message"
          className="input-text"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          ref={boxRef}
          value={text}
        />
        <div className="btn-box">
          {editingIndex !== null && editingIndex >= 0 ? (
            <>
              <button className="send-btn" onClick={submit} type="button">
                Save
              </button>
              <button className="stop-btn" onClick={cancelEdit} type="button">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="send-btn" onClick={submit} type="button">
                Send
              </button>
              <button
                className="stop-btn"
                disabled={!state.isGenerating}
                onClick={() => send({ cmd: 'stop' })}
                type="button"
              >
                Stop
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}