import { describe, expect, it } from 'vitest'

import { strftime } from '../../src/shared/utils/strftime'
import { fixture } from './load-fixture'

/**
 * Timestamps written into `memory/memory.md`, `memory/settings.md` and session
 * file names. v1.0 formats them with `datetime.strftime` using the CRT's English
 * locale, so the day and month names are part of the saved bytes.
 */
const v1 = fixture('v1-strftime.json')

const CASES: Array<[Date, string]> = [
  [new Date(2026, 9, 21, 3, 7, 9), '%Y-%m-%d %H:%M:%S (%A, %B %d, %Y %I:%M:%S %p)'],
  [new Date(2026, 9, 21, 3, 7, 9), '%A, %B %d, %Y %I:%M %p'],
  [new Date(2026, 9, 21, 3, 7, 9), '%H:%M:%S'],
  [new Date(2026, 9, 21, 3, 7, 9), '%Y%m%d_%H%M%S'],
  [new Date(2026, 9, 21, 3, 7, 9), '%Y-%m-%d %H:%M:%S'],
  [new Date(2026, 0, 5, 12, 0, 0), '%I:%M:%S %p'],
  [new Date(2026, 0, 5, 0, 0, 0), '%I:%M:%S %p'],
  [new Date(2026, 11, 31, 23, 59, 59), '%a %b %d %H:%M:%S %Y']
]

describe('strftime port', () => {
  it('formats the same stamps v1.0 writes', () => {
    CASES.forEach(([date, fmt], i) => {
      expect(strftime(date, fmt), fmt).toBe(v1.cases[i])
    })
  })

  it('handles noon and midnight meridiems like Python', () => {
    expect(v1.cases[5]).toContain('12:00:00 PM')
    expect(v1.cases[6]).toContain('12:00:00 AM')
  })
})
