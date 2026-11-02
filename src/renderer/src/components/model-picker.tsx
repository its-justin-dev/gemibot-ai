import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { Glyph, GlyphText } from '@renderer/components/icons'
import { EffortLevel } from '@shared/models/effort-level'
import { pyStrip } from '@shared/utils/pystr'
import type { ModelPickerItem, ModelPickerPayload, WindowCommand } from '@shared/types/window'

const CATEGORIES: [string, string, string][] = [
  ['', 'All', 'All'],
  ['⚡', 'Flash', 'Flash'],
  ['🤖', 'Antigravity', 'Antigravity'],
  ['🧠', 'Pro / Frontier', 'Pro & Frontier'],
  ['💎', 'Gemma', 'Gemma'],
  ['🎨', 'Multimodal', 'Image & Video'],
  ['🔊', 'Voice & Audio', 'Audio & Voice'],
  ['🌐', 'Grounding', 'Search Grounding'],
  ['📐', 'Embeddings', 'Embeddings']
]

const FILTER_DEBOUNCE_MS = 25

const FOCUS_DELAY_MS = 20

const PAGE_SCROLL_PX = 40

const NO_MATCH_TITLE = 'No models match your search.'
const NO_MATCH_HINT = 'Try clearing the search query or clicking another category pill above.'
const NO_THINKING_DESC =
  'Thinking effort is not applicable to this model (standard direct response without reasoning tokens).'

function boxSize(previous: [number, number]): [number, number] {
  const pw = window.innerWidth * window.devicePixelRatio
  const ph = window.innerHeight * window.devicePixelRatio
  if (pw <= 100 || ph <= 100) return previous
  return [Math.min(780, Math.max(460, pw - 48)), Math.min(640, Math.max(380, ph - 48))]
}

let frozenEffortHover: string | null = null

function isBlueHover(level: string): boolean {
  return frozenEffortHover !== null && frozenEffortHover === level
}

