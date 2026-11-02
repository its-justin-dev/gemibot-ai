import type { BehaviorSettings, ResponseStyle } from '../types/behavior-settings'
import { DEFAULT_BEHAVIOR_SETTINGS } from '../types/behavior-settings'

export const RESPONSE_STYLES: ResponseStyle[] = ['concise', 'balanced', 'thorough']

export const MIN_BEHAVIOR_STEPS = 10
export const MAX_BEHAVIOR_STEPS = 200

function styleValue(value: unknown, fallback: ResponseStyle): ResponseStyle {
  if (typeof value !== 'string') return fallback
  const clean = value.trim().toLowerCase()
  if (clean === 'short') return 'concise'
  if (clean === 'normal' || clean === 'default') return 'balanced'
  if (clean === 'detailed' || clean === 'deep') return 'thorough'
  return RESPONSE_STYLES.find((style) => style === clean) ?? fallback
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(clean)) return true
    if (['0', 'false', 'off', 'no'].includes(clean)) return false
  }
  return fallback
}

export function stepsValue(value: unknown, fallback = DEFAULT_BEHAVIOR_SETTINGS.maxSteps): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(MIN_BEHAVIOR_STEPS, Math.min(MAX_BEHAVIOR_STEPS, Math.round(number)))
}

export function normalizeBehaviorSettings(value: Partial<BehaviorSettings> = {}): BehaviorSettings {
  return {
    responseStyle: styleValue(value.responseStyle, DEFAULT_BEHAVIOR_SETTINGS.responseStyle),
    deepMode: boolValue(value.deepMode, DEFAULT_BEHAVIOR_SETTINGS.deepMode),
    maxSteps: stepsValue(value.maxSteps, DEFAULT_BEHAVIOR_SETTINGS.maxSteps),
    streamResponses: boolValue(value.streamResponses, DEFAULT_BEHAVIOR_SETTINGS.streamResponses)
  }
}

/** Reads the persisted behavior keys; missing keys keep the safe defaults. */
export function behaviorSettingsFromDict(settings: Record<string, string>): BehaviorSettings {
  return {
    responseStyle: styleValue(settings['response_style'], DEFAULT_BEHAVIOR_SETTINGS.responseStyle),
    deepMode: boolValue(settings['deep_mode'], DEFAULT_BEHAVIOR_SETTINGS.deepMode),
    maxSteps: stepsValue(settings['max_steps']),
    streamResponses: boolValue(
      settings['stream_responses'],
      DEFAULT_BEHAVIOR_SETTINGS.streamResponses
    )
  }
}

export function behaviorSettingsToDict(settings: BehaviorSettings): Record<string, string> {
  return {
    response_style: settings.responseStyle,
    deep_mode: settings.deepMode ? 'true' : 'false',
    max_steps: String(settings.maxSteps),
    stream_responses: settings.streamResponses ? 'true' : 'false'
  }
}
