import { describe, expect, it } from 'vitest'

import { fill, wrap } from '../../src/shared/utils/textwrap'
import { fixture } from './load-fixture'

/**
 * v1.0 wraps AI replies and CLI messages with `textwrap` at `WIDTH - 2`, so the
 * line breaks in the transcript are part of the output. `shared/utils/textwrap.ts`
 * is a port of CPython's `TextWrapper`, including `wordsep_re` hyphen handling,
 * tab expansion and the long-word break rules.
 */
const cases = fixture('v1-wrap.json')

describe('textwrap port', () => {
  it('wrap(line, width - 2, subsequent_indent="") is identical', () => {
    for (const c of cases) {
      const out = wrap(c.line, c.width - 2, { subsequentIndent: '' })
      expect(out.length ? out : [''], `wrap ${c.width}: ${c.line.slice(0, 24)}`).toEqual(c.wrap)
    }
  })

  it('wrap(line, width - 2) defaults are identical', () => {
    for (const c of cases) {
      const out = wrap(c.line, c.width - 2)
      expect(out.length ? out : [''], `wrap_default ${c.width}`).toEqual(c.wrap_default)
    }
  })

  it('fill(line, width, initial_indent="** ", subsequent_indent="   ") is identical', () => {
    for (const c of cases) {
      expect(
        fill(c.line, c.width, { initialIndent: '** ', subsequentIndent: '   ' }),
        `fill ${c.width}`
      ).toBe(c.fill_indent)
    }
  })
})
