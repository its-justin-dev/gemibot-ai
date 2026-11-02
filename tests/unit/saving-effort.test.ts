import { describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { EffortMapper } from '../../src/main/services/effort-mapper.service'
import { EffortLevel } from '../../src/shared/models/effort-level'
import { hasGlyph } from '../../src/renderer/src/components/icons'

/**
 * The Saving effort: the cheapest the app can be on tokens while still answering like a normal
 * model. v1.0's five levels and their budgets are pinned in parity-model.test.ts and parity-ui
 * .test.ts; this covers the one we added on top.
 */

const THINKING_MODEL = 'gemini-3.5-flash'

function budgetOf(level: EffortLevel): number | null {
  return EffortMapper.getThinkingConfig(THINKING_MODEL, level)?.thinkingBudget ?? null
}

describe('the Saving effort', () => {
  it('joins the level list without moving any of v1.0 five', () => {
    expect(EffortLevel.allLevels().map((level) => level.value)).toEqual([
      'turbo',
      'low',
      'medium',
      'high',
      'extra_high',
      'saving'
    ])
  })

  it('thinks with the smallest budget of any effort that thinks at all', () => {
    expect(EffortLevel.allLevels().map((level) => [level.value, budgetOf(level)])).toEqual([
      ['turbo', null],
      ['low', 512],
      ['medium', 2048],
      ['high', 8192],
      ['extra_high', 16384],
      ['saving', 128]
    ])
  })

  it('is the cheapest effort once the prompt is counted too', () => {
    expect(AppConstants.SAVING_MEMORY_PROMPT_CHARS).toBeLessThan(AppConstants.MEMORY_PROMPT_CHARS)
    expect(AppConstants.SAVING_HISTORY_KEEP_ENTRIES).toBeLessThan(AppConstants.HISTORY_KEEP_ENTRIES)
  })

  it('is picked by the words a user would actually type', () => {
    // The v1.0 parser matches a prefix of the display name, so `sav` and `saving` land here while
    // a full word the name does not start with (`save`) still falls through to the default.
    for (const raw of ['saving', 'SAVING', 'Saving', '  saving  ', 'sav', 'EffortLevel.SAVING']) {
      expect(EffortLevel.fromString(raw).value, raw).toBe('saving')
    }
  })

  it('leaves the v1.0 fallbacks of the loose parser alone', () => {
    expect(EffortLevel.fromString('').value).toBe('low')
    expect(EffortLevel.fromString(null).value).toBe('medium')
    expect(EffortLevel.fromString('nonsense').value).toBe('medium')
    expect(EffortLevel.fromString('extra').value).toBe('extra_high')
    expect(EffortLevel.fromString(7).value).toBe('medium')
  })

  it('describes the trade-off in the picker', () => {
    const level = EffortLevel.SAVING
    expect(level.displayName).toBe('Saving')
    expect(level.icon).toBe('🪶')
    expect(level.description).toContain('128')
    expect(level.costHint).toContain('Lowest')
    expect(EffortMapper.getStatusDescription(THINKING_MODEL, level)).toBe(
      `🪶 Saving Effort: ${level.description} (${level.costHint})`
    )
  })

  it('draws an icon in the picker like every other level', () => {
    // `Glyph` strips anything outside its table, so an unmapped emoji silently loses its icon.
    for (const level of EffortLevel.allLevels()) {
      expect(hasGlyph(level.icon), `${level.value} ${level.icon}`).toBe(true)
    }
  })

  it('still sends no thinking config at all to a model that cannot think', () => {
    expect(EffortMapper.getThinkingConfig('gemini-2.5-flash-image', EffortLevel.SAVING)).toBeNull()
    // Antigravity answers through the Interactions API with no request config, so offering an
    // effort for it would only put a number on screen that nothing reads.
    for (const id of AppConstants.ANTIGRAVITY_MODELS) {
      expect(EffortMapper.supportsThinking(id), id).toBe(false)
      expect(EffortMapper.getThinkingConfig(id, EffortLevel.HIGH), id).toBeNull()
    }
  })
})
