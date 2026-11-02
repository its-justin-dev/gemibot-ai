import type { ThinkingConfig } from '@google/genai'
import { EffortLevel } from '../../shared/models/effort-level'
import { pyStrip } from '../../shared/utils/pystr'

export class EffortMapper {
  static readonly NON_THINKING_PREFIXES = [
    'text-embedding',
    'gemini-embedding',
    'embedding',
    'imagen',
    'veo',
    'lyria',
    'nano-banana',
    'gemma',
    // The Antigravity agents are driven through the Interactions API with no request config at
    // all (agent-generate.service.ts:161), so a budget here could only ever be a lie told by the
    // model badge and the effort row of the picker.
    'antigravity'
  ]

  static readonly NON_THINKING_SUBSTRINGS = [
    'embedding',
    'tts',
    'transcribe',
    'image',
    'clip',
    'video',
    'audio-dialog'
  ]

  static supportsThinking(modelId: unknown): boolean {
    if (!modelId) return false
    const mid = pyStrip(String(modelId).toLowerCase()).replaceAll('models/', '')

    for (const prefix of EffortMapper.NON_THINKING_PREFIXES) {
      if (mid.startsWith(prefix)) return false
    }
    for (const substr of EffortMapper.NON_THINKING_SUBSTRINGS) {
      if (mid.includes(substr)) return false
    }

    if (['gemini-2', 'gemini-3', 'gemini-4', 'thinking'].some((key) => mid.includes(key)))
      return true

    return mid.startsWith('gemini-')
  }

  static getThinkingConfig(
    modelId: unknown,
    effortLevel: unknown = EffortLevel.MEDIUM,
    includeThoughts = false,
    disableThinking = false
  ): ThinkingConfig | null {
    if (disableThinking) return null
    if (!EffortMapper.supportsThinking(modelId)) return null

    const level = EffortLevel.fromString(effortLevel)

    if (level.equals(EffortLevel.TURBO)) return null

    let budget = 2048
    if (level.equals(EffortLevel.SAVING)) budget = 128
    else if (level.equals(EffortLevel.LOW)) budget = 512
    else if (level.equals(EffortLevel.MEDIUM)) budget = 2048
    else if (level.equals(EffortLevel.HIGH)) budget = 8192
    else if (level.equals(EffortLevel.EXTRA_HIGH)) budget = 16384

    return { thinkingBudget: budget, includeThoughts }
  }

  static getStatusDescription(modelId: unknown, effortLevel: unknown): string {
    if (!EffortMapper.supportsThinking(modelId)) {
      return 'Thinking effort is not applicable to this model (standard direct generation).'
    }
    const level = EffortLevel.fromString(effortLevel)
    return `${level.icon} ${level.displayName} Effort: ${level.description} (${level.costHint})`
  }
}
