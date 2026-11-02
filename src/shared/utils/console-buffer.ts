export interface ConsoleRun {
  text: string
  classes: string[]
}

export type ConsoleLine = ConsoleRun[]

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /\x1b\[[0-9;]*[A-Za-z]|\r|\n/g

export const MAX_SCROLLBACK = 5000

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [[]]
  private classes: string[] = []
  private col = 0
  revision = 0
  /** Index the retained `lines[0]` was written at, so a viewer can key rows without shifting. */
  start = 0

  write(chunk: string): void {
    this.revision += 1
    for (const token of tokenize(chunk, this.classes)) {
      if (token.kind === 'run') {
        this.classes = token.classes
        if (token.text !== '') this.place(token.text, token.classes)
      } else if (token.kind === 'carriage-return') {
        this.col = 0
      } else if (token.kind === 'newline') {
        this.lines.push([])
        this.col = 0
        if (this.lines.length > MAX_SCROLLBACK) {
          this.lines.shift()
          this.start += 1
        }
      } else {
        this.erase(token.direction)
      }
    }
  }

  private place(text: string, classes: string[]): void {
    const line = this.lines[this.lines.length - 1]
    const before = cutAt(line, this.col)
    const after = sliceFrom(line, this.col + text.length)
    const padding = this.col - visibleLength(before)
    const runs: ConsoleLine = padding > 0 ? [...before, blank(padding)] : before.slice()
    runs.push({ text, classes })
    this.lines[this.lines.length - 1] = [...runs, ...after]
    this.col += text.length
  }

  private erase(direction: 0 | 1 | 2): void {
    const line = this.lines[this.lines.length - 1]
    if (direction === 2) this.lines[this.lines.length - 1] = []
    else if (direction === 1) this.lines[this.lines.length - 1] = blankLeftOf(line, this.col)
    else this.lines[this.lines.length - 1] = cutAt(line, this.col)
  }

  /**
   * Shallow on purpose: `place`/`erase` always rebuild the row they touch, so every other row
   * keeps its identity between writes and a viewer can skip the ones it has already drawn.
   */
  snapshot(): ConsoleLine[] {
    return this.lines.slice()
  }

  text(): string {
    return this.lines.map((line) => line.map((run) => run.text).join('')).join('\n')
  }

  clear(): void {
    this.lines = [[]]
    this.col = 0
    this.start = 0
    this.revision += 1
  }
}

type Token =
  | { kind: 'run'; text: string; classes: string[] }
  | { kind: 'carriage-return' }
  | { kind: 'newline' }
  | { kind: 'erase'; direction: 0 | 1 | 2 }

export function tokenize(text: string, carry: string[] = []): Token[] {
  const tokens: Token[] = []
  let classes = carry.slice()
  let index = 0
  let match: RegExpExecArray | null
  CONTROL_RE.lastIndex = 0
  const pushText = (slice: string): void => {
    if (slice !== '') tokens.push({ kind: 'run', text: slice, classes: classes.slice() })
  }
  while ((match = CONTROL_RE.exec(text)) !== null) {
    pushText(text.slice(index, match.index))
    index = CONTROL_RE.lastIndex
    const seq = match[0]
    if (seq === '\r') tokens.push({ kind: 'carriage-return' })
    else if (seq === '\n') tokens.push({ kind: 'newline' })
    else if (seq.endsWith('m')) classes = applySgrCodes(classes, paramsOf(seq))
    else if (seq.endsWith('K')) {
      const raw = paramsOf(seq)
      const direction: 0 | 1 | 2 = raw === '1' ? 1 : raw === '2' ? 2 : 0
      tokens.push({ kind: 'erase', direction })
    }
  }
  pushText(text.slice(index))
  return tokens
}

function paramsOf(seq: string): string {
  return seq.slice(2, -1)
}

function applySgrCodes(classes: string[], params: string): string[] {
  if (params === '') return []
  let next = classes.slice()
  const codes = params.split(';').map((c) => (c === '' ? 0 : Number(c)))
  for (const code of codes) {
    if (code === 0) next = []
    else if (code === 39) next = next.filter((c) => !c.startsWith('ansi-fg-'))
    else if (code === 49) next = next.filter((c) => !c.startsWith('ansi-bg-'))
    else {
      const cls = sgrClass(code)
      if (cls) next = [...new Set([...next.filter((c) => !conflicts(cls, c)), cls])]
    }
  }
  return next
}

function sgrClass(code: number): string | null {
  if (code === 1) return 'ansi-bold'
  if (code === 2) return 'ansi-dim'
  if (code === 3) return 'ansi-italic'
  if (code === 4) return 'ansi-underline'
  if (code === 53) return 'ansi-overline'
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) return `ansi-fg-${code}`
  if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return `ansi-bg-${code}`
  return null
}

function conflicts(cls: string, other: string): boolean {
  return (
    (cls.startsWith('ansi-fg-') && other.startsWith('ansi-fg-')) ||
    (cls.startsWith('ansi-bg-') && other.startsWith('ansi-bg-'))
  )
}

function visibleLength(line: ConsoleLine): number {
  return line.reduce((sum, run) => sum + run.text.length, 0)
}

function cutAt(line: ConsoleLine, col: number): ConsoleLine {
  const out: ConsoleLine = []
  let used = 0
  for (const run of line) {
    if (used + run.text.length <= col) {
      out.push(run)
      used += run.text.length
    } else {
      const take = col - used
      if (take > 0) out.push({ text: run.text.slice(0, take), classes: run.classes })
      return out
    }
  }
  return out
}

function sliceFrom(line: ConsoleLine, from: number): ConsoleLine {
  const out: ConsoleLine = []
  let used = 0
  for (const run of line) {
    if (used + run.text.length <= from) {
      used += run.text.length
      continue
    }
    const skip = Math.max(0, from - used)
    out.push({ text: run.text.slice(skip), classes: run.classes })
    used += run.text.length
  }
  return out
}

function blankLeftOf(line: ConsoleLine, col: number): ConsoleLine {
  const out: ConsoleLine = []
  let used = 0
  for (const run of line) {
    if (used + run.text.length <= col) {
      out.push(blank(run.text.length))
      used += run.text.length
    } else {
      const skip = Math.max(0, col - used)
      out.push(blank(skip), { text: run.text.slice(skip), classes: run.classes })
      used = col + (run.text.length - skip)
    }
  }
  return out
}

function blank(length: number): ConsoleRun {
  return { text: ' '.repeat(length), classes: [] }
}
