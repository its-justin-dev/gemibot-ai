import { useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import type { BuildDocView } from '@shared/types/build'

interface Props {
  docs: BuildDocView[]
  onClose: () => void
}

export default function BuildDocsDialog({ docs, onClose }: Props): React.JSX.Element {
  const [active, setActive] = useState(docs[0]?.name ?? '')
  const current = docs.find((doc) => doc.name === active) ?? docs[0]

  return (
    <div className="dlg-backdrop">
      <div aria-modal="true" className="dlg-box dlg-builddocs" role="dialog">
        <div className="dlg-head">
          <span className="dlg-title dlg-title-builddocs">
            <Glyph glyph="📚" />
            BUILD DOCS
          </span>
          <span className="dlg-badge">{current?.path ?? ''}</span>
        </div>
        <div className="bd-tabs">
          {docs.map((doc) => (
            <button
              aria-pressed={doc.name === current?.name}
              className={`bd-tab${doc.name === current?.name ? ' is-active' : ''}`}
              key={doc.name}
              onClick={() => setActive(doc.name)}
              type="button"
            >
              {doc.name}
            </button>
          ))}
        </div>
        <pre className="bd-content selectable">{current?.content ?? ''}</pre>
        <div className="dlg-buttons">
          <button className="dlg-btn dlg-cancel" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
