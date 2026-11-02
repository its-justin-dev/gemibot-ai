import { readFileSync } from 'fs'
import { join } from 'path'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  qrBestFit,
  qrChunks,
  qrPayloadBytes,
  qrPngBytes,
  qrSymbol
} from '../../src/main/utils/py-qrcode'

/**
 * The `qrcode` 1.5.4 oracle for `tool_qr_generate`: the frozen chunk split, version, mask and
 * bordered module grid of 33 payloads, plus the pixels of 10 PNGs Pillow wrote.
 *
 * `tests/fixtures/v1-qr.json` was captured by `tools/parity/probe-qr-seg.py`, `probe-qr-grid.py`
 * and `probe-qr-png2.py` from `current.v1.0/.venv`, so the literals here survive that tree being
 * removed.  The PNG bytes themselves are a listed divergence — Pillow adaptive-filters its
 * scanlines and this writes filter 0 — so the comparison decodes both and looks at the pixels.
 */

const FIXTURE = join(__dirname, '..', 'fixtures', 'v1-qr.json')

interface OracleCase {
  payload: string
  chunks: { mode: number; len: number }[]
  version: number | null
  mask: number | null
  matrix: string[] | null
  error: string | null
}

interface OraclePng {
  payload: string
  size: number[]
  pngB64: string
}

const oracle: { cases: OracleCase[]; pngs: OraclePng[] } = JSON.parse(
  readFileSync(FIXTURE, 'utf8')
) as { cases: OracleCase[]; pngs: OraclePng[] }

/** The bordered grid as rows of `0`/`1`, the shape the probe wrote. */
function gridOf(symbol: { modules: Uint8Array; side: number }): string[] {
  const rows: string[] = []
  for (let row = 0; row < symbol.side; row++) {
    let text = ''
    for (let col = 0; col < symbol.side; col++) text += symbol.modules[row * symbol.side + col]
    rows.push(text)
  }
  return rows
}

const shortLabel = (text: string): string => JSON.stringify(text.slice(0, 28))

/** The line `execute()` prints for an uncaught error: `{type(e).__name__}: {e}`. */
function raised(fn: () => unknown): string | null {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return `${error.name}: ${error.message}`
    return String(error)
  }
  return null
}

describe('qrcode — the frozen v1.0 chunk split and version', () => {
  it('covers the whole payload table the probes walked', () => {
    expect(oracle.cases.length).toBe(33)
    expect(oracle.pngs.length).toBe(10)
  })

  for (const entry of oracle.cases) {
    it(`splits ${shortLabel(entry.payload)}`, () => {
      const bytes = qrPayloadBytes(entry.payload)
      expect(
        qrChunks(bytes).map((chunk) => ({ mode: chunk.mode, len: chunk.bytes.length }))
      ).toEqual(entry.chunks)
      expect(qrBestFit(qrChunks(bytes))).toBe(entry.version)
    })
  }

  it('keeps the anchored-pattern quirk that splits a 20-byte payload at its newline', () => {
    // `optimal_data_chunks()` picks the pattern style once for the whole payload from
    // `len(data) <= minimum`, and Python's `$` also matches before a final newline.  So a payload
    // of exactly 20 bytes runs the anchored `^\d+$`, which stops one short of the `\n`, while the
    // same digits plus two newlines are 22 bytes and run the unanchored `\d{20,}` instead.
    const split = (text: string): { mode: number; len: number }[] =>
      qrChunks(qrPayloadBytes(text)).map((chunk) => ({ mode: chunk.mode, len: chunk.bytes.length }))
    expect(split('1234567890123456789\n')).toEqual([
      { mode: 1, len: 19 },
      { mode: 4, len: 1 }
    ])
    expect(split('12345678901234567890\n\n')).toEqual([
      { mode: 1, len: 20 },
      { mode: 4, len: 2 }
    ])
    // Unanchored, a run of 20 is enough on its own and the split happens mid-payload.
    const runs = oracle.cases.find((entry) => entry.payload.startsWith('11111111111111111111a'))
    expect(runs, 'the frozen mid-payload split case is still in the table').toBeDefined()
    expect(split(runs!.payload)).toEqual(runs!.chunks)
    // The alnum class is `'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'` — uppercase only, so a
    // mixed-case payload never takes MODE_ALPHA_NUM even though every character is printable.
    expect(split('AB12 $%*+-./:')).toEqual([{ mode: 2, len: 13 }])
    expect(split('MiXeD CaSe 42!')).toEqual([{ mode: 4, len: 14 }])
  })

  it('reports an overflow through the version setter, not DataOverflowError', () => {
    // 5000 bytes need version 41; the `version` property validates before the `== 41` branch, so
    // the library's own overflow class is unreachable.
    expect(raised(() => qrSymbol(qrPayloadBytes('z'.repeat(5000))))).toBe(
      'ValueError: Invalid version (was 41, expected 1 to 40)'
    )
  })
})

