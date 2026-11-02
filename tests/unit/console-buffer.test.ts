import { describe, expect, it } from 'vitest'

import { C } from '../../src/shared/constants/colors'
import { ConsoleBuffer, MAX_SCROLLBACK, tokenize } from '../../src/shared/utils/console-buffer'

/**
 * The mirror console pane's byte model.
 *
 * v1.0 never renders its own console — the terminal does — so the evidence here is the byte stream
 * the engine really writes, taken from `console-out.ts` (`out()` appends `\n`, `outRaw()` does not)
 * and from the spinner at `agent-generate.service.ts:229`, which is the only in-place redraw the
 * engine has.  Each case states what a terminal would show, which is what the pane must show.
 */

/** The frame the spinner writes, with the elapsed field pinned so the string is a literal. */
function spinnerFrame(char: string, model: string): string {
  return (
    `\r\x1b[K${C.CYAN}${char}${C.RESET} ${C.BOLD}Thinking...${C.RESET} ` +
    `${C.GRAY}[${model} - fn:all - 0.1s - press ${C.YELLOW}esc${C.GRAY} to interrupt]${C.RESET}`
  )
}

describe('ConsoleBuffer', () => {
  it('keeps a print() line as its own line and drops the codes into style classes', () => {
    const buf = new ConsoleBuffer()
    buf.write(`\n${C.BOLD}${C.BLUE}> hello${C.RESET}\n`)
    expect(buf.text()).toBe('\n> hello\n')
    const lines = buf.snapshot()
    expect(lines[1]).toEqual([{ text: '> hello', classes: ['ansi-bold', 'ansi-fg-94'] }])
  })

  it('overwrites from the column instead of appending, which is what a CR means', () => {
    const buf = new ConsoleBuffer()
    buf.write('abcdefgh')
    buf.write('\rxy')
    expect(buf.text()).toBe('xycdefgh')
  })

  it('redraws the spinner in place, leaving only the newest frame', () => {
    const buf = new ConsoleBuffer()
    buf.write(spinnerFrame('⠋', 'gemini-test'))
    buf.write(spinnerFrame('⠙', 'gemini-test'))
    buf.write(spinnerFrame('⠹', 'gemini-test'))
    expect(buf.snapshot()).toHaveLength(1)
    expect(buf.text()).toContain('⠹')
    expect(buf.text()).not.toContain('⠋')
    expect(buf.text()).toContain('Thinking...')
  })

  it('clears the frame on the finally-write, exactly as the terminal is left blank', () => {
    const buf = new ConsoleBuffer()
    buf.write(spinnerFrame('⠋', 'gemini-test'))
    buf.write('\r\x1b[K')
    expect(buf.text()).toBe('')
    // A following `print()` still lands on its own line, as it does after the spinner stops.
    buf.write(`${C.GREEN}┃ done${C.RESET}\n`)
    expect(buf.text()).toBe('┃ done\n')
  })

  it('carries the SGR state across chunks, since one print is several events', () => {
    const buf = new ConsoleBuffer()
    buf.write(`${C.CYAN}│${C.RESET} `)
    buf.write('plain tail\n')
    const line = buf.snapshot()[0]
    expect(line.map((run) => run.text).join('')).toBe('│ plain tail')
    expect(line[0].classes).toContain('ansi-fg-96')
    expect(line[1].classes).toEqual([])
  })

  it('erases to end of line without a CR, which is the only CSI K form the engine writes', () => {
    const buf = new ConsoleBuffer()
    buf.write('one two three')
    buf.write('\r\x1b[Kone')
    expect(buf.text()).toBe('one')
  })

  it('blanks the whole line on CSI 2 K and the left half on CSI 1 K', () => {
    const buf = new ConsoleBuffer()
    buf.write('abcd\r\x1b[2K')
    expect(buf.text()).toBe('')
    buf.write('abcd\r\x1b[1K')
    // The cursor is at column 0, so erasing to the left removes nothing.
    expect(buf.text()).toBe('abcd')
  })

  it('keeps writing on the same line after an empty frame', () => {
    const buf = new ConsoleBuffer()
    buf.write('\r')
    buf.write('\x1b[K')
    buf.write('tail\n')
    expect(buf.text()).toBe('tail\n')
  })

  it('drops the oldest lines once the scrollback is full', () => {
    const buf = new ConsoleBuffer()
    for (let i = 0; i < MAX_SCROLLBACK + 50; i++) buf.write(`line ${i}\n`)
    const lines = buf.snapshot()
    expect(lines).toHaveLength(MAX_SCROLLBACK)
    expect(buf.text()).not.toContain('line 0\n')
    expect(buf.text()).toContain(`line ${MAX_SCROLLBACK + 49}`)
  })

  it('leaves no escape bytes in the text when a colour run is unterminated', () => {
    const buf = new ConsoleBuffer()
    buf.write(`${C.RED}boom`)
    expect(buf.text()).toBe('boom')
    expect(buf.snapshot()[0][0].classes).toEqual(['ansi-fg-91'])
  })
})

describe('tokenize', () => {
  it('reports the style state each literal was written in', () => {
    const tokens = tokenize(`a${C.GREEN}b${C.RESET}c`)
    expect(tokens).toEqual([
      { kind: 'run', text: 'a', classes: [] },
      { kind: 'run', text: 'b', classes: ['ansi-fg-92'] },
      { kind: 'run', text: 'c', classes: [] }
    ])
  })

  it('applies the bright-background codes without disturbing the foreground', () => {
    const tokens = tokenize('\x1b[107m\x1b[38;5;196mred on bright\x1b[0m')
    // `38;5;n` is not modelled as a class, so only the codes the pane can paint are kept.
    expect(tokens[0]).toEqual({ kind: 'run', text: 'red on bright', classes: ['ansi-bg-107'] })
  })

  it('answers a bare ESC-[m with the reset state', () => {
    expect(tokenize('\x1b[32mgreen\x1b[mplain')[1]).toEqual({
      kind: 'run',
      text: 'plain',
      classes: []
    })
  })
})
