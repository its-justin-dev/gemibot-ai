import { describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import {
  clip,
  ensureBro,
  isBinary,
  safeFence,
  stripMarkdownMarkers
} from '../../src/shared/utils/text'
import { fixture } from './load-fixture'

/** `utils/helpers.py` string helpers that appear verbatim in CLI and GUI output. */
const v1 = fixture('v1-strings.json')

describe('clip', () => {
  it('truncates with the same marker text', () => {
    expect([clip('x'.repeat(40), 10), clip('x'.repeat(5), 10)]).toEqual(v1.clip[0])
    expect([clip('short', 10), clip('x'.repeat(5), 10)]).toEqual(v1.clip[1])
    expect([clip('a'.repeat(30001))]).toEqual(v1.clip[2])
    expect(AppConstants.MAX_OUTPUT).toBe(30000)
  })
})

describe('safe_fence', () => {
  it('picks a fence that cannot collide with the content', () => {
    const inputs: Array<string | null> = [
      '',
      null,
      'plain',
      '```',
      '````',
      'a ``` b ```` c ```',
      '```x```'
    ]
    expect(inputs.map((t) => safeFence(t))).toEqual(v1.safe_fence)
  })
})

describe('ensure_bro', () => {
  it('rewrites "brother" and appends the greeting exactly like v1.0', () => {
    for (const [expected, user, reply] of v1.ensure_bro) {
      expect(
        ensureBro(user, reply),
        `ensure_bro(${JSON.stringify(user)}, ${JSON.stringify(reply)})`
      ).toBe(expected)
    }
  })
})

describe('strip_markdown_markers', () => {
  it('matches text_formatters.strip_markdown_markers', () => {
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

describe('is_binary', () => {
  it('scans the same 8000-byte window', () => {
    const samples: number[][] = [[], [97, 98, 99], [97, 98, 0, 99], [...Array(9000).fill(120), 0]]
    expect(samples.map((bytes) => isBinary(Uint8Array.from(bytes)))).toEqual(v1.binary)
  })
})
