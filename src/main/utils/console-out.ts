import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { KeyboardInterrupt } from '../../shared/utils/exceptions'
import { pyRstrip, pySlice, pyStrip } from '../../shared/utils/pystr'
import { makeUnifiedDiff } from '../../shared/utils/difflib'
import { wrap } from '../../shared/utils/textwrap'
import type { EscMonitor } from '../models/agent-state'

type ConsoleSink = (text: string, terminator: string) => void

const sinks = new Set<ConsoleSink>()

export function onConsoleOutput(sink: ConsoleSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

export function out(text = ''): void {
  process.stdout.write(`${text}\n`)
  for (const sink of sinks) {
    try {
      sink(text, '\n')
    } catch {}
  }
}

export function outRaw(text: string): void {
  process.stdout.write(text)
  for (const sink of sinks) {
    try {
      sink(text, '')
    } catch {}
  }
}

export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export type ShowFn = (
  label: string,
  text: string,
  color: string,
  meta?: string,
  escMonitor?: EscMonitor | null
) => Promise<void>

async function consoleShow(
  label: string,
  text: string,
  color: string,
  meta = '',
  escMonitor: EscMonitor | null = null
): Promise<void> {
  const width = AppConstants.WIDTH
  const headerMeta = meta ? ` ${C.GRAY}- ${meta}${C.RESET}` : ''
  out(`\n${color}│${C.RESET} ${color}${C.BOLD}${label}${C.RESET}${headerMeta}`)
  let inCode = false
  for (const line of pyRstrip(text).split('\n')) {
    if (escMonitor?.check()) throw new KeyboardInterrupt()
    if (pyStrip(line).startsWith('```')) {
      inCode = !inCode
      const lang = pyStrip(pySlice(pyStrip(line), 3))
      const tag = inCode && lang ? ` ${C.BG_BADGE} ${lang} ${C.RESET}` : ''
      out(`${color}│${C.RESET} ${C.GRAY}${'-'.repeat(Math.min(40, width - 4))}${C.RESET}${tag}`)
      continue
    }
    if (inCode || pyStrip(line) === '') {
      const codeColor = inCode ? C.CYAN : ''
      const reset = inCode ? C.RESET : ''
      out(`${color}│${C.RESET}   ${codeColor}${line}${reset}`)
      continue
    }
    const wrapped = wrap(line, width - 2, { subsequentIndent: '' })
    for (const part of wrapped.length > 0 ? wrapped : ['']) {
      if (escMonitor?.check()) throw new KeyboardInterrupt()
      out(`${color}│${C.RESET} ${part}`)
      if (escMonitor) await sleep(0.004)
    }
  }
}

let showImpl: ShowFn = consoleShow

export function setShowImpl(fn: ShowFn | null): ShowFn {
  const previous = showImpl
  showImpl = fn ?? consoleShow
  return previous
}

export function show(
  label: string,
  text: string,
  color: string,
  meta = '',
  escMonitor: EscMonitor | null = null
): Promise<void> {
  return showImpl(label, text, color, meta, escMonitor)
}

export function printDiff(
  rel: string,
  oldText: string | null,
  newText: string | null,
  isNew: boolean
): void {
  const badge = isNew ? `${C.GREEN}+ CREATED${C.RESET}` : `${C.YELLOW}~ MODIFIED${C.RESET}`
  out(`\n  ${C.GRAY}- ${badge} ${C.BOLD}${rel}${C.RESET}`)
  const diff = makeUnifiedDiff(rel, oldText, newText)
  for (const line of diff.slice(2, 82)) {
    let color: string = C.DIM
    if (line.startsWith('+')) color = C.GREEN
    else if (line.startsWith('-')) color = C.RED
    else if (line.startsWith('@@')) color = C.CYAN
    out(`  ${C.GRAY}- ${color}${line}${C.RESET}`)
  }
  if (diff.length > 82) {
    out(`  ${C.GRAY}- ${C.DIM}... ${diff.length - 82} more diff lines${C.RESET}`)
  }
  out(`  ${C.GRAY}-`)
}
