import { describe, expect, it } from 'vitest'

import {
  canonicalBase64,
  contentModelDumpJson,
  contentModelValidateJson,
  decodeBase64LikePydantic,
  modelFieldNames
} from '../../src/main/models/content'
import {
  PyFloat,
  pyJsonDumps,
  pyFloatRepr,
  pyJsonEscapeString
} from '../../src/shared/utils/pyjson'
import { fixture, fixtureMarked } from './load-fixture'

/**
 * Differential tests for the two JSON writers v1.0 uses on `.gemibot/session.json`:
 * `json.dumps` for the file itself and pydantic `model_dump_json(exclude_none=True)`
 * for every entry of its `contents` list.
 */

type ScalarCase = { js: string; out: string }
type StringCase = { value: string; ascii: string; utf8: string }
type ValueCase = { label: string; value: unknown; out: string }
type ModelCase = {
  in: string
  out?: string
  full?: string
  stable?: boolean
  error?: string
  error_head?: string
}
type Base64Case = { in: string; out?: string; bytes?: number[]; error?: string }
type SchemaField = { name: string; alias: string; annotation: string }
type SchemaTable = { model: string; fields: SchemaField[] }

const data = fixture<{
  floats: ScalarCase[]
  ints: { js: string; bigint: boolean; out: string }[]
  strings: StringCase[]
  values: ValueCase[]
  model: ModelCase[]
  base64: Base64Case[]
  schema: Record<string, SchemaTable>
}>('v1-json.json')

/**
 * The same file read through `pyJsonLoads`: every `1.0` in a fixture stays a Python float,
 * which is what makes the `values` and `indent` cases byte-testable.
 */
const marked = fixtureMarked<{ values: ValueCase[]; indent: ValueCase[] }>('v1-json.json')

describe('json.dumps bytes', () => {
  it('formats floats exactly like float.__repr__', () => {
    for (const case_ of data.floats) {
      expect(pyFloatRepr(Number(case_.js))).toBe(
        case_.out.replace('NaN', 'nan').replace('Infinity', 'inf')
      )
    }
  })

  it('writes the json.dumps scalar forms', () => {
    const scalarOnly = (case_: ScalarCase): string => {
      const value = Number(case_.js)
      // `json.dumps` prints the bare NaN / Infinity constants for non-finite floats.
      if (!Number.isFinite(value)) return pyJsonDumps(value)
      return pyJsonDumps(new PyFloat(value))
    }
    for (const case_ of data.floats) {
      if (case_.out === 'NaN') expect(scalarOnly(case_)).toBe('NaN')
      else if (case_.out === 'Infinity') expect(scalarOnly(case_)).toBe('Infinity')
      else if (case_.out === '-Infinity') expect(scalarOnly(case_)).toBe('-Infinity')
      else expect(scalarOnly(case_)).toBe(case_.out)
    }
  })

  it('writes integers without a decimal point', () => {
    for (const case_ of data.ints) {
      const value = case_.bigint ? BigInt(case_.js) : Number(case_.js)
      expect(pyJsonDumps(value)).toBe(case_.out)
    }
  })

  it('escapes strings with the ensure_ascii=True table', () => {
    for (const case_ of data.strings) {
      expect(pyJsonEscapeString(case_.value, true)).toBe(case_.ascii)
      expect(pyJsonEscapeString(case_.value, false)).toBe(case_.utf8)
    }
  })

  it('dumps nested structures with the default separators', () => {
    for (const case_ of marked.values) {
      expect(pyJsonDumps(case_.value), case_.label).toBe(case_.out)
    }
  })

  it('dumps tool arguments the way log_interaction_to_memory() does', () => {
    const indentByLabel: Record<string, number | null> = {
      indent0: 0,
      indent2: 2,
      indent4: 4,
      indent_none: null
    }
    for (const case_ of marked.indent) {
      const indent = case_.label in indentByLabel ? indentByLabel[case_.label] : 2
      // `json.dumps(args, ensure_ascii=False, indent=2)`; only the `ascii` case keeps
      // the default `ensure_ascii=True`.
      const ensureAscii = case_.label === 'ascii'
      expect(pyJsonDumps(case_.value, { ensureAscii, indent }), case_.label).toBe(case_.out)
    }
  })

  it('prints an integral float as an integer, where Python keeps 1.0', () => {
    expect(pyJsonDumps(JSON.parse('[1, 1.0]'))).toBe('[1, 1]')
    expect(pyJsonDumps(new PyFloat(1))).toBe('1.0')
    expect(pyJsonDumps(Number('-0.0'))).toBe('0')
  })
})

describe('Content.model_dump_json bytes', () => {
  it('reproduces every validation case', () => {
    for (const case_ of data.model) {
      if (case_.error) {
        expect(() => contentModelValidateJson(case_.in), case_.in).toThrow()
        continue
      }
      const parsed = contentModelValidateJson(case_.in)
      const expected = case_.out as string
      expectDump(case_.in, contentModelDumpJson(parsed), expected)
      expectDump(case_.in, contentModelDumpJson(parsed, false), case_.full as string)
      // The SDK output is a fixed point: validating it again writes the same bytes.
      expectDump(case_.in, contentModelDumpJson(contentModelValidateJson(expected)), expected)
    }
  })

  it('matches the SDK field tables', () => {
    for (const [model, table] of Object.entries(data.schema)) {
      expect(modelFieldNames(model), model).toEqual(
        table.fields.map((field) => ({ name: field.name, alias: field.alias }))
      )
    }
  })

  it('accepts the objects the engine builds directly', () => {
    expect(
      contentModelDumpJson({
        role: 'user',
        parts: [{ function_response: { id: 'abc', name: 'read_file', response: { output: 'ok' } } }]
      })
    ).toBe(
      '{"parts":[{"function_response":{"id":"abc","name":"read_file","response":{"output":"ok"}}}],"role":"user"}'
    )
    expect(
      contentModelDumpJson({
        role: 'model',
        parts: [{ text: 'hello', thought: false }, { text: 'answer' }]
      })
    ).toBe('{"parts":[{"text":"hello","thought":false},{"text":"answer"}],"role":"model"}')
  })
})

/**
 * Compare dumped bytes, allowing exactly one documented divergence: a `Dict[str, Any]`
 * value (`function_call.args`, `function_response.response`, `part_metadata`) that
 * Python read as the float `1.0` reprints as `1`, because JSON.parse leaves no trace
 * of the decimal point. Declared float fields such as `video_metadata.fps` are
 * unaffected — the model table marks those and they still print `24.0`.
 */
function expectDump(source: string, received: string, expected: string): void {
  if (received === expected) return
  expect(received, `${source} (integral float downgrade)`).toBe(
    expected.replace(/(:|,|\[|\s)(-?\d+)\.0(?=[,}\]])/g, '$1$2')
  )
}

describe('pydantic base64 bytes fields', () => {
  it('decodes both alphabets and re-encodes URL_SAFE with padding', () => {
    for (const case_ of data.base64) {
      if (case_.error) {
        expect(() => canonicalBase64(case_.in), case_.in).toThrow()
        continue
      }
      expect(canonicalBase64(case_.in), case_.in).toBe(
        JSON.parse(jsonField(case_.out as string)).data
      )
      expect(decodeBase64LikePydantic(case_.in), case_.in).toEqual(case_.bytes)
    }
  })
})

/** `{"data":"AAH_"}` → the value of the `data` field, as a JSON fragment. */
function jsonField(dump: string): string {
  return `{${dump.slice(1, -1)}}`
}
