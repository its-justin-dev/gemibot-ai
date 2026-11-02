import { useEffect, useRef, useState } from 'react'

import { GlyphText, stripGlyphs } from '@renderer/components/icons'
import { pyLjust } from '@shared/utils/pystr'

const MIN_CHARACTER_WIDTH = 18

interface Props {
  value: string
  values: string[]
  onSelect: (value: string) => void
  className: string
  wrapClassName?: string
  ariaLabel: string
}

export default function OptionMenu({
  value,
  values,
  onSelect,
  className,
  wrapClassName = '',
  ariaLabel
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className={`option-menu-wrap ${wrapClassName}`} ref={wrapRef}>
      <div
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`option-menu ${className}`}
        onClick={() => setOpen((previous) => !previous)}
        role="combobox"
        tabIndex={0}
        title={stripGlyphs(value)}
      >
        <span className="value">
          <GlyphText text={value} />
        </span>
        <span className="arrow">
          <Chevron />
        </span>
      </div>
      {open ? (
        <div className="dropdown-menu" role="listbox">
          {values.map((entry) => (
            <span
              className="entry"
              key={entry}
              onClick={() => {
                setOpen(false)
                onSelect(entry)
              }}
              role="option"
            >
              <GlyphText text={pyLjust(entry, MIN_CHARACTER_WIDTH)} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Chevron(): React.JSX.Element {
  return (
    <svg preserveAspectRatio="none" viewBox="0 0 10 8" xmlns="http://www.w3.org/2000/svg">
      <polyline points="0,1.6 5,6.4 10,1.6" />
    </svg>
  )
}
