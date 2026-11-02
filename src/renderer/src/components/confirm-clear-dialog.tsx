import { Glyph } from '@renderer/components/icons'
import type { WindowAnswer } from '@shared/types/window'

interface Props {
  id: number
  answer: (kind: 'confirm-clear', id: number, value: WindowAnswer) => void
}

export default function ConfirmClearDialog({ id, answer }: Props): React.JSX.Element {
  return (
    <div className="dlg-backdrop">
      <div className="dlg-box dlg-clear" role="dialog" aria-modal="true">
        <div className="dlg-head">
          <span className="dlg-title dlg-title-clear">
            <Glyph glyph="⚠️" />
            CLEAR MEMORY CONFIRMATION
          </span>
          <span className="dlg-badge">conversation database</span>
        </div>
        <div className="dlg-msg">
          Are you sure you want to clear app memory and reset the active chat?
        </div>
        <div className="dlg-detail">
          <div className="dlg-detail-text dlg-detail-clear selectable">
            Clears app memory and the active chat, checkpoints, and todos. The conversation stays
            archived in the database and can still be reopened or exported. The memory reset cannot
            be undone.
          </div>
        </div>
        <div className="dlg-buttons">
          <button
            className="dlg-btn dlg-confirm-clear"
            onClick={() => answer('confirm-clear', id, true)}
            type="button"
          >
            Clear Memory
          </button>
          <button
            autoFocus
            className="dlg-btn dlg-cancel"
            onClick={() => answer('confirm-clear', id, false)}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
