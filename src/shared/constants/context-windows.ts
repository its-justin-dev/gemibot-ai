/**
 * Per-model context limits and the compaction defaults in one place.
 *
 * The app already caps a single request at `MAX_REQUEST_TOKENS`; a model's effective request
 * budget is the smaller of that cap and its real input window. Unknown models fall back to a
 * conservative 128k window instead of guessing.
 */

export const MAX_REQUEST_TOKENS = 168_000
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Ordered: the first matching entry wins, so media/embedding patterns precede `gemini`. */
const CONTEXT_WINDOW_RULES: Array<[RegExp, number]> = [
  [/embedding/i, 2_048],
  [/^gemma/i, 131_072],
  [/image|banana|veo|lyria|tts|transcribe|omni|live|computer-use|robotics/i, 32_768],
  [/^deep-research/i, 1_048_576],
  [/^antigravity/i, DEFAULT_CONTEXT_WINDOW],
  [/^gemini/i, 1_048_576]
]

export function modelContextWindow(model: string): number {
  const id = String(model ?? '')
    .trim()
    .toLowerCase()
  for (const [pattern, limit] of CONTEXT_WINDOW_RULES) {
    if (pattern.test(id)) return limit
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** The ceiling this app is willing to send to the model in one request. */
export function requestTokenBudget(model: string): number {
  return Math.min(modelContextWindow(model), MAX_REQUEST_TOKENS)
}

export const COMPACTION_DEFAULTS = {
  enabled: true,
  thresholdPercent: 80,
  targetPercent: 40,
  recentMessages: 10,
  summarizerModel: 'gemini-3.1-flash-lite'
} as const

export const COMPACTION_THRESHOLD_MIN = 50
export const COMPACTION_THRESHOLD_MAX = 95
export const COMPACTION_RECENT_MIN = 2
export const COMPACTION_RECENT_MAX = 50

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return COMPACTION_DEFAULTS.thresholdPercent
  return Math.max(COMPACTION_THRESHOLD_MIN, Math.min(COMPACTION_THRESHOLD_MAX, Math.round(value)))
}

export function clampRecentMessages(value: number): number {
  if (!Number.isFinite(value)) return COMPACTION_DEFAULTS.recentMessages
  return Math.max(COMPACTION_RECENT_MIN, Math.min(COMPACTION_RECENT_MAX, Math.round(value)))
}

/** Step A keeps this much of an old tool output, plus a tail, before marking it trimmed. */
export const OLD_OUTPUT_HEAD_CHARS = 1_200
export const OLD_OUTPUT_TAIL_CHARS = 400
export const OLD_OUTPUT_TRIM_FROM = 2_000
export const DUPLICATE_OUTPUT_MIN_CHARS = 200

/** The summary request itself is capped so it fits even the smallest chat model. */
export const SUMMARY_TRANSCRIPT_MAX_CHARS = 100_000
export const SUMMARY_ENTRY_MAX_CHARS = 4_000
export const SUMMARY_TOOL_MAX_CHARS = 1_500
export const SUMMARY_MAX_OUTPUT_TOKENS = 2_048
