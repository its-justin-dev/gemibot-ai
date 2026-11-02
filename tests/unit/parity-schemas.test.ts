import { describe, expect, it } from 'vitest'

import * as defs from '../../src/shared/constants/tool-definitions'
import { fixture } from './load-fixture'

/**
 * `configs/tool_schemas.py` — what the model is told it can call. A single
 * changed word here changes the request, so each group is compared field by
 * field against the declarations captured from v1.0.
 *
 * The copies that `views/window_app.py` keeps locally (no grounding tools, no
 * `what`/`why` parameters) are a separate concern and are covered with the
 * engine port in Stage 2.
 */
const v1 = fixture('v1-tool-schemas.json')

const GROUPS = [
  'READ_TOOLS',
  'WRITE_TOOLS',
  'IMAGE_READ_TOOLS',
  'IMAGE_WRITE_TOOLS',
  'DOCX_READ_TOOLS',
  'DOCX_WRITE_TOOLS',
  'EXCEL_READ_TOOLS',
  'EXCEL_WRITE_TOOLS',
  'PDF_PPTX_READ_TOOLS',
  'PDF_PPTX_WRITE_TOOLS',
  'VOICE_READ_TOOLS',
  'VOICE_WRITE_TOOLS',
  'VIDEO_READ_TOOLS',
  'VIDEO_WRITE_TOOLS',
  'DATA_UTIL_READ_TOOLS',
  'DATA_UTIL_WRITE_TOOLS',
  'GROUNDING_TOOLS'
] as const

describe('tool declarations', () => {
  it.each(GROUPS)('%s matches v1.0 exactly', (group) => {
    expect(defs[group]).toEqual(v1[group])
  })

  it('combined sets keep v1.0 ordering', () => {
    expect(defs.ALL_READ_DECLARATIONS.map((d) => d.name)).toEqual(v1.GROUPS.ALL_READ_DECLARATIONS)
    expect(defs.ALL_WRITE_DECLARATIONS.map((d) => d.name)).toEqual(v1.GROUPS.ALL_WRITE_DECLARATIONS)
    expect(defs.ALL_DECLARATIONS.map((d) => d.name)).toEqual(v1.GROUPS.ALL_DECLARATIONS)
  })

  it('WRITE_NAMES is the same set', () => {
    expect([...defs.WRITE_NAMES].sort()).toEqual(v1.WRITE_NAMES)
  })

  it('FUNCTION_CATALOG keeps every entry and description', () => {
    expect(defs.FUNCTION_CATALOG).toEqual(v1.FUNCTION_CATALOG)
  })

  it('FUNCTION_TOOL_MAP exposes the same tools per function', () => {
    const actual: Record<string, string[]> = {}
    for (const [key, list] of Object.entries(defs.FUNCTION_TOOL_MAP))
      actual[key] = list.map((d) => d.name)
    expect(actual).toEqual(v1.FUNCTION_TOOL_MAP)
  })

  it('TOOL_ICONS matches, including the CLI placeholder dashes', () => {
    expect(Object.entries(defs.TOOL_ICONS)).toEqual(v1.TOOL_ICONS)
  })
})
