import { Glyph } from '@renderer/components/icons'
import { pyStrip } from '@shared/utils/pystr'
import type { WindowAnswer } from '@shared/types/window'

interface Props {
  id: number
  tool: string
  detail: string
  answer: (kind: 'permission', id: number, value: WindowAnswer) => void
}

export default function PermissionDialog({ id, tool, detail, answer }: Props): React.JSX.Element {
  return (
    <div className="dlg-backdrop">
      <div className="dlg-box dlg-perm" role="dialog" aria-modal="true">
        <div className="dlg-head">
          <span className="dlg-title dlg-title-perm">
            <Glyph glyph="⚠️" />
            PERMISSION REQUIRED
          </span>
          <span className="dlg-badge">{`Tool: ${tool}`}</span>
        </div>
        <div className="dlg-msg">
          The AI agent is requesting permission to execute the following operation:
        </div>
        <div className="dlg-detail">
          <div className="dlg-detail-text dlg-detail-perm selectable">{pyStrip(detail)}</div>
        </div>
        <div className="dlg-buttons">
          <button
            autoFocus
            className="dlg-btn dlg-allow"
            onClick={() => answer('permission', id, true)}
            type="button"
          >
            Allow Once
          </button>
          <button
            className="dlg-btn dlg-always"
            onClick={() => answer('permission', id, 'always')}
            type="button"
          >
            Always Allow
          </button>
          <button
            className="dlg-btn dlg-deny"
            onClick={() => answer('permission', id, false)}
            type="button"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}
