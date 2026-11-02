export type ResponseStyle = 'concise' | 'balanced' | 'thorough'

export type TaskComplexity = 'simple' | 'medium' | 'complex'

/**
 * Behavior knobs that shape the prompt and the agent loop. They are separate from `TokenSettings`
 * because these change how much work the agent does, not how much context it uploads.
 */
export interface BehaviorSettings {
  /** How much detail the final answer should carry. */
  responseStyle: ResponseStyle
  /** Let complex requests plan, verify and route to a stronger configuration. */
  deepMode: boolean
  /** Tool/model steps allowed in one task. */
  maxSteps: number
  /** Stream assistant text to the GUI as the provider produces it. */
  streamResponses: boolean
}

export const DEFAULT_BEHAVIOR_SETTINGS: BehaviorSettings = {
  responseStyle: 'balanced',
  deepMode: true,
  maxSteps: 40,
  streamResponses: true
}
