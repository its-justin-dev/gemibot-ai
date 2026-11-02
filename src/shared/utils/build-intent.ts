import type { TaskComplexity } from '../types/behavior-settings'
import type { BuildModeSetting } from '../types/build'

export interface BuildIntentContext {
  mode: BuildModeSetting
  complexity?: TaskComplexity | null
  /** A paused build exists for this conversation or project. */
  hasPausedBuild?: boolean
  /** A build is already running; a new prompt is feedback/queue rather than a new build. */
  hasActiveBuild?: boolean
}

export interface BuildIntentDecision {
  useBuild: boolean
  reason: string
  continuation: boolean
}

const CREATE_VERB =
  /\b(?:build|create|make|develop|implement|scaffold|generate|design|bootstrap|set\s*up|spin\s*up|start)\b/iu

const SYSTEM_NOUN =
  /\b(?:app|application|website|web\s*site|web\s*app|api|rest\s*api|backend|back\s*end|front\s*end|full[\s-]*stack|service|system|platform|dashboard|inventory|store|shop|e[\s-]*commerce|blog|game|clone|portal|crm|saas|tracker|manager|management|marketplace|chat\s*app|todo|to-do|database|schema|crud)\b/iu

const LARGE_SIGNAL =
  /\b(?:from\s+scratch|end[\s-]*to[\s-]*end|entire|complete|full|production|multi[\s-]*page|multiple\s+(?:features|pages|screens|endpoints)|all\s+(?:features|pages)|with\s+(?:login|auth|authentication|dashboard|payments?|crud|admin)|new\s+project|greenfield)\b/iu

const QUESTION_ONLY =
  /^(?:what|why|how|who|where|when|which|is|are|can|could|does|do|did|should|would|will|explain|tell\s+me|show\s+me|hello|hi|hey|thanks|thank\s+you)\b/iu

const EDIT_ONLY =
  /\b(?:fix|repair|debug|rename|typo|update\s+the|change\s+the|refactor|optimi[sz]e|clean\s*up|remove\s+the|explain)\b/iu

const CONTINUE =
  /^(?:continue|resume|keep\s+going|carry\s+on|go\s+on|finish\s+(?:it|the\s+build)|proceed)\b/iu

function countFeatureHints(text: string): number {
  const lines = text.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/u.test(line)).length
  const connectors = (text.match(/\b(?:and|with|plus)\b/giu) ?? []).length
  return lines + Math.min(3, Math.floor(connectors / 2))
}

/**
 * Decide whether a prompt is a whole-system/large-feature request. This is deliberately
 * conservative: Build mode is expensive, so ambiguous edit requests stay in the normal loop.
 */
export function decideBuildIntent(
  text: string,
  context: BuildIntentContext
): BuildIntentDecision {
  const raw = text.trim()
  const lower = raw.toLowerCase()
  if (raw === '' || raw.startsWith('/') || raw.startsWith('!')) {
    return { useBuild: false, reason: 'not a build prompt', continuation: false }
  }

  const continuation = CONTINUE.test(lower) && context.hasPausedBuild === true
  if (continuation && context.mode !== 'off') {
    return { useBuild: true, reason: 'resume paused build', continuation: true }
  }
  if (context.mode === 'off') {
    return { useBuild: false, reason: 'Build mode is off', continuation: false }
  }
  if (context.hasActiveBuild === true) {
    return { useBuild: false, reason: 'build already running', continuation: false }
  }
  if (QUESTION_ONLY.test(lower) || raw.length < 24) {
    return { useBuild: false, reason: 'question or short request', continuation: false }
  }

  const creates = CREATE_VERB.test(lower)
  const systemNoun = SYSTEM_NOUN.test(lower)
  const large = LARGE_SIGNAL.test(lower)
  const editOnly = EDIT_ONLY.test(lower) && !creates && !systemNoun
  const featureHints = countFeatureHints(raw)
  const complexity = context.complexity ?? 'simple'

  if (context.mode === 'on') {
    if (editOnly) return { useBuild: false, reason: 'edit request', continuation: false }
    if (creates || systemNoun || large || complexity !== 'simple' || featureHints >= 2) {
      return { useBuild: true, reason: 'Build mode forced on', continuation: false }
    }
    return { useBuild: false, reason: 'no system-scale work detected', continuation: false }
  }

  if (editOnly) return { useBuild: false, reason: 'targeted edit request', continuation: false }
  if (!creates) return { useBuild: false, reason: 'no creation intent', continuation: false }

  const systemScale = systemNoun || large || (featureHints >= 2 && raw.length > 120)
  if (!systemScale) {
    return { useBuild: false, reason: 'single-file or unclear scope', continuation: false }
  }
  if (complexity !== 'simple' || systemNoun || large) {
    return { useBuild: true, reason: 'new system or large feature', continuation: false }
  }
  return { useBuild: false, reason: 'small request', continuation: false }
}

/** True when the prompt asks to change an existing plan/build rather than start a new one. */
export function isBuildFeedback(text: string): boolean {
  const lower = text.trim().toLowerCase()
  if (lower === '') return false
  return /^(?:change|revise|update|edit|instead|use|add|remove|drop|keep|approve|yes,? approve|looks good|start (?:building|coding))\b/iu.test(
    lower
  )
}

export function isPlanApproval(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/[.!]$/u, '')
  return ['approve', 'approved', 'yes', 'yes approve', 'looks good', 'start', 'start building', 'go', 'proceed', 'ok', 'okay'].includes(
    lower
  )
}
