import { describe, expect, it } from 'vitest'

import { HELP } from '../../src/shared/constants/help'
import {
  ACTION_ICONS,
  STATUS_COLORS,
  TOOL_DISPLAY_NAMES
} from '../../src/shared/constants/timeline'
import { EffortLevel } from '../../src/shared/models/effort-level'
import { EffortMapper } from '../../src/main/services/effort-mapper.service'
import { fixture } from './load-fixture'

const v1ui = fixture('v1-ui.json')
const v1effort = fixture('v1-effort.json')

/** v2.0-only commands, removed before the v1.0 byte comparison. */
function withoutV2HelpLines(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        !/\/compact(?:ion)?\b/.test(line) &&
        !/\/token\b/.test(line) &&
        !/\/style\b/.test(line) &&
        !/\/deep\b/.test(line) &&
        !/\/steps\b/.test(line) &&
        !/\/stream\b/.test(line) &&
        !/\/buildmode\b/.test(line)
    )
    .join('\n')
}

/** `views/window_app.py` HELP — the text printed by `/help`. */
describe('HELP text', () => {
  it('is byte-identical except the three database-backed commands', () => {
    const expected = String(v1ui.HELP)
      .replace(
        'view /memory/settings.md saved user preferences',
        'view saved user preferences from the conversation database'
      )
      .replace(
        'show /memory/memory.md logs and interaction history',
        'show memory logs and interaction history from the conversation database'
      )
      .replace(
        'clear active chat context and reset /memory/memory.md',
        'clear active chat context and reset memory'
      )
    expect(withoutV2HelpLines(HELP)).toBe(expected)
  })
})

/** Timeline rows added after v1.0; they are appended last, never interleaved. */
const V2_ONLY_TOOLS = new Set([
  'compact_conversation',
  'agent_mode',
  'final_check',
  'loop_stop',
  'step_limit'
])

/** `views/timeline_constants.py` — the labels the GUI timeline cards show. */
describe('timeline constants', () => {
  it('TOOL_DISPLAY_NAMES matches in order', () => {
    const entries = Object.entries(TOOL_DISPLAY_NAMES).filter(
      ([tool]) => !V2_ONLY_TOOLS.has(tool)
    )
    expect(entries).toEqual(v1ui.TOOL_DISPLAY_NAMES)
  })

  it('ACTION_ICONS matches in order', () => {
    const entries = Object.entries(ACTION_ICONS).filter(([tool]) => !V2_ONLY_TOOLS.has(tool))
    expect(entries).toEqual(v1ui.ACTION_ICONS)
  })

  it('STATUS_COLORS matches every fg/bg pair', () => {
    // `Switching` is a v2-only sub-agent status; v1.0 has no counterpart.
    const entries = Object.entries(STATUS_COLORS).filter(([status]) => status !== 'Switching')
    expect(entries).toEqual(v1ui.STATUS_COLORS)
  })
})

/** `models/effort_level.py`. */
describe('EffortLevel', () => {
  it('all_levels() keeps v1.0 display order and metadata', () => {
    const actual = EffortLevel.allLevels().map((level) => ({
      level: level.value,
      display: level.displayName,
      icon: level.icon,
      description: level.description,
      cost_hint: level.costHint
    }))
    const expected = v1effort.levels.map(({ level, display, icon, description, cost_hint }) => ({
      level,
      display,
      icon,
      description,
      cost_hint
    }))
    // v2.0 appended a sixth level; the five rows v1.0 captured keep their exact order and bytes.
    expect(actual.filter((row) => row.level !== 'saving')).toEqual(expected)
    expect(actual.at(-1)).toEqual({
      level: 'saving',
      display: 'Saving',
      icon: '🪶',
      description: 'Cheapest on tokens: 128 thinking plus a trimmed prompt.',
      cost_hint: 'Lowest (~128 tokens)'
    })
  })

  it('from_string resolves every case v1.0 accepted', () => {
    for (const [input, expected] of v1effort.from_string) {
      expect(EffortLevel.fromString(input), `from_string(${JSON.stringify(input)})`).toBe(
        EffortLevel.fromString(expected)
      )
      expect(EffortLevel.fromString(input).value).toBe(expected)
    }
  })
})

/** `services/effort_mapper.py` — capability detection, budgets and status text. */
describe('EffortMapper', () => {
  /**
   * v2.0's one divergence in this table: the Antigravity agents are called through the
   * Interactions API with no request config, so v1.0's `True` advertised a knob nothing reads.
   * Those rows are asserted at their new value instead of skipped — every other probe still has
   * to agree byte-for-byte.
   */
  const isAntigravityProbe = (modelId: unknown): boolean =>
    String(modelId).startsWith('antigravity')

  it('supports_thinking() agrees on every probed model id', () => {
    for (const [modelId, expected] of v1effort.supports) {
      const mine = EffortMapper.supportsThinking(modelId)
      if (isAntigravityProbe(modelId)) {
        expect(mine, `supports_thinking(${JSON.stringify(modelId)})`).toBe(false)
        expect(expected).toBe(true)
        continue
      }
      expect(mine, `supports_thinking(${JSON.stringify(modelId)})`).toBe(expected)
    }
  })

  it('get_thinking_config() returns the same budget for every model/level/flag mix', () => {
    for (const entry of v1effort.configs) {
      const config = EffortMapper.getThinkingConfig(
        entry.model,
        EffortLevel.fromString(entry.level),
        entry.include_thoughts,
        entry.disable_thinking
      )
      if (isAntigravityProbe(entry.model)) {
        expect(config, JSON.stringify(entry)).toBeNull()
        continue
      }
      expect(config, JSON.stringify(entry)).toEqual(
        entry.budget === null
          ? null
          : { thinkingBudget: entry.budget, includeThoughts: entry.thoughts }
      )
    }
  })

  it('accepts raw strings and numbers where v1.0 re-parsed the level', () => {
    for (const entry of v1effort.loose) {
      const raw = entry.raw === 'None' ? null : entry.raw
      const config = EffortMapper.getThinkingConfig(entry.model, raw)
      expect(
        config === null ? null : config.thinkingBudget,
        `budget ${entry.model} ${entry.raw}`
      ).toBe(entry.budget)
      expect(
        EffortMapper.getStatusDescription(entry.model, raw),
        `status ${entry.model} ${entry.raw}`
      ).toBe(entry.status)
    }
  })

  it('keeps the level metadata and status sentence of the effort table', () => {
    for (const entry of v1effort.levels) {
      const level = EffortLevel.fromString(entry.level)
      const config = EffortMapper.getThinkingConfig('gemini-3.5-flash', level, false)
      expect(config === null ? null : config.thinkingBudget, entry.level).toBe(entry.budget)
      expect(EffortMapper.getStatusDescription('gemini-3.5-flash', level)).toBe(entry.status)
      expect(EffortMapper.getStatusDescription('gemini-2.5-flash-image', level)).toBe(
        entry.status_nothink
      )
    }
  })

  it('reports the fixed sentence for a model without thinking', () => {
    expect(EffortMapper.getStatusDescription('imagen-3.0-generate-002', EffortLevel.HIGH)).toBe(
      'Thinking effort is not applicable to this model (standard direct generation).'
    )
  })
})
