import { useCallback, useEffect, useRef, useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import type { RendererState } from '@renderer/state/window-store'
import type { FileChangeDict } from '@shared/models/file-change'
import type { DiffHunkDict, FileDiffDict } from '@shared/models/file-diff'
import type { WindowCommand } from '@shared/types/window'

const BADGE_COLORS: Record<string, [string, string]> = {
  Added: ['#10b981', '#064e3b'],
  Modified: ['#3b82f6', '#1e3a8a'],
  Deleted: ['#ef4444', '#7f1d1d'],
  Generated: ['#a855f7', '#581c87'],
  'Document edited': ['#f59e0b', '#78350f']
}

function boxSize(previous: [number, number]): [number, number] {
  const pw = window.innerWidth * window.devicePixelRatio
  const ph = window.innerHeight * window.devicePixelRatio
  if (pw <= 100 || ph <= 100) return previous
  return [Math.min(960, Math.max(600, pw - 48)), Math.min(720, Math.max(400, ph - 48))]
}

function whatText(change: FileChangeDict): string {
  if (change.what.length > 0) return change.what.join('; ')
  if (change.detail) return change.detail
  return 'File changed'
}

function whyText(change: FileChangeDict): string {
  return change.why.length > 0 ? change.why.join('; ') : 'not provided'
}

interface Node {
  x: number
  y: number
  text: string
  color: string
  size: number
  anchor: 'w' | 'e'
  bold: boolean
}

function diffNodes(hunks: DiffHunkDict[]): { nodes: Node[]; height: number } {
  const nodes: Node[] = []
  let y = 0
  for (const hunk of hunks) {
    nodes.push({
      x: 8,
      y: y + 6,
      text: hunk.header,
      color: '#6b7280',
      size: 9,
      anchor: 'w',
      bold: false
    })
    y += 18
    for (const line of hunk.lines) {
      const color =
        line.line_type === 'added'
          ? '#10b981'
          : line.line_type === 'removed'
            ? '#ef4444'
            : '#d1d5db'
      const prefix = line.line_type === 'added' ? '+' : line.line_type === 'removed' ? '-' : ' '
      const number = line.line_number ? String(line.line_number) : ''
      nodes.push({
        x: 8,
        y: y + 12,
        text: number,
        color: '#6b7280',
        size: 9,
        anchor: 'e',
        bold: false
      })
      nodes.push({ x: 55, y: y + 12, text: prefix, color, size: 10, anchor: 'w', bold: true })
      nodes.push({
        x: 75,
        y: y + 12,
        text: line.content,
        color,
        size: 10,
        anchor: 'w',
        bold: false
      })
      y += 18
    }
  }
  return { nodes, height: Math.max(y, 200) }
}

function DiffCanvas({ hunks }: { hunks: DiffHunkDict[] }): React.JSX.Element {
  const { nodes, height } = diffNodes(hunks)
  return (
    <div className="rv-diff-container">
      <div className="rv-diff-canvas">
        <div className="rv-diff-inner" style={{ height: `calc(${height} * var(--tk))` }}>
          {nodes.map((node, index) => (
            <span
              className="rv-diff-text"
              key={index}
              style={{
                left: `calc(${node.x} * var(--tk))`,
                top: `calc(${node.y} * var(--tk))`,
                color: node.color,
                fontSize: `calc(${node.size} * var(--tp))`,
                fontWeight: node.bold ? 700 : 400,
                transform: node.anchor === 'e' ? 'translate(-100%, -50%)' : 'translateY(-50%)'
              }}
            >
              {node.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function BinaryDiff({ diff }: { diff: FileDiffDict }): React.JSX.Element {
  const meta = diff.binary_metadata
  if (!meta) {
    return <div className="rv-diff-note">Binary file (no metadata available)</div>
  }
  let text = `Binary file - Size: ${meta.size_bytes} bytes`
  if (meta.is_image) {
    text += ` | Image: ${meta.width}x${meta.height} ${meta.format ?? ''}`
  } else if (meta.mime_type) {
    text += ` | Type: ${meta.mime_type}`
  }
  return (
    <>
      <div className="rv-diff-note light">{text}</div>
      {diff.docx_diff ? (
        <>
          <div className="rv-diff-note docx">
            Note: Text diff shown below (formatting changes not visible)
          </div>
          <DiffCanvas hunks={diff.docx_diff.hunks} />
        </>
      ) : null}
    </>
  )
}

function DiffBody({ diff }: { diff: FileDiffDict }): React.JSX.Element {
  if (diff.has_error) {
    return <div className="rv-diff-note error">{`Error computing diff: ${diff.error_message}`}</div>
  }
  if (diff.is_binary) return <BinaryDiff diff={diff} />
  if (diff.hunks.length === 0) return <div className="rv-diff-note">No changes detected</div>
  return <DiffCanvas hunks={diff.hunks} />
}

function FileBlock({
  change,
  diff,
  expanded,
  onToggle,
  send
}: {
  change: FileChangeDict
  diff: FileDiffDict | null | undefined
  expanded: boolean
  onToggle: () => void
  send: (command: WindowCommand) => void
}): React.JSX.Element {
  const [fg, bg] = BADGE_COLORS[change.change_type] ?? ['#9ca3af', '#262626']
  return (
    <div className="rv-block">
      <div className="rv-head">
        <div className="rv-info">
          <span className="rv-badge" style={{ color: fg, backgroundColor: bg }}>
            {change.change_type.toUpperCase()}
          </span>
          <span className="rv-path">{change.path}</span>
        </div>
        <div className="rv-actions">
          <button className="rv-btn rv-expand" onClick={onToggle} type="button">
            <Glyph glyph={expanded ? '▴' : '▾'} />
          </button>
          <button
            className="rv-btn rv-reject"
            onClick={() => send({ cmd: 'reject-file', path: change.path })}
            type="button"
          >
            <Glyph glyph="✕" />
          </button>
          <button
            className="rv-btn rv-accept"
            onClick={() => send({ cmd: 'accept-file', path: change.path })}
            type="button"
          >
            <Glyph glyph="✓" />
          </button>
        </div>
      </div>
      <div className="rv-desc">
        <div className="rv-what">{`What: ${whatText(change)}`}</div>
        <div className="rv-why">{`Why: ${whyText(change)}`}</div>
      </div>
      {expanded && diff ? (
        <div className="rv-changes">
          <DiffBody diff={diff} />
        </div>
      ) : null}
    </div>
  )
}

export default function ReviewPanel({
  changes,
  state,
  send,
  getDiff,
  onClose
}: {
  changes: FileChangeDict[]
  state: RendererState
  send: (command: WindowCommand) => void
  getDiff: (path: string) => Promise<FileDiffDict | null>
  onClose: () => void
}): React.JSX.Element {
  const [box, setBox] = useState<[number, number]>(() => boxSize([900, 700]))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [diffs, setDiffs] = useState<Record<string, FileDiffDict | null>>({})
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const onResize = (): void => setBox((previous) => boxSize(previous))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const alive = new Set(state.changes.changes.map((item) => item.path))
  const shown = changes.filter((change) => alive.has(change.path))

  useEffect(() => {
    if (shown.length === 0) closeRef.current()
  }, [shown.length])

  const toggle = useCallback(
    (path: string) => {
      const next = new Set(expanded)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        const cached = diffs[path]
        if (cached === undefined || cached === null) {
          void getDiff(path).then((diff) => {
            setDiffs((previous) => ({ ...previous, [path]: diff }))
          })
        }
      }
      setExpanded(next)
    },
    [diffs, expanded, getDiff]
  )

  return (
    <div
      className="rv-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="rv-box"
        style={{
          width: `min(calc(${box[0]} * var(--u)), calc(100vw - 32px))`,
          height: `min(calc(${box[1]} * var(--u)), calc(100vh - 32px))`
        }}
      >
        <div className="rv-top">
          <span className="rv-title">{`Review ${shown.length} Pending Changes`}</span>
          <div className="rv-top-actions">
            <button
              className="rv-top-btn rv-reject-all"
              onClick={() => send({ cmd: 'reject-all' })}
              type="button"
            >
              Reject All
            </button>
            <button
              className="rv-top-btn rv-accept-all"
              onClick={() => send({ cmd: 'accept-all' })}
              type="button"
            >
              Accept All
            </button>
            <button className="rv-top-btn rv-close" onClick={onClose} type="button">
              <Glyph glyph="✕" />
            </button>
          </div>
        </div>
        <div className="rv-scroll">
          {shown.map((change) => (
            <FileBlock
              change={change}
              diff={diffs[change.path]}
              expanded={expanded.has(change.path)}
              key={change.path}
              onToggle={() => toggle(change.path)}
              send={send}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
