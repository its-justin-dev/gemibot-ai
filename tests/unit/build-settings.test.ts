import { describe, expect, it } from 'vitest'

import type { BuildSettings } from '../../src/shared/types/build'
import {
  DEFAULT_BUILD_SETTINGS,
  buildModeLabel,
  buildSettingsFromDict,
  buildSettingsToDict,
  cycleBuildMode,
  needsPlanApproval,
  normalizeBuildSettings
} from '../../src/shared/utils/build-settings'

function raw(partial: Record<string, unknown>): Partial<BuildSettings> {
  return partial as unknown as Partial<BuildSettings>
}

describe('normalizeBuildSettings', () => {
  it('returns the documented safe defaults', () => {
    expect(normalizeBuildSettings()).toEqual(DEFAULT_BUILD_SETTINGS)
    expect(DEFAULT_BUILD_SETTINGS).toMatchObject({
      mode: 'auto',
      planApproval: 'auto',
      maxTokens: 200_000,
      maxSteps: 300,
      repairAttempts: 5,
      subAgents: 4,
      autoApproveEdits: true,
      installDependencies: true,
      verifyEachMilestone: true,
      smokeTest: true,
      clarify: true,
      planningEffort: 'high',
      implementationEffort: 'medium',
      reviewEffort: 'high'
    })
  })

  it('clamps budgets and worker counts instead of accepting unsafe values', () => {
    const settings = normalizeBuildSettings(
      raw({
        maxTokens: 1,
        maxSteps: 4,
        repairAttempts: -3,
        subAgents: 9
      })
    )
    expect(settings.maxTokens).toBe(10_000)
    expect(settings.maxSteps).toBe(20)
    expect(settings.repairAttempts).toBe(0)
    expect(settings.subAgents).toBe(6)

    const upper = normalizeBuildSettings(
      raw({
        maxTokens: 5_000_000,
        maxSteps: 9_999,
        repairAttempts: 500,
        subAgents: 1
      })
    )
    expect(upper.maxTokens).toBe(2_000_000)
    expect(upper.maxSteps).toBe(1_200)
    expect(upper.repairAttempts).toBe(20)
    expect(upper.subAgents).toBe(2)
  })

  it('rounds finite numbers and falls back for non-numeric values', () => {
    expect(normalizeBuildSettings(raw({ maxTokens: 123_456.7 })).maxTokens).toBe(123_457)
    expect(normalizeBuildSettings(raw({ maxTokens: 'nope' })).maxTokens).toBe(200_000)
    expect(normalizeBuildSettings(raw({ maxSteps: Number.NaN })).maxSteps).toBe(300)
  })

  it('parses booleans from persisted strings', () => {
    expect(normalizeBuildSettings(raw({ autoApproveEdits: 'off' })).autoApproveEdits).toBe(false)
    expect(normalizeBuildSettings(raw({ installDependencies: 'YES' })).installDependencies).toBe(true)
    expect(normalizeBuildSettings(raw({ smokeTest: '0' })).smokeTest).toBe(false)
    expect(normalizeBuildSettings(raw({ clarify: 'true' })).clarify).toBe(true)
    expect(normalizeBuildSettings(raw({ verifyEachMilestone: 'sometimes' })).verifyEachMilestone).toBe(
      true
    )
  })

  it('normalizes mode, approval and effort names', () => {
    expect(normalizeBuildSettings(raw({ mode: 'ON' })).mode).toBe('on')
    expect(normalizeBuildSettings(raw({ mode: 'later' })).mode).toBe('auto')
    expect(normalizeBuildSettings(raw({ planApproval: ' Ask ' })).planApproval).toBe('ask')
    expect(normalizeBuildSettings(raw({ planApproval: 'never' })).planApproval).toBe('auto')
    expect(normalizeBuildSettings(raw({ planningEffort: 'EXTRA HIGH' })).planningEffort).toBe(
      'extra_high'
    )
    expect(normalizeBuildSettings(raw({ implementationEffort: 'extrahigh' })).implementationEffort).toBe(
      'extra_high'
    )
    expect(normalizeBuildSettings(raw({ reviewEffort: 'saving' })).reviewEffort).toBe('saving')
    expect(normalizeBuildSettings(raw({ reviewEffort: 'turbo' })).reviewEffort).toBe('high')
  })

  it('trims and bounds explicit role models', () => {
    const settings = normalizeBuildSettings(
      raw({
        roleModels: {
          strong: `  ${'s'.repeat(200)}  `,
          implementation: '  gemini-3.8-flash ',
          cheap: 42
        }
      })
    )
    expect(settings.roleModels.strong).toHaveLength(120)
    expect(settings.roleModels.strong.startsWith('s')).toBe(true)
    expect(settings.roleModels.implementation).toBe('gemini-3.8-flash')
    expect(settings.roleModels.cheap).toBe('')
  })

  it('ignores unknown extra keys', () => {
    const settings = normalizeBuildSettings(raw({ unknownSetting: true }))
    expect(settings).toEqual(DEFAULT_BUILD_SETTINGS)
  })
})

