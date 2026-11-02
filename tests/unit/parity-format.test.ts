import { describe, expect, it } from 'vitest'

import {
  pyFormatFixed,
  pyFormatIntWidth,
  pyFormatThousands,
  pyRound
} from '../../src/shared/utils/pyformat'
import { fixture } from './load-fixture'

/**
 * Differential tests for the numeric f-string conversions of v1.0, captured from CPython by
 * `tools/parity/dump-v1-fixtures.py` into the `format` bucket of `v1-json.json`.
 *
 * The float cases are the ones a JS port gets wrong by default: `toFixed` rounds half away
 * from zero while CPython rounds the exact binary value to even, so `0.25` and `2.675` are
 * the load-bearing fixtures rather than the round numbers around them.
 *
 * `comma` on a float row is `f"{x:,}"`, the general format with grouping. v1.0 only ever
 * groups integers — every `{n:,}` site is `len(...)`, a token counter or a `//` division —
 * so there is no float-grouping port to test and those rows are left unused on purpose.
 */

type FormatCase = {
  kind: 'float' | 'int'
  py: string
  js: string
  bigint?: boolean
  f0?: string
  f1?: string
  f2?: string
  f4?: string
  comma: string
  w3d?: string
  d2?: string
}

const cases = fixture<{ format: FormatCase[] }>('v1-json.json').format
const floats = cases.filter((case_) => case_.kind === 'float')
const ints = cases.filter((case_) => case_.kind === 'int')

function intValue(case_: FormatCase): number | bigint {
  return case_.bigint ? BigInt(case_.js) : Number(case_.js)
}

describe('f-string numeric formats', () => {
  it('formats floats with ties-to-even at every precision v1.0 uses', () => {
    expect(floats.length).toBeGreaterThan(0)
    for (const case_ of floats) {
      const value = Number(case_.js)
      for (const precision of [0, 1, 2, 4]) {
        expect(pyFormatFixed(value, precision), `${case_.py} :.${precision}f`).toBe(
          case_[`f${precision}` as 'f0' | 'f1' | 'f2' | 'f4']
        )
      }
    }
  })

  it('groups integers exactly like {n:,}', () => {
    for (const case_ of ints) {
      expect(pyFormatThousands(intValue(case_)), `${case_.py} :,`).toBe(case_.comma)
    }
  })

  it('space-pads and zero-pads integers like {:3d} and {:02d}', () => {
    for (const case_ of ints) {
      const value = intValue(case_)
      expect(pyFormatIntWidth(value, 3), `${case_.py} :3d`).toBe(case_.w3d)
      expect(pyFormatIntWidth(value, 2, true), `${case_.py} :02d`).toBe(case_.d2)
    }
  })

  it('keeps round(x, n) in agreement with the format that prints it', () => {
    for (const case_ of floats) {
      const value = Number(case_.js)
      if (!Number.isFinite(value)) continue
      for (const precision of [0, 1, 2, 4]) {
        expect(pyRound(value, precision), `${case_.py} round(${precision})`).toBe(
          Number(case_[`f${precision}` as 'f0' | 'f1' | 'f2' | 'f4'])
        )
      }
    }
  })
})
