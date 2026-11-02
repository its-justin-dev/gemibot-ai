import { useEffect, useState } from 'react'

import { Glyph } from '@renderer/components/icons'
import { pyFormatFixed } from '@shared/utils/pyformat'
import { pyTime } from '@shared/utils/pytime'
import type { ThinkingState } from '@shared/types/window'

const SPINNERS = ['|', '/', '-', '\\']
const FRAMES = [
  'Thinking and processing',
  'Thinking and processing.',
  'Thinking and processing..',
  'Thinking and processing...'
]

const TICK_MS = 250

export default function ThinkingRow({ thinking }: { thinking: ThinkingState }): React.JSX.Element {
  const [start] = useState(() => pyTime())
  const [step, setStep] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setStep((previous) => previous + 1), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const elapsed = pyFormatFixed(pyTime() - start, 1)
  const parts = [...thinking.parts, `${elapsed}s`]
  const text = `${SPINNERS[step % SPINNERS.length]}  ${FRAMES[step % FRAMES.length]} [${parts.join('  •  ')}]`

  return (
    <div className="row-thinking">
      <div className="thinking-card">
        <span className="bolt">
          <Glyph glyph="⚡" />
        </span>
        <span className="thinking-label">{text}</span>
      </div>
    </div>
  )
}
