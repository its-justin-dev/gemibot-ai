import { useMemo } from 'react'

import { parseMarkdownBlocks } from '@shared/utils/markdown'
import { pySplitlines } from '@shared/utils/pystr'

function codeHeight(code: string): number {
  return Math.min(Math.max(pySplitlines(code).length * 18 + 10, 48), 340)
}

interface Props {
  text: string
  onCopy: (code: string) => void
}

export default function MarkdownBlocks({ text, onCopy }: Props): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text])
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const size = Math.max(18 - block.level * 2, 12)
          return (
            <div className="md-heading" key={index} style={{ fontSize: `${size}px` }}>
              {block.text}
            </div>
          )
        }

        if (block.type === 'code') {
          return (
            <div className="code-frame" key={index}>
              <div className="code-head">
                <span className="code-lang">{`code: ${block.lang}`}</span>
                <button className="code-copy" onClick={() => onCopy(block.code)} type="button">
                  Copy
                </button>
              </div>
              <pre
                className="code-body selectable"
                style={{ height: `calc(${codeHeight(block.code)} * var(--u))` }}
              >
                {block.code}
              </pre>
            </div>
          )
        }

        if (block.type === 'list') {
          return block.items.map(([marker, item], itemIndex) => (
            <div className="md-list-row" key={`${index}-${itemIndex}`}>
              <span className="md-list-marker">{marker}</span>
              <span className="md-list-item">{item}</span>
            </div>
          ))
        }

        if (!block.text.trim()) return null
        return (
          <div className="md-paragraph" key={index}>
            {block.text}
          </div>
        )
      })}
    </>
  )
}

export type { Props as MarkdownBlocksProps }
