import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'

import { MAX_SCROLLBACK, type ConsoleLine } from '@shared/utils/console-buffer'
import type { ConsoleBuffer } from '@shared/utils/console-buffer'
import { Glyph } from '@renderer/components/icons'

const MIN_WIDTH_PX = 260
const OTHER_PANES_PX = 520

interface Props {
  buffer: ConsoleBuffer
  readLine: { id: number; prompt: string } | null
  scale: number
  answer: (kind: 'read-line', id: number, value: string | null) => void
}

export default function ConsolePane({ buffer, readLine, scale, answer }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [widthUnits, setWidthUnits] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [tick, repaint] = useState(0)
  const screenRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; units: number } | null>(null)

  useEffect(() => {
    let frame = 0
    let seen = buffer.revision
    const step = (): void => {
      if (buffer.revision !== seen) {
        seen = buffer.revision
        repaint((previous) => previous + 1)
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [buffer])

  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => {
    const node = screenRef.current
    if (node !== null && atBottom) node.scrollTop = node.scrollHeight
  }, [tick, collapsed, readLine, atBottom])

  const markBottom = (): void => {
    const node = screenRef.current
    if (node === null) return
    const next = node.scrollTop + node.clientHeight >= node.scrollHeight - 1
    setAtBottom((previous) => (previous === next ? previous : next))
  }

  const jumpToLatest = (): void => {
    setAtBottom(true)
    const node = screenRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }

  const lines: ConsoleLine[] = buffer.snapshot()
  const shownCollapsed = collapsed && readLine === null

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const pane = paneRef.current
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
    const next = start.units - (event.clientX - start.x) / scale
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

  const resetWidth = (): void => {
    setWidthUnits(null)
  }

  const sized = widthUnits !== null && !shownCollapsed

  return (
    <div
      className={`console-pane${shownCollapsed ? ' collapsed' : ''}${sized ? ' sized' : ''}`}
      ref={paneRef}
      style={widthUnits === null ? undefined : ({ '--cw': String(widthUnits) } as CSSProperties)}
    >
      {!shownCollapsed ? (
        <>
          <div
            aria-orientation="vertical"
            className={`console-resizer${dragging ? ' dragging' : ''}`}
            onDoubleClick={resetWidth}
            onPointerCancel={endDrag}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            role="separator"
            title="Drag to resize the console, double-click to reset"
          />
          {dragging ? <div className="console-drag-shield" /> : null}
        </>
      ) : null}
      <div className="console-head">
        <button
          aria-label={shownCollapsed ? 'Expand console' : 'Collapse console'}
          className="console-toggle"
          onClick={() => {
            setAtBottom(true)
            setCollapsed((previous) => !previous)
          }}
          type="button"
        >
          {shownCollapsed ? '⟩' : '⟨'}
        </button>
        {!shownCollapsed ? (
          <>
            <span className="grow">MIRROR CONSOLE</span>
            <span>{`${Math.min(lines.length, MAX_SCROLLBACK)} lines`}</span>
          </>
        ) : null}
      </div>
      {!shownCollapsed ? (
        <div className="console-screen selectable" onScroll={markBottom} ref={screenRef}>
          {lines.map((line, index) => (
            <ConsoleRow key={buffer.start + index} line={line} />
          ))}
        </div>
      ) : null}
      {!shownCollapsed && !atBottom ? (
        <button className="jump-btn" onClick={jumpToLatest} type="button">
          <Glyph glyph="↓" />
          Jump to latest
        </button>
      ) : null}
      {readLine !== null ? (
        <ReadLinePrompt
          buffer={buffer}
          key={readLine.id}
          prompt={readLine.prompt}
          submit={(value) => answer('read-line', readLine.id, value)}
        />
      ) : null}
    </div>
  )
}

/**
 * The spinner rewrites the buffer around sixteen times a second and only the last row ever
 * changes, so rows are memoized against their identity: a repaint costs one node, not 5000.
 */
const ConsoleRow = memo(function ConsoleRow({ line }: { line: ConsoleLine }): React.JSX.Element {
  return (
    <span className="console-line">
      {line.length === 0
        ? ''
        : line.map((run, runIndex) => (
            <span className={run.classes.join(' ')} key={runIndex}>
              {run.text}
            </span>
          ))}
    </span>
  )
})

function ReadLinePrompt({
  buffer,
  prompt,
  submit
}: {
  buffer: ConsoleBuffer
  prompt: string
  submit: (value: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="console-prompt">
      <span className="console-prompt-text">{prompt}</span>
      <input
        className="console-prompt-input"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            buffer.write(`${prompt}${value}\n`)
            submit(value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            buffer.write(`${prompt}^C\n`)
            submit(null)
          }
        }}
        ref={inputRef}
        spellCheck={false}
        value={value}
      />
    </div>
  )
}
