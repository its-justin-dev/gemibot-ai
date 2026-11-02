import { useEffect, useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import {
  API_KEY_VARS,
  GEMINI_KEY_PREFIX,
  apiKeyProblem,
  cleanApiKey,
  maskApiKey
} from '@shared/utils/api-key'
import type { ApiKeyInfo } from '@shared/types/api-key'

interface Props {
  onClose: () => void
}

export default function ApiKeyDialog({ onClose }: Props): React.JSX.Element {
  const [info, setInfo] = useState<ApiKeyInfo | null>(null)
  const [key, setKey] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.getApiKey().then((payload) => {
      if (!active) return
      setInfo(payload)
      setKey(payload.key)
    })
    return () => {
      active = false
    }
  }, [])

  const varsLine = (info?.vars ?? [...API_KEY_VARS]).join('  •  ')
  const file = info?.file ?? '.env'

  const askToSave = (): void => {
    const problem = apiKeyProblem(cleanApiKey(key))
    if (problem !== null) {
      setError(problem)
      return
    }
    setError(null)
    setConfirming(true)
  }

  const commit = async (): Promise<void> => {
    setSaving(true)
    const result = await window.api.saveApiKey(key)
    setSaving(false)
    if (!result.ok) {
      setError(result.message)
      setConfirming(false)
      return
    }
    onClose()
  }

  if (confirming) {
    return (
      <div className="dlg-backdrop">
        <div aria-modal="true" className="dlg-box dlg-apikey" role="dialog">
          <div className="dlg-head">
            <span className="dlg-title dlg-title-confirm">
              <Glyph glyph="⚠️" />
              CONFIRM API KEY
            </span>
            <span className="dlg-badge">{maskApiKey(cleanApiKey(key))}</span>
          </div>
          <div className="dlg-msg">Save this API key and use it for every request from now on?</div>
          <div className="dlg-detail">
            <div className="dlg-detail-text key-detail selectable">
              {`Written to  ${file}\n\n${varsLine}\n\nThe key is stored in plain text on this machine and every\nrequest is billed to the subscription it belongs to.`}
            </div>
          </div>
          <div className="dlg-buttons">
            <button
              className="dlg-btn dlg-confirm-key"
              disabled={saving}
              onClick={() => void commit()}
              type="button"
            >
              {saving ? 'Saving...' : 'Yes, save & use'}
            </button>
            <button
              autoFocus
              className="dlg-btn dlg-cancel"
              onClick={() => setConfirming(false)}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dlg-backdrop">
      <div aria-modal="true" className="dlg-box dlg-apikey" role="dialog">
        <div className="dlg-head">
          <span className="dlg-title dlg-title-apikey">
            <Glyph glyph="🔑" />
            API KEY
          </span>
          <span className="dlg-badge">{info === null ? '...' : maskApiKey(info.key)}</span>
        </div>
        <div className="dlg-msg">
          Use your own subscription. The key is applied immediately and saved in your .env file.
          <span className="dlg-msg-rule">
            {`Validation: only a Google Gemini AI API key is accepted - it must start with ${GEMINI_KEY_PREFIX}.`}
          </span>
        </div>
        <div className="key-row">
          <input
            aria-label="API key"
            autoFocus
            className="key-entry"
            onChange={(event) => {
              setKey(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // Without this, the same Enter keypress falls through to the confirmation
              // dialog's auto-focused button and cancels what it just opened.
              event.preventDefault()
              askToSave()
            }}
            placeholder="Paste your API key..."
            spellCheck={false}
            type={revealed ? 'text' : 'password'}
            value={key}
          />
          <button
            aria-label={revealed ? 'Hide API key' : 'Show API key'}
            className="key-eye"
            onClick={() => setRevealed((previous) => !previous)}
            title={revealed ? 'Hide' : 'Show'}
            type="button"
          >
            <Glyph glyph={revealed ? '🙈' : '👁️'} />
          </button>
        </div>
        {error !== null ? <span className="key-err">{error}</span> : null}
        <div className="dlg-detail">
          <div className="dlg-detail-text key-detail selectable">
            {`Saved as\n  ${varsLine}\n\nIn\n  ${file}\n\nGoogle Gemini keys start with\n  ${GEMINI_KEY_PREFIX}`}
          </div>
        </div>
        <div className="dlg-buttons">
          <button className="dlg-btn dlg-save" onClick={askToSave} type="button">
            Save API Key
          </button>
          <button className="dlg-btn dlg-cancel" onClick={onClose} type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