describe('persisted build settings', () => {
  it('round-trips through a flat string dictionary', () => {
    const original = normalizeBuildSettings({
      mode: 'on',
      planApproval: 'ask',
      maxTokens: 150_000,
      maxSteps: 90,
      repairAttempts: 3,
      subAgents: 5,
      autoApproveEdits: false,
      installDependencies: false,
      verifyEachMilestone: false,
      smokeTest: false,
      clarify: false,
      roleModels: {
        strong: 'gemini-3.1-pro-preview',
        implementation: 'gemini-3.8-flash',
        cheap: 'gemini-3.1-flash-lite'
      },
      planningEffort: 'extra_high',
      implementationEffort: 'low',
      reviewEffort: 'saving'
    })
    const dict = buildSettingsToDict(original)
    expect(dict).toMatchObject({
      build_mode: 'on',
      build_plan_approval: 'ask',
      build_auto_approve_edits: 'false',
      build_install_dependencies: 'false'
    })
    expect(buildSettingsFromDict(dict)).toEqual(original)
  })

  it('uses defaults for an empty dictionary and parses string booleans', () => {
    expect(buildSettingsFromDict({})).toEqual(DEFAULT_BUILD_SETTINGS)
    const parsed = buildSettingsFromDict({
      build_mode: 'off',
      build_max_tokens: '90000',
      build_sub_agents: '3',
      build_smoke_test: 'false',
      build_auto_approve_edits: '1',
      build_planning_effort: 'medium'
    })
    expect(parsed.mode).toBe('off')
    expect(parsed.maxTokens).toBe(90_000)
    expect(parsed.subAgents).toBe(3)
    expect(parsed.smokeTest).toBe(false)
    expect(parsed.autoApproveEdits).toBe(true)
    expect(parsed.planningEffort).toBe('medium')
  })

  it('sanitizes invalid stored values', () => {
    const parsed = buildSettingsFromDict({
      build_mode: 'sideways',
      build_max_tokens: 'NaN',
      build_sub_agents: '99',
      build_plan_approval: 'maybe',
      build_review_effort: 'maximum'
    })
    expect(parsed.mode).toBe('auto')
    expect(parsed.maxTokens).toBe(200_000)
    expect(parsed.subAgents).toBe(6)
    expect(parsed.planApproval).toBe('auto')
    expect(parsed.reviewEffort).toBe('high')
  })
})

describe('build mode helpers', () => {
  it('cycles auto → on → off → auto with labels', () => {
    expect(cycleBuildMode('auto')).toBe('on')
    expect(cycleBuildMode('on')).toBe('off')
    expect(cycleBuildMode('off')).toBe('auto')
    expect(buildModeLabel('auto')).toBe('Build: Auto')
    expect(buildModeLabel('on')).toBe('Build: On')
    expect(buildModeLabel('off')).toBe('Build: Off')
  })

  it('asks for approval on large auto plans and always in ask mode', () => {
    const settings = normalizeBuildSettings()
    expect(needsPlanApproval(settings, 2, 8)).toBe(false)
    expect(needsPlanApproval(settings, 3, 12)).toBe(false)
    expect(needsPlanApproval(settings, 4, 8)).toBe(true)
    expect(needsPlanApproval(settings, 2, 13)).toBe(true)
    const ask = normalizeBuildSettings({ planApproval: 'ask' })
    expect(needsPlanApproval(ask, 1, 1)).toBe(true)
  })
})