export function ModelPicker({
  payload,
  send,
  onClose
}: {
  payload: ModelPickerPayload
  send: (command: WindowCommand) => void
  onClose: () => void
}): React.JSX.Element {
  const [stagedEffort, setStagedEffort] = useState(payload.currentEffort)
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [lostHighlight, setLostHighlight] = useState<Set<string>>(() => new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const [box, setBox] = useState<[number, number]>(() => boxSize([760, 620]))

  const entryRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const pendingScroll = useRef<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (frozenEffortHover === null) frozenEffortHover = payload.currentEffort
    setStagedEffort(payload.currentEffort)
    setCategory('All')
    setQuery('')
    setFilterQuery('')
    setHighlight(0)
    const focus = setTimeout(() => entryRef.current?.focus(), FOCUS_DELAY_MS)
    return () => clearTimeout(focus)
  }, [payload])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const onResize = (): void => setBox((prev) => boxSize(prev))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setFilterQuery(query), FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHighlight(0), [filterQuery, category])

  const search = pyStrip(filterQuery).toLowerCase()

  const matched = useMemo(
    () =>
      payload.items.filter((info) => {
        if (category !== 'All' && info.category !== category && !info.category.includes(category)) {
          return false
        }
        return search === '' || info.searchable_blob.includes(search)
      }),
    [payload.items, category, search]
  )

  const current = payload.currentModel

  useEffect(() => {
    if (pendingScroll.current === null) return
    const id = pendingScroll.current
    pendingScroll.current = null
    cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest' })
  })

  const choose = (item: ModelPickerItem): void => {
    send({ cmd: 'model-selected', modelId: item.id, display: item.display })
    onClose()
  }

  const setEffort = (level: EffortLevel): void => {
    setStagedEffort(level.value)
    send({ cmd: 'effort-selected', value: level.value })
  }

  const navigate = (delta: number): void => {
    if (matched.length === 0) return
    const next = Math.max(0, Math.min(matched.length - 1, highlight + delta))
    if (next === highlight) return
    const id = matched[next].id
    setHighlight(next)
    setLostHighlight((prev) => {
      if (!prev.has(id)) return prev
      const settled = new Set(prev)
      settled.delete(id)
      return settled
    })
    pendingScroll.current = id
  }

  const pageScroll = (direction: number): void => {
    resultsRef.current?.scrollBy(0, direction * PAGE_SCROLL_PX)
  }

  useEffect(() => {
    const onKeyDownWindow = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDownWindow, true)
    return () => window.removeEventListener('keydown', onKeyDownWindow, true)
  }, [onClose])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = matched[highlight]
      if (item) choose(item)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      navigate(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      navigate(-1)
      return
    }
    if (event.key === 'PageDown') {
      event.preventDefault()
      pageScroll(1)
      return
    }
    if (event.key === 'PageUp') {
      event.preventDefault()
      pageScroll(-1)
    }
  }

  const supports = payload.supportsThinking
  const staged = EffortLevel.allLevels().find((level) => level.value === stagedEffort)

  const cardColors = (id: string): { bg: string; border: string } => {
    const isActive = id === current
    const base = isActive
      ? { bg: '#22252a', border: '#10b981' }
      : { bg: '#1c1e22', border: '#2b2e36' }
    if (hovered === id && !isActive) return { bg: '#23262d', border: '#3b82f6' }
    const index = matched.findIndex((item) => item.id === id)
    if (index === highlight && !lostHighlight.has(id)) return { bg: '#262930', border: '#60a5fa' }
    return base
  }

  const [bw, bh] = box

  return (
    <div className="pk-backdrop">
      <div
        className="pk-box"
        style={{
          width: `min(calc(${bw} * var(--u)), calc(100vw - 32px))`,
          height: `min(calc(${bh} * var(--u)), calc(100vh - 32px))`
        }}
      >
        <div className="pk-hdr">
          <div className="pk-hdr-left">
            <span className="pk-title">
              <Glyph glyph="🔍" />
              Select AI Model & Reasoning Effort
            </span>
            <span className="pk-sub">
              {'Instant typeahead across all models with reasoning effort controls.'}
            </span>
          </div>
          <button type="button" className="pk-close" onClick={onClose}>
            <Glyph glyph="✕" />
          </button>
        </div>

        <div className="pk-search">
          <span className="pk-search-icon">
            <Glyph glyph="🔍" />
          </span>
          <input
            ref={entryRef}
            className="pk-search-entry"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="pk-search-clear"
            onClick={() => {
              setQuery('')
              entryRef.current?.focus()
            }}
          >
            <Glyph glyph="✖" />
          </button>
        </div>

        <div className="pk-pills">
          {CATEGORIES.map(([glyph, label, value]) => (
            <button
              key={value}
              type="button"
              className={`pk-pill${category === value ? ' is-active' : ''}${
                value === 'All' ? ' pk-pill-all' : ''
              }`}
              onClick={() => setCategory(value)}
            >
              {glyph !== '' ? <Glyph glyph={glyph} /> : null}
              {label}
            </button>
          ))}
        </div>

        <div className="pk-effort">
          <div className="pk-effort-row">
            <span className="pk-effort-title">{'Reasoning Effort:'}</span>
            <div className="pk-effort-btns">
              {EffortLevel.allLevels().map((level) => (
                <button
                  key={level.name}
                  type="button"
                  className={`pk-effort-btn${
                    supports && level.value === stagedEffort ? ' is-active' : ''
                  }${isBlueHover(level.value) ? ' pk-effort-blue' : ''}`}
                  disabled={!supports}
                  onClick={() => setEffort(level)}
                >
                  <Glyph glyph={level.icon} />
                  {level.displayName}
                </button>
              ))}
            </div>
          </div>
          <span className={`pk-effort-desc${supports ? '' : ' is-unsupported'}`}>
            {supports && staged ? (
              <>
                <Glyph glyph={staged.icon} />
                {`${staged.displayName}: ${staged.description}  \u2022  Relative cost: ${staged.costHint}`}
              </>
            ) : (
              <>
                <Glyph glyph="⚠️" />
                {NO_THINKING_DESC}
              </>
            )}
          </span>
        </div>

        <div className="pk-info">
          <span className="pk-count">{`Showing ${matched.length} of ${payload.items.length} models`}</span>
          <span className="pk-active">{`Active: ${payload.activeDisplay}`}</span>
        </div>

        <div className="pk-results" ref={resultsRef}>
          {matched.map((item) => {
            const colors = cardColors(item.id)
            const isActive = item.id === current
            return (
              <div
                key={item.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(item.id, node)
                  else cardRefs.current.delete(item.id)
                }}
                className="pk-card"
                style={{ background: colors.bg, borderColor: colors.border }}
                onMouseEnter={() => setHovered(item.id)}
                onMouseLeave={() => {
                  setHovered(null)
                  setLostHighlight((prev) => {
                    const index = matched.findIndex((other) => other.id === item.id)
                    if (index !== highlight || prev.has(item.id)) return prev
                    const settled = new Set(prev)
                    settled.add(item.id)
                    return settled
                  })
                }}
                onClick={() => choose(item)}
              >
                <div className="pk-left">
                  <div className="pk-top">
                    <span className="pk-name">
                      <GlyphText text={item.display} />
                    </span>
                    {isActive && <span className="pk-active-tag">{'Active'}</span>}
                  </div>
                  <div className="pk-bot">
                    <span className="pk-id">{item.id}</span>
                    <span className="pk-badge">
                      {` \u2022  `}
                      <GlyphText text={item.badge} />
                    </span>
                  </div>
                </div>
                <span className={`pk-act${isActive ? ' is-active' : ''}`}>
                  {isActive ? 'Active' : 'Select'}
                </span>
              </div>
            )
          })}
          {matched.length === 0 && (
            <div className="pk-empty">
              <span className="pk-empty-title">
                <Glyph glyph="🔍" />
                {NO_MATCH_TITLE}
              </span>
              <span className="pk-empty-hint">{NO_MATCH_HINT}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
