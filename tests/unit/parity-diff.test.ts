import { describe, expect, it } from 'vitest'

import { ndiff, unifiedDiff } from '../../src/shared/utils/difflib'
import { computeDiffStats } from '../../src/shared/utils/markdown'
import { pySplitlines } from '../../src/shared/utils/pystr'
import { fixture } from './load-fixture'

/**
 * `difflib.unified_diff` / `difflib.ndiff` drive every diff string v1.0 prints —
 * the Pending Changes review, the terminal mirror and the timeline card
 * `+n -n` counts. npm's `diff` package does not reproduce CPython's
 * autojunk/`_fancy_replace` behaviour, so `shared/utils/difflib.ts` is a port.
 */
const cases = fixture('v1-diff.json')

describe('difflib port', () => {
  it('covers the same sample matrix v1.0 was asked to diff', () => {
    expect(cases).toHaveLength(41)
  })

  it('unified_diff output is identical', () => {
    for (const c of cases) {
      const a = pySplitlines(c.old)
      const b = pySplitlines(c.new)
      expect(
        unifiedDiff(a, b, c.from, c.to, '', '', 3, ''),
        `unified: ${c.from} ${c.new.length}`
      ).toEqual(c.unified)
    }
  })

  it('ndiff output is identical', () => {
    for (const c of cases) {
      expect(ndiff(pySplitlines(c.old), pySplitlines(c.new)), `ndiff: ${c.new.length}`).toEqual(
        c.ndiff
      )
    }
  })

  it('compute_diff_stats (+n -n on timeline cards) is identical', () => {
    for (const c of cases) {
      expect(
        computeDiffStats(c.old, c.new),
        `stats for ${JSON.stringify(c.new.slice(0, 20))}`
      ).toEqual(c.stats)
    }
  })
})
