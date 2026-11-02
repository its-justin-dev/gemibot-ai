import { describe, expect, it } from 'vitest'

import { fnmatch } from '../../src/shared/utils/fnmatch'
import { fixture } from './load-fixture'

/**
 * `grep_files(include=...)`, `.gemibot` filtering and settings matching all go
 * through `fnmatch.fnmatch`, which is case-insensitive and backslash-normalising
 * on Windows because of `os.path.normcase`. The fixture was captured on the same
 * platform v1.0 runs on.
 */
const v1 = fixture('v1-fnmatch.json')

describe('fnmatch port', () => {
  it('reproduces the whole name x pattern matrix', () => {
    for (const [pattern, expected] of v1.matrix) {
      v1.names.forEach((name: string, i: number) => {
        expect(
          fnmatch(name, pattern),
          `fnmatch(${JSON.stringify(name)}, ${JSON.stringify(pattern)})`
        ).toBe(expected[i])
      })
    }
  })

  it('keeps the sample corpus it was measured against', () => {
    expect(v1.names).toEqual([
      'app.py',
      'APP.PY',
      'test_one.py',
      'readme.md',
      '.env',
      'main.tsx',
      'a.b.c'
    ])
    expect(v1.patterns).toHaveLength(7)
  })
})