describe('qrcode — the frozen v1.0 mask choice and grid', () => {
  for (const entry of oracle.cases) {
    if (entry.matrix === null) continue
    it(`draws ${shortLabel(entry.payload)}`, () => {
      const symbol = qrSymbol(qrPayloadBytes(entry.payload))
      expect(symbol.version).toBe(entry.version)
      expect(symbol.mask).toBe(entry.mask)
      expect(gridOf(symbol)).toEqual(entry.matrix)
    })
  }
})

describe('qrcode — the frozen v1.0 PNG pixels', () => {
  for (const entry of oracle.pngs) {
    it(`matches Pillow for ${shortLabel(entry.payload)}`, async () => {
      const mine = qrPngBytes(qrSymbol(qrPayloadBytes(entry.payload)))
      const theirs = Buffer.from(entry.pngB64, 'base64')
      expect(mine.subarray(0, 12)).toEqual(theirs.subarray(0, 12))
      const raw = async (
        bytes: Buffer
      ): Promise<{ info: { width: number; height: number }; data: Buffer }> =>
        (await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true })) as unknown as {
          info: { width: number; height: number }
          data: Buffer
        }
      const a = await raw(mine)
      const b = await raw(theirs)
      expect([a.info.width, a.info.height]).toEqual(entry.size)
      expect(a.info).toEqual(b.info)
      expect(a.data.equals(b.data)).toBe(true)
    })
  }
})

describe('qrcode — the payload handed to to_bytestring()', () => {
  it('encodes str() of a non-string, so a container goes through its repr', () => {
    // `qrcode.make(7)` encodes `"7"`; the tool only fails later, when it slices the payload.
    for (const [value, text] of [
      [7, '7'],
      [1.5, '1.5'],
      [null, 'None'],
      [true, 'True'],
      [['a'], "['a']"],
      [{ a: 1 }, "{'a': 1}"]
    ] as [unknown, string][])
      expect(qrPayloadBytes(value).equals(Buffer.from(text, 'utf-8'))).toBe(true)
    // bytes reach `to_bytestring()` untouched, so the repr the summary prints is the only change.
    expect(qrPayloadBytes(Buffer.from('hi'))).toEqual(Buffer.from('hi'))
  })

  it('refuses a lone surrogate with the CPython message and position', () => {
    // Measured against `qrcode.make()` for the 13 payloads of `tools/parity/probe-qr-enc.py`.
    const cases: [string, string][] = [
      [
        '\ud800',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed"
      ],
      [
        '\ud800a',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed"
      ],
      [
        'a\udc00',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\udc00' in position 1: surrogates not allowed"
      ],
      [
        '\ud800\ud800',
        "UnicodeEncodeError: 'utf-8' codec can't encode characters in position 0-1: surrogates not allowed"
      ],
      [
        '\ud800a\ud801',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed"
      ],
      [
        'a\ud800b\udc00c',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"
      ],
      [
        '\ud83d\ud83d',
        "UnicodeEncodeError: 'utf-8' codec can't encode characters in position 0-1: surrogates not allowed"
      ],
      [
        '\udfff',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\udfff' in position 0: surrogates not allowed"
      ],
      [
        '\u{1f600}\ud800',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"
      ],
      [
        '\u{1f600}\ud800\u{1f600}',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"
      ],
      [
        '日本語\ud800',
        "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 3: surrogates not allowed"
      ]
    ]
    for (const [payload, message] of cases)
      expect(
        raised(() => qrPayloadBytes(payload)),
        shortLabel(payload)
      ).toBe(message)
  })

  it('diverges on a surrogate pair written as two escapes', () => {
    // Divergence: CPython keeps `"\ud83d\ude00"` as two unpaired code points and cannot encode it,
    // while a JS string is UTF-16, so that spelling *is* the astral character.  The path the tool
    // takes — a JSON payload — combines the pair on both runtimes, so the two agree there.
    expect(qrPayloadBytes('\ud83d\ude00')).toEqual(Buffer.from('\u{1f600}', 'utf-8'))
    expect(qrPayloadBytes('\ud800\udc00')).toEqual(Buffer.from('\u{10000}', 'utf-8'))
    // A real astral payload is one Python code point and four UTF-8 bytes, which is what the
    // frozen grid counted: eight of them made a 32-byte 8-bit chunk.
    expect(qrPayloadBytes('😀')).toHaveLength(4)
    expect(qrPayloadBytes('😀😀😀😀😀😀😀😀')).toHaveLength(32)
  })
})
