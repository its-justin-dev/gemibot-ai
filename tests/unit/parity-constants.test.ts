import { describe, expect, it } from 'vitest'

import { Colors } from '../../src/shared/constants/colors'
import { AppConstants } from '../../src/shared/constants/app-constants'
import { fixture } from './load-fixture'

/**
 * Every literal in `configs/constants.py`, compared against the value v1.0
 * actually holds at runtime.
 */
const v1 = fixture('v1-constants.json')

describe('AppConstants literals', () => {
  it('MODEL_CATALOG keeps every id, label and order', () => {
    expect(Object.entries(AppConstants.MODEL_CATALOG)).toEqual(v1.MODEL_CATALOG)
  })

  it('model lists and sets match', () => {
    expect(AppConstants.ANTIGRAVITY_MODELS).toEqual(v1.ANTIGRAVITY_MODELS)
    expect(Object.entries(AppConstants.MODEL_ALIASES)).toEqual(v1.MODEL_ALIASES)
    expect(AppConstants.FALLBACK_MODELS).toEqual(v1.FALLBACK_MODELS)
    expect([...AppConstants.GROUNDING_MODELS].sort()).toEqual(v1.GROUNDING_MODELS)
    expect(AppConstants.MODELS).toEqual(v1.MODELS)
    expect(AppConstants.IMAGE_MODELS).toEqual(v1.IMAGE_MODELS)
    expect([...AppConstants.IGNORED].sort()).toEqual(v1.IGNORED)
    expect(AppConstants.REQUIRED_PIP_PACKAGES).toEqual(v1.REQUIRED_PIP_PACKAGES)
  })

  it('numeric and layout constants match', () => {
    expect(AppConstants.MAX_STEPS).toBe(v1.MAX_STEPS)
    expect(AppConstants.MAX_OUTPUT).toBe(v1.MAX_OUTPUT)
    // WIDTH is a `views/window_app.py` module global, captured in the UI fixture.
    expect(AppConstants.WIDTH).toBe(fixture('v1-ui.json').WIDTH)
    expect(AppConstants.SPINNER_FRAMES).toEqual(v1.SPINNER_FRAMES)
  })

  it('session location matches and memory/settings file paths are gone', () => {
    expect(AppConstants.SESSION_DIR).toBe(v1.SESSION_DIR)
    expect(v1.MEMORY_REL_PATH).toBe('memory/memory.md')
    expect(v1.SETTINGS_REL_PATH).toBe('memory/settings.md')
    expect(AppConstants).not.toHaveProperty('MEMORY_REL_PATH')
    expect(AppConstants).not.toHaveProperty('SETTINGS_REL_PATH')
  })

  it('memory headers now point at the database instead of the old files', () => {
    expect(AppConstants.MEMORY_HEADER).toContain('conversation database')
    expect(AppConstants.MEMORY_HEADER).not.toContain('/memory/memory.md')
    expect(AppConstants.SETTINGS_HEADER).toContain('conversation database')
    expect(AppConstants.SETTINGS_HEADER).not.toContain('/memory/settings.md')
  })

  it('keeps the prompt blocks verbatim except the database move', () => {
    const memorySection = (persona: string): string => {
      const start = persona.indexOf('Memory & Continuity Protocol:')
      const end = persona.indexOf('Capabilities & Specialized Suites:')
      return persona.slice(start, end)
    }
    const withoutMemorySection = (persona: string): string =>
      persona.replace(memorySection(persona), '<MEMORY>')

    expect(withoutMemorySection(AppConstants.PERSONA)).toBe(withoutMemorySection(v1.PERSONA))
    expect(memorySection(AppConstants.PERSONA)).toContain('conversation database')
    expect(memorySection(AppConstants.PERSONA)).not.toContain('/memory/')
    expect(AppConstants.PLAN_NOTE).toBe(v1.PLAN_NOTE)
    expect(AppConstants.READ_NOTE).toBe(v1.READ_NOTE)
  })

  it('every ANSI colour escape matches utils/colors.py', () => {
    expect({ ...Colors }).toEqual(v1.COLORS)
  })
})

describe('model helpers', () => {
  it('resolves and classifies every catalog id the way v1.0 does', () => {
    for (const row of v1.model_logic) {
      const id = row.id
      expect(AppConstants.resolveModelId(id), `resolveModelId(${JSON.stringify(id)})`).toBe(
        row.resolved
      )
      expect(AppConstants.isAntigravity(id), `isAntigravity(${JSON.stringify(id)})`).toBe(
        row.antigravity
      )
      expect(AppConstants.isGemma(id), `isGemma(${JSON.stringify(id)})`).toBe(row.gemma)
      expect(AppConstants.isEmbedding(id), `isEmbedding(${JSON.stringify(id)})`).toBe(row.embedding)
      expect(AppConstants.isGrounding(id), `isGrounding(${JSON.stringify(id)})`).toBe(row.grounding)
      expect(AppConstants.getModelCategory(id), `getModelCategory(${JSON.stringify(id)})`).toBe(
        row.category
      )
      expect(AppConstants.getModelBadge(id), `getModelBadge(${JSON.stringify(id)})`).toBe(row.badge)
    }
  })

  it('isNetworkError classifies the same strings', () => {
    for (const [text, expected] of v1.network_errors) {
      expect(AppConstants.isNetworkError(text), `isNetworkError(${JSON.stringify(text)})`).toBe(
        expected
      )
    }
  })
})
