import { pySlice } from '../../shared/utils/pystr'
import type { Content, Part } from '../models/content'

/**
 * Keeps the prompt inside a model-independent budget without touching the stored history.
 *
 * The full conversation stays in SQLite; only the copy handed to one request is shortened. Old
 * tool outputs are elided by `compactHistory()` first, and if the rest still does not fit, the
 * oldest whole turns are replaced by an extractive digest. Nothing is ever deleted from the
 * transcript itself.
 */

/** Roughly four characters per token, the usual English/code average for Gemini prompts. */
const CHARS_PER_TOKEN = 4

/** A 200k-input request keeps room for this much reply, thinking included. */
export const PROMPT_TOKEN_BUDGET = 168_000

const SUMMARY_MAX_CHARS = 6_000
const SUMMARY_LINE_CHARS = 240
const SUMMARY_MAX_LINES = 60

export interface HistoryPlan {
  contents: Content[]
  summary: string | null
  omitted: number
  estimatedTokens: number
}

function jsonChars(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function partChars(part: Part): number {
  let chars = 0
  if (part.text) chars += part.text.length
  if (part.function_call) chars += jsonChars(part.function_call)
  if (part.function_response) chars += jsonChars(part.function_response)
  if (part.inline_data?.data) chars += part.inline_data.data.length
  if (part.file_data) chars += jsonChars(part.file_data)
  if (part.executable_code) chars += jsonChars(part.executable_code)
  if (part.code_execution_result) chars += jsonChars(part.code_execution_result)
  return chars
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateContentTokens(content: Content): number {
  let chars = 0
  for (const part of content.parts ?? []) chars += partChars(part)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function estimateContentsTokens(contents: readonly Content[]): number {
  let tokens = 0
  for (const content of contents) tokens += estimateContentTokens(content)
  return tokens
}

/** A real user request, not the function-response entries that also carry `role: 'user'`. */
export function isRequestBoundary(content: Content): boolean {
  if (content.role !== 'user') return false
  return (content.parts ?? []).some(
    (part) => typeof part.text === 'string' && part.text.length > 0 && !part.function_response
  )
}

function findBoundary(contents: readonly Content[], from: number): number {
  for (let index = from; index < contents.length; index++) {
    if (isRequestBoundary(contents[index])) return index
  }
  return -1
}

function findLastBoundary(contents: readonly Content[], from: number): number {
  for (let index = Math.min(from, contents.length - 1); index >= 0; index--) {
    if (isRequestBoundary(contents[index])) return index
  }
  return -1
}

function oneLine(text: string, limit = SUMMARY_LINE_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${pySlice(clean, 0, limit)}...` : clean
}

/** Strips the per-turn memory framing so the digest reads as the user's own words. */
export function cleanUserRequest(text: string): string {
  let clean = text
  const requestAt = clean.indexOf('User Request:\n')
  if (requestAt >= 0) clean = clean.slice(requestAt + 'User Request:\n'.length)
  // Sessions stored before the memory migration still carry the old file-based note.
  const lastNote = '\n\nNote (Required to do last): Log this interaction in /memory/memory.md.'
  const lastAt = clean.indexOf(lastNote)
  if (lastAt >= 0) clean = clean.slice(0, lastAt)
  const refAt = clean.indexOf('\n\nReferenced files:\n')
  if (refAt >= 0) clean = clean.slice(0, refAt)
  return oneLine(clean)
}

function textOf(content: Content): string {
  const parts = content.parts ?? []
  for (const part of parts) {
    if (part.text && !part.thought) return part.text
  }
  return ''
}

function toolCallNames(content: Content): string[] {
  const names: string[] = []
  for (const part of content.parts ?? []) {
    const name = part.function_call?.name
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

function toolResponseNames(content: Content): string[] {
  const names: string[] = []
  for (const part of content.parts ?? []) {
    const name = part.function_response?.name
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

export function summarizeContents(contents: readonly Content[]): string {
  const lines: string[] = []
  for (const content of contents) {
    const role = content.role ?? ''
    if (role === 'user') {
      const text = textOf(content)
      if (text && !content.parts?.some((part) => part.function_response)) {
        const request = cleanUserRequest(text)
        if (request) lines.push(`User: ${request}`)
        continue
      }
      const responses = toolResponseNames(content)
      if (responses.length > 0) lines.push(`Tool results: ${[...new Set(responses)].join(', ')}`)
      continue
    }
    if (role === 'model' || role === 'assistant') {
      const text = textOf(content)
      if (text) lines.push(`Assistant: ${oneLine(text)}`)
      const calls = toolCallNames(content)
      if (calls.length > 0) lines.push(`Tools used: ${[...new Set(calls)].join(', ')}`)
    }
  }

  if (lines.length === 0) return 'Earlier conversation omitted because of the prompt size limit.'

  const kept: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (kept.length >= SUMMARY_MAX_LINES) break
    if (size + line.length + 1 > SUMMARY_MAX_CHARS && kept.length > 0) break
    kept.unshift(line)
    size += line.length + 1
  }
  return kept.join('\n')
}

/**
 * Returns the tail that fits plus the digest of everything before it. The cut always lands on a
 * user request so a tool call and its result never end up on opposite sides of the boundary.
 */
export function planHistory(
  contents: readonly Content[],
  budgetTokens: number = PROMPT_TOKEN_BUDGET
): HistoryPlan {
  const total = estimateContentsTokens(contents)
  const budget = Math.max(4_000, budgetTokens)
  if (total <= budget || contents.length === 0) {
    return { contents: contents as Content[], summary: null, omitted: 0, estimatedTokens: total }
  }

  let start = contents.length
  let tokens = 0
  for (let index = contents.length - 1; index >= 0; index--) {
    const contentTokens = estimateContentTokens(contents[index])
    if (tokens + contentTokens > budget && start < contents.length) break
    tokens += contentTokens
    start = index
  }

  let boundary = findBoundary(contents, start)
  if (boundary === -1) {
    // The fit landed inside a turn with no later user request.  Walk back to the turn that owns
    // it; starting on a model/tool entry makes every candidate reject the request.
    boundary = findLastBoundary(contents, start - 1)
  }
  if (boundary === -1) {
    // No user request anywhere: no valid slice exists, so keep the v1.0 fallback of sending it all.
    return { contents: contents as Content[], summary: null, omitted: 0, estimatedTokens: total }
  }
  start = boundary
  tokens = estimateContentsTokens(contents.slice(start))
  if (start <= 0) {
    return { contents: contents as Content[], summary: null, omitted: 0, estimatedTokens: total }
  }

  return {
    contents: contents.slice(start),
    summary: summarizeContents(contents.slice(0, start)),
    omitted: start,
    estimatedTokens: tokens
  }
}

/** The instruction that reintroduces the digest on a request whose older turns were omitted. */
export function summaryInstruction(summary: string): string {
  return (
    'Summary of the earlier conversation (automatically summarized because the full transcript ' +
    `is too large for one request; the original messages are still stored locally):\n${summary}`
  )
}

/** The persisted compaction summary is model-independent and survives restarts. */
export function historySummaryInstruction(summary: string): string {
  return `Summary of the earlier conversation:\n${summary}`
}
