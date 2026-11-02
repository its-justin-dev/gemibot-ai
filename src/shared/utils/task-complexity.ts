import type { TaskComplexity } from '../types/behavior-settings'
import { MAX_BEHAVIOR_STEPS } from './behavior-settings'

export interface TaskAssessment {
  level: TaskComplexity
  score: number
  reasons: string[]
}

const SIMPLE_OPENERS =
  /^(?:what|why|how|who|where|when|which|is|are|can|could|does|do|did|should|would|will|explain|tell me|show me|hello|hi|hey|thanks|thank you|salamat|kamusta)\b/iu

const MULTI_STEP = [
  'and also',
  'after that',
  'as well as',
  'then',
  'additionally',
  'separately',
  'meanwhile',
  'multiple files',
  'several files',
  'across the',
  'each file',
  'all files',
  'whole project',
  'entire project'
]

const ACTION_VERBS = [
  'add',
  'build',
  'change',
  'create',
  'debug',
  'delete',
  'fix',
  'implement',
  'improve',
  'integrate',
  'migrate',
  'move',
  'refactor',
  'remove',
  'rename',
  'replace',
  'rewrite',
  'test',
  'update',
  'upgrade',
  'verify'
]

const TECHNICAL_TERMS = [
  'api',
  'auth',
  'build',
  'component',
  'config',
  'database',
  'dependency',
  'export',
  'import',
  'migration',
  'module',
  'navigation',
  'page',
  'route',
  'schema',
  'service',
  'settings',
  'test',
  'type',
  'ui'
]

function countMatches(text: string, words: string[]): number {
  return words.reduce((count, word) => (text.includes(word) ? count + 1 : count), 0)
}

/**
 * A deliberately cheap reading of the request. It never calls a model; the only cost of a wrong
 * "complex" verdict is one extra verification pass, so the threshold is tuned to catch multi-file
 * work without turning every question into deep mode.
 */
export function assessTaskComplexity(text: string): TaskAssessment {
  const raw = text.trim()
  const lower = raw.toLowerCase()
  const reasons: string[] = []
  let score = 0

  const fileMentions = (raw.match(/\b[\w.-]+\.(?:[a-z]{1,6})\b/giu) ?? []).length
  const pathMentions = (raw.match(/[/\\][\w./\\-]+/gu) ?? []).length
  const questions = (raw.match(/[?!]/gu) ?? []).length
  const sentenceCount = raw.split(/[.!?]+/u).filter((part) => part.trim() !== '').length
  const lineItems = raw.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/u.test(line)).length

  if (raw.length <= 40 && fileMentions === 0) {
    return { level: 'simple', score: 0, reasons: ['short request'] }
  }
  if (raw.length < 180 && SIMPLE_OPENERS.test(raw) && fileMentions <= 1 && questions <= 1) {
    return { level: 'simple', score: 0, reasons: ['single question'] }
  }

  if (raw.length > 1_200) {
    score += 3
    reasons.push('long request')
  } else if (raw.length > 500) {
    score += 2
    reasons.push('detailed request')
  } else if (raw.length > 220) {
    score += 1
  }

  if (sentenceCount >= 7) score += 2
  else if (sentenceCount >= 4) score += 1
  if (lineItems >= 3) {
    score += 1
    reasons.push('checklist')
  }

  const connectors = countMatches(lower, MULTI_STEP)
  if (connectors > 0) {
    score += Math.min(2, connectors)
    reasons.push('multiple steps')
  }

  const actions = ACTION_VERBS.filter((verb) => new RegExp(`\\b${verb}\\b`, 'u').test(lower)).length
  if (actions >= 4) {
    score += 2
    reasons.push('many kinds of change')
  } else if (actions >= 2) {
    score += 1
  }

  if (fileMentions >= 2 || pathMentions >= 2) {
    score += 2
    reasons.push('several files')
  } else if (fileMentions === 1 || pathMentions === 1) {
    score += 1
  }

  const technical = TECHNICAL_TERMS.filter((term) =>
    new RegExp(`\\b${term}\\b`, 'u').test(lower)
  ).length
  if (technical >= 3) {
    score += 2
    reasons.push('cross-cutting changes')
  } else if (technical >= 1) {
    score += 1
  }

  if (/\b(?:refactor|migrat(?:e|ion)|architecture|rewrite|redesign)\b/u.test(lower)) {
    score += 1
    reasons.push('structural change')
  }

  const level: TaskComplexity = score >= 4 ? 'complex' : score >= 2 ? 'medium' : 'simple'
  return { level, score, reasons: reasons.length > 0 ? reasons : ['routine request'] }
}

/** Complex work gets room to verify; simple work keeps the user's base budget. */
export function stepBudgetFor(
  level: TaskComplexity,
  maxSteps: number,
  deepActive: boolean
): number {
  if (level === 'complex' && deepActive) {
    return Math.min(MAX_BEHAVIOR_STEPS, maxSteps + Math.min(20, maxSteps))
  }
  return Math.min(MAX_BEHAVIOR_STEPS, Math.max(1, maxSteps))
}
