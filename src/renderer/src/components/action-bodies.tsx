import { useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import { payloadGet, payloadText } from '@renderer/state/card-model'
import { stripAnsi } from '@shared/utils/ansi'
import { computeDiffStats } from '@shared/utils/markdown'
import { pyJsonDumps } from '@shared/utils/pyjson'
import { pySplitlines } from '@shared/utils/pystr'

function boxHeight(px: number): string {
  return `calc(${px} * var(--u))`
}

export function CodeSnippet({
  path,
  code,
  onCopy
}: {
  path: string
  code: string
  onCopy: (text: string) => void
}): React.JSX.Element {
  const height = Math.min(Math.max(pySplitlines(code).length * 18, 54), 300)
  return (
    <>
      <div className="snip-head">
        <span className="snip-path">
          <Glyph glyph="📄" />
          {path}
        </span>
        <button className="snip-copy" onClick={() => onCopy(code)} type="button">
          Copy
        </button>
      </div>
      <pre className="snip-body selectable" style={{ height: boxHeight(height) }}>
        {code}
      </pre>
    </>
  )
}

export function GenericActionBody({
  args,
  output
}: {
  args: Record<string, unknown>
  output: string
}): React.JSX.Element {
  const cleanOut = stripAnsi(output)
  const height = Math.min(Math.max(pySplitlines(cleanOut).length * 18 + 10, 50), 260)
  const prefix =
    Object.keys(args).length > 0 ? `Arguments: ${pyJsonDumps(args, { indent: 2 })}\n\n` : ''
  return (
    <pre className="action-text selectable" style={{ height: boxHeight(height) }}>
      {`${prefix}Output:\n${cleanOut}`}
    </pre>
  )
}

export function TerminalCard({
  command,
  output,
  status,
  onCopy
}: {
  command: string
  output: string
  status: unknown
  onCopy: (text: string) => void
}): React.JSX.Element {
  const cleanOut = stripAnsi(output)
  const lines = pySplitlines(cleanOut)
  const isLong = lines.length > 20
  const [showFull, setShowFull] = useState(false)

  const displayed = isLong && !showFull ? lines.slice(0, 20) : lines
  const height =
    isLong && showFull
      ? Math.min(lines.length * 17 + 10, 500)
      : Math.min(Math.max(displayed.length * 17 + 10, 48), 340)
  const ok = status === 'Success'
  const exitMatch = /^exit code (-?\d+)/u.exec(cleanOut)
  const exitCode = exitMatch ? Number(exitMatch[1]) : ok ? 0 : 1

  return (
    <div className="term-frame">
      <div className="term-bar">
        <span className="term-cmd">{`$ ${command}`}</span>
        <span className="term-exit" style={{ background: ok ? '#238636' : '#da3633' }}>
          {` exit: ${exitCode} `}
        </span>
        {}
        <button className="term-copy" onClick={() => onCopy(output)} type="button">
          Copy Output
        </button>
      </div>
      <pre className="term-body selectable" style={{ height: boxHeight(height) }}>
        {displayed.join('\n')}
      </pre>
      {}
      {isLong && !showFull ? (
        <button className="term-more" onClick={() => setShowFull(true)} type="button">
          {`Show full output (${lines.length} lines)`}
        </button>
      ) : null}
    </div>
  )
}

export function DiffCard({
  change,
  onUndo,
  onOpen,
  onCopyPath,
  onCopyCode
}: {
  change: Record<string, unknown>
  onUndo: () => void
  onOpen: (rel: string) => void
  onCopyPath: (rel: string) => void
  onCopyCode: (text: string) => void
}): React.JSX.Element {
  const rel = payloadText(payloadGet(change, 'path', ''))
  const action = payloadText(payloadGet(change, 'action', 'modified'))
  const oldContent = textOrEmpty(payloadGet(change, 'old_content', undefined))
  const newContent = textOrEmpty(payloadGet(change, 'new_content', undefined))
  const rawDiff = payloadText(payloadGet(change, 'diff', ''))
  const [added, removed] = computeDiffStats(oldContent, newContent)
  const [view, setView] = useState<'unified' | 'sbs'>('unified')

  return (
    <div className="diff-frame">
      <div className="diff-bar">
        <span className="diff-path">
          <Glyph glyph="📝" />
          {rel}
        </span>
        <span className="diff-stats">
          <span className="diff-add">{`+${added}`}</span>
          <span className="diff-del">{`-${removed}`}</span>
        </span>
        <button
          className="diff-toggle"
          onClick={() => setView(view === 'unified' ? 'sbs' : 'unified')}
          type="button"
        >
          {}
          {view === 'unified' ? 'Side-by-side' : 'Unified View'}
        </button>
        {}
        <span className="diff-btns">
          <button
            className="diff-btn copy-code"
            onClick={() => onCopyCode(newContent || oldContent)}
            type="button"
          >
            Copy Code
          </button>
          <button className="diff-btn copy-path" onClick={() => onCopyPath(rel)} type="button">
            Copy Path
          </button>
          <button className="diff-btn open" onClick={() => onOpen(rel)} type="button">
            Open
          </button>
          <button className="diff-btn undo" onClick={onUndo} type="button">
            <Glyph glyph="↩" />
            Undo
          </button>
        </span>
      </div>
      <div className="diff-content">
        {view === 'unified' ? (
          <UnifiedDiff
            action={action}
            diff={rawDiff}
            newContent={newContent}
            oldContent={oldContent}
          />
        ) : (
          <SideBySideDiff newContent={newContent} oldContent={oldContent} />
        )}
      </div>
    </div>
  )
}

function UnifiedDiff({
  action,
  diff,
  newContent,
  oldContent
}: {
  action: string
  diff: string
  newContent: string
  oldContent: string
}): React.JSX.Element {
  let lines = diff ? pySplitlines(diff) : []
  if (lines.length === 0 && action === 'created')
    lines = pySplitlines(newContent).map((l) => `+ ${l}`)
  else if (lines.length === 0 && action === 'deleted')
    lines = pySplitlines(oldContent).map((l) => `- ${l}`)

  const height = Math.min(Math.max(lines.length * 18 + 14, 60), 320)
  const text = lines
    .map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`)
    .join('\n')
  return (
    <pre className="diff-unified selectable" style={{ height: boxHeight(height) }}>
      {text}
    </pre>
  )
}

function SideBySideDiff({
  newContent,
  oldContent
}: {
  newContent: string
  oldContent: string
}): React.JSX.Element {
  const oldLines = pySplitlines(oldContent)
  const newLines = pySplitlines(newContent)
  const height = Math.min(
    Math.max(Math.max(oldLines.length, newLines.length, 1) * 18 + 14, 60),
    320
  )
  const number = (lines: string[]): string =>
    lines.map((line, index) => `${String(index + 1).padStart(3, ' ')} | ${line}`).join('\n')

  return (
    <div className="diff-sbs">
      <pre className="diff-old selectable" style={{ height: boxHeight(height) }}>
        {number(oldLines)}
      </pre>
      <pre className="diff-new selectable" style={{ height: boxHeight(height) }}>
        {number(newLines)}
      </pre>
    </div>
  )
}

function textOrEmpty(value: unknown): string {
  return value ? payloadText(value) : ''
}
