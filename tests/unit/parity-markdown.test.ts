import { describe, expect, it } from 'vitest'

import { escapeMarkup, parseMarkdownBlocks } from '../../src/shared/utils/markdown'
import { stripAnsi } from '../../src/shared/utils/ansi'
import { stripMarkdownMarkers } from '../../src/shared/utils/text'
import { fixture } from './load-fixture'

/** `utils/timeline_parser.py` — the block model the GUI chat cards are built from. */
const v1 = fixture('v1-markdown.json')

const BLOCKS_SOURCE = `# Title

Some paragraph text
that continues on the next line.

- one
- two
  continued
1. first
2. second

\`\`\`python
def f():
    return 1
\`\`\`

## Sub heading

   \tindented paragraph
`

describe('parse_markdown_blocks', () => {
  it('splits the same blocks in the same order', () => {
    const inputs = [BLOCKS_SOURCE, '', '```\ncode\n', '- a\n\n\n- b', 'plain only']
    inputs.forEach((text, i) => {
      expect(parseMarkdownBlocks(text), `block case ${i}`).toEqual(v1.parse_markdown_blocks[i])
    })
  })
})

describe('escape_markup', () => {
  it('escapes & < > and tolerates None', () => {
    const inputs: Array<string | null> = ['', "<a href='x'>&</a>", null, 'no markup']
    expect(inputs.map((t) => escapeMarkup(t))).toEqual(v1.escape_markup)
  })
})

describe('strip_ansi', () => {
  it('removes the same escape sequences', () => {
    const inputs = ['\x1b[96mtext\x1b[0m', '\x1b[25lspinner', 'no codes', '\x1b[48;5;29m\x1b[97mbg']
    expect(inputs.map((t) => stripAnsi(t))).toEqual(v1.strip_ansi)
  })
})

describe('markdown fixture cross-check', () => {
  it('keeps the string helpers in sync with the same fixture file', () => {
    const inputs = [
      '',
      '**bold** and *italic* and ***both***',
      '__under__ and _i_',
      'keep `code **here**` untouched',
      '```\n**not stripped**\n```',
      '***a***b**c**',
      '**unclosed'
    ]
    expect(inputs.map((t) => stripMarkdownMarkers(t))).toEqual(v1.strip_markdown)
  })
})
