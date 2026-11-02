/**
 * Runtime token-efficiency switches. Every field has a conservative default; a value of 0 on a
 * size limit means "no app-level cap" and restores the v1 behavior for that knob.
 */
export interface TokenSettings {
  /** Characters of the memory feed allowed inside the system prompt. */
  maxMemoryChars: number
  /** Prefer the most relevant memory sections instead of the oldest lines. */
  memoryRelevance: boolean
  /** Send short tool descriptions instead of the full documentation blocks. */
  slimTools: boolean
  /** Characters of one tool result kept in the model history. */
  maxToolOutputChars: number
  /** Answer a repeated read-only tool call with a short note while its output is still present. */
  reuseReadResults: boolean
  /** Stop a tool loop that repeats the same call and arguments. */
  loopGuard: boolean
  /** Per-request output ceiling; 0 keeps the provider default. */
  maxOutputTokens: number
  /** Model used for titles, classification and other small jobs. */
  cheapModel: string
}
