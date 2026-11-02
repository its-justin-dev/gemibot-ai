import type { GenerateContentConfig } from '@google/genai'
import { AppConstants } from '../../shared/constants/app-constants'
import {
  DUPLICATE_OUTPUT_MIN_CHARS,
  COMPACTION_DEFAULTS,
  OLD_OUTPUT_HEAD_CHARS,
  OLD_OUTPUT_TAIL_CHARS,
  OLD_OUTPUT_TRIM_FROM,
  SUMMARY_ENTRY_MAX_CHARS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_TOOL_MAX_CHARS,
  SUMMARY_TRANSCRIPT_MAX_CHARS,
  clampPercent,
  clampRecentMessages,
  modelContextWindow,
  requestTokenBudget
} from '../../shared/constants/context-windows'
import type {
  CompactionResult,
  CompactionSettings,
  CompactionStartInfo,
  CompactionTrigger,
  ContextUsage
} from '../../shared/types/compaction'
import { KeyboardInterrupt, errorMessage } from '../../shared/utils/exceptions'
import { pySlice, pyStrip } from '../../shared/utils/pystr'
import { pyTime } from '../../shared/utils/pytime'
import type { AgentState } from '../models/agent-state'
import type { Content, Part } from '../models/content'
import { sleep } from '../utils/console-out'
import type { AiClient } from './ai-client.service'
import {
  estimateContentTokens,
  estimateContentsTokens,
  estimateTextTokens,
  planHistory
} from './conversation-history.service'
import { compactHistory } from './agent-generate.service'
import { isRequestBoundary } from './conversation-history.service'
import { estimateRequestBreakdown } from './token-usage.service'
import type { AgentSystem } from './agent-system.service'
import type { CompactionRow } from './conversation-repository.service'
import type { CompactionSaveInput } from '../../shared/types/compaction'

export interface CompactionStore {
  saveCompaction(input: CompactionSaveInput): CompactionRow | null
  latestCompaction(): CompactionRow | null
  listCompactions(): CompactionRow[]
}

export interface CompactionCallbacks {
  onStart?: (info: CompactionStartInfo) => void
  onFinish?: (result: CompactionResult) => void
  onNotice?: (text: string, isError: boolean) => void
}

export interface CompactorDeps {
  state: AgentState
  client: AiClient
  system: AgentSystem
  settings: () => CompactionSettings
  store: () => CompactionStore | null
  callbacks: CompactionCallbacks
}

export interface RequestView {
  contents: Content[]
  digest: string | null
  overhead: number
  tokens: number
  budget: number
}

const SUMMARY_SYSTEM_PROMPT =
  'You compress a long coding conversation into a precise handoff summary. ' +
  'You never invent facts and you never include API keys, tokens, passwords or other secrets.'

function outputText(part: Part): string | null {
  const response = part.function_response?.response
  if (response === undefined || response === null) return null
  const output = response['output']
  return typeof output === 'string' ? output : null
}

function shrinkOutput(output: string): string {
  if (output.length <= OLD_OUTPUT_TRIM_FROM) return output
  return (
    pySlice(output, 0, OLD_OUTPUT_HEAD_CHARS) +
    '\n... [output trimmed] ...\n' +
    pySlice(output, -OLD_OUTPUT_TAIL_CHARS)
  )
}

/**
 * Step A, part one: shorten only the copy of old tool results handed to the model. The stored
 * transcript keeps the full text, and tool calls stay next to their results.
 */
export function trimOldToolOutputs(contents: readonly Content[], olderThan: number): Content[] {
  if (olderThan <= 0) return contents as Content[]
  return contents.map((content, index) => {
    if (index >= olderThan) return content
    if (!content.parts?.some((part) => part.function_response)) return content
    return {
      ...content,
      parts: content.parts.map((part) => {
        const output = outputText(part)
        if (output === null || output.length <= OLD_OUTPUT_TRIM_FROM) return part
        const response = part.function_response as NonNullable<Part['function_response']>
        return {
          ...part,
          function_response: {
            ...response,
            response: { ...(response.response ?? {}), output: shrinkOutput(output) }
          }
        }
      })
    }
  })
}

/** Step A, part two: the same old read shown twice is one copy in the request. */
export function dedupeOldToolOutputs(contents: readonly Content[], olderThan: number): Content[] {
  if (olderThan <= 0) return contents as Content[]
  const seen = new Map<string, string>()
  return contents.map((content, index) => {
    if (index >= olderThan) return content
    if (!content.parts?.some((part) => part.function_response)) return content
    return {
      ...content,
      parts: content.parts.map((part) => {
        const output = outputText(part)
        if (output === null || output.length < DUPLICATE_OUTPUT_MIN_CHARS) return part
        const first = seen.get(output)
        if (first === undefined) {
          seen.set(output, part.function_response?.name ?? 'tool')
          return part
        }
        const response = part.function_response as NonNullable<Part['function_response']>
        return {
          ...part,
          function_response: {
            ...response,
            response: {
              ...(response.response ?? {}),
              output: `[duplicate output removed: identical to an earlier ${first} result]`
            }
          }
        }
      })
    }
  })
}

/** Index of the first user request in the last `recentMessages` requests, or 0. */
export function recentBoundaryIndex(contents: readonly Content[], recentMessages: number): number {
  const boundaries: number[] = []
  for (let index = 0; index < contents.length; index++) {
    if (isRequestBoundary(contents[index])) boundaries.push(index)
  }
  if (boundaries.length === 0) return 0
  const at = Math.max(0, boundaries.length - Math.max(1, recentMessages))
  return boundaries[at]
}

/**
 * Step B's split. It always lands on a real user request, so a tool call and its result never
 * cross the boundary, and it never moves backwards past the previous split.
 */
export function planCompactionSplit(
  contents: readonly Content[],
  from: number,
  recentMessages: number,
  targetTokens: number,
  overheadTokens: number
): number | null {
  const start = Math.max(0, Math.min(from, contents.length))
  const boundaries: number[] = []
  for (let index = start; index < contents.length; index++) {
    if (isRequestBoundary(contents[index])) boundaries.push(index)
  }
  if (boundaries.length < 2) return null
  const latest = boundaries[boundaries.length - 1]
  let cursor = Math.max(0, boundaries.length - Math.max(1, recentMessages))
  let split = boundaries[cursor]
  if (split <= start) {
    cursor += 1
    if (cursor >= boundaries.length) return null
    split = boundaries[cursor]
  }
  // Keeping the newest N turns may still be over target; summarize further turns until the kept
  // side fits or only the latest request remains.
  while (
    split < latest &&
    overheadTokens + estimateContentsTokens(contents.slice(split)) > targetTokens
  ) {
    cursor += 1
    if (cursor >= boundaries.length) break
    split = boundaries[cursor]
  }
  return split > start ? split : null
}

function userTextForSummary(text: string): string {
  let clean = text
  const requestAt = clean.indexOf('User Request:\n')
  if (requestAt >= 0) clean = clean.slice(requestAt + 'User Request:\n'.length)
  const refAt = clean.indexOf('\n\nReferenced files:\n')
  if (refAt >= 0) clean = clean.slice(0, refAt)
  const noteAt = clean.indexOf('\n\nNote (Required to do last):')
  if (noteAt >= 0) clean = clean.slice(0, noteAt)
  return pyStrip(clean)
}

function clipText(text: string, limit: number): string {
  const clean = pyStrip(text)
  if (clean.length <= limit) return clean
  return `${pySlice(clean, 0, limit)}\n[... truncated for the summary request ...]`
}

function partSummary(part: Part): string | null {
  if (part.function_call) {
    const name = part.function_call.name ?? 'tool'
    let args: string
    try {
      args = JSON.stringify(part.function_call.args ?? {})
    } catch {
      args = ''
    }
    return `Tool call ${name}(${clipText(args, SUMMARY_TOOL_MAX_CHARS)})`
  }
  if (part.function_response) {
    const name = part.function_response.name ?? 'tool'
    const output = outputText(part)
    return `Tool result ${name}: ${clipText(output ?? '', SUMMARY_TOOL_MAX_CHARS)}`
  }
  if (part.text && !part.thought) return clipText(part.text, SUMMARY_ENTRY_MAX_CHARS)
  return null
}

/** A bounded transcript of the messages that are about to be replaced by the summary. */
export function buildSummaryTranscript(contents: readonly Content[]): string {
  let transcript = summaryEntries(contents).join('\n\n')
  if (transcript.length > SUMMARY_TRANSCRIPT_MAX_CHARS) {
    transcript =
      '[... earliest messages omitted from this summary batch; they are covered by the previous summary ...]\n\n' +
      pySlice(transcript, -SUMMARY_TRANSCRIPT_MAX_CHARS)
  }
  return transcript
}

/**
 * Splits a large region into ordered batches so nothing is dropped: each batch's summary is merged
 * into the previous one before the next batch is read.
 */
export function chunkSummaryTranscript(
  contents: readonly Content[],
  maxChars: number
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const entry of summaryEntries(contents)) {
    const candidate = current === '' ? entry : `${current}\n\n${entry}`
    if (current !== '' && candidate.length > maxChars) {
      chunks.push(current)
      current = entry
    } else {
      current = candidate
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function summaryEntries(contents: readonly Content[]): string[] {
  const entries: string[] = []
  for (const content of contents) {
    const role = content.role ?? ''
    const blocks: string[] = []
    for (const part of content.parts ?? []) {
      const text = partSummary(part)
      if (text !== null && text !== '') blocks.push(text)
    }
    if (blocks.length === 0) continue
    if (role === 'user') {
      const hasResponses = (content.parts ?? []).some((part) => part.function_response)
      if (hasResponses) entries.push(`Tool results:\n${blocks.join('\n')}`)
      else {
        const cleaned = userTextForSummary(blocks.join('\n'))
        if (cleaned !== '') entries.push(`User:\n${clipText(cleaned, SUMMARY_ENTRY_MAX_CHARS)}`)
      }
    } else if (role === 'model' || role === 'assistant') {
      entries.push(`Assistant:\n${blocks.join('\n')}`)
    }
  }
  return entries
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]'],
  [/sk-[0-9A-Za-z_-]{16,}/g, '[redacted-api-key]'],
  [/Bearer\s+[0-9A-Za-z._-]{12,}/gi, 'Bearer [redacted]'],
  [
    /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',}\]]{8,}/gi,
    '$1[redacted]'
  ]
]

export function redactSecrets(text: string): string {
  let clean = text
  for (const [pattern, replacement] of SECRET_PATTERNS) clean = clean.replace(pattern, replacement)
  return clean
}

export function buildSummaryPrompt(previousSummary: string | null, transcript: string): string {
  return (
    'You are the context compactor for GemiBot AI, a coding agent. Merge the previous summary and ' +
    'the new conversation messages into ONE updated handoff summary.\n\n' +
    'Return only the summary in Markdown with these sections:\n' +
    '## User Goal\n## Current Task\n## Decisions & Preferences\n' +
    '## Files (created / edited / deleted)\n## Commands & Results\n## Errors & Fixes\n' +
    '## Current State\n## Unfinished Tasks / Next Steps\n\n' +
    'Rules:\n' +
    '- Merge, do not stack: the previous summary plus the new messages become one current summary.\n' +
    '- Never invent files, commands, outputs or decisions.\n' +
    '- Keep exact file paths, command names, function names, values and numbers.\n' +
    '- Preserve user preferences and corrections, including ones from the previous summary.\n' +
    '- Say explicitly what is still unfinished and what the immediate next step is.\n' +
    '- Do not include API keys, tokens, passwords or any other secret.\n' +
    '- Do not mention this summarization request itself.\n' +
    '- Keep it under 1200 words.\n\n' +
    `Previous summary:\n${previousSummary?.trim() || '(none yet)'}\n\n` +
    `New messages:\n${transcript || '(none)'}`
  )
}

function chatCapable(model: string): boolean {
  const id = model.toLowerCase()
  if (id.startsWith('antigravity') || id.startsWith('deep-research')) return false
  return !/embedding|image|banana|veo|lyria|tts|transcribe|omni|live|computer-use|robotics/.test(id)
}

function isAuthFailure(text: string): boolean {
  return ['401', '403', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'API_KEY'].some((code) =>
    text.includes(code)
  )
}

/** Last resort: shorten copies of oversized parts so the request itself fits the window. */
export function hardTrimContents(contents: readonly Content[], budgetTokens: number): Content[] {
  const result = contents.map((content) => ({
    ...content,
    parts: (content.parts ?? []).map((part) => ({ ...part }))
  }))
  let tokens = estimateContentsTokens(result)
  if (tokens <= budgetTokens) return result

  for (let index = 0; index < result.length && tokens > budgetTokens; index++) {
    const content = result[index]
    content.parts = (content.parts ?? []).map((part) => {
      const output = outputText(part)
      if (output === null || output.length <= OLD_OUTPUT_HEAD_CHARS) return part
      const response = part.function_response as NonNullable<Part['function_response']>
      const shrunk =
        pySlice(output, 0, OLD_OUTPUT_HEAD_CHARS) +
        '\n... [trimmed to fit the model context window] ...\n' +
        pySlice(output, -OLD_OUTPUT_TAIL_CHARS)
      const shrunkPart: Part = {
        ...part,
        function_response: {
          ...response,
          response: { ...(response.response ?? {}), output: shrunk }
        }
      }
      tokens -=
        estimateContentTokens({ role: content.role, parts: [part] }) -
        estimateContentTokens({ role: content.role, parts: [shrunkPart] })
      return shrunkPart
    })
  }

  // The latest user message may itself be the oversized one. It is never dropped, only shortened.
  for (let index = result.length - 1; index >= 0 && tokens > budgetTokens; index--) {
    const parts = result[index].parts ?? []
    for (const part of parts) {
      if (typeof part.text !== 'string' || part.text.length < 4_000) continue
      const overChars = Math.max(4_000, (tokens - budgetTokens) * 4)
      const keep = Math.max(1_000, Math.floor((part.text.length - overChars) / 2))
      const shrunk =
        pySlice(part.text, 0, keep) +
        '\n... [message trimmed to fit the model context window] ...\n' +
        pySlice(part.text, -1_000)
      tokens -= estimateTextTokens(part.text) - estimateTextTokens(shrunk)
      part.text = shrunk
      if (tokens <= budgetTokens) break
    }
  }
  return result
}

function fitDigest(digest: string, maxTokens: number): string | null {
  const maxChars = Math.max(0, Math.round(maxTokens * 4))
  if (digest.length <= maxChars) return digest
  if (maxChars < 200) return null
  const marker = '[... earlier digest lines omitted ...]\n'
  return marker + pySlice(digest, -(maxChars - marker.length))
}

export class ConversationCompactor {
  private running: Promise<CompactionResult | null> | null = null
  private turnSerial = 0
  private failedSerial = -1
  private autoAttempts = 0
  private oversizeNotifiedSerial = -1

  constructor(private readonly deps: CompactorDeps) {}

  isRunning(): boolean {
    return this.running !== null
  }

  private get state(): AgentState {
    return this.deps.state
  }

  settings(): CompactionSettings {
    const raw = this.deps.settings()
    const model = AppConstants.resolveModelId(
      raw.summarizerModel || COMPACTION_DEFAULTS.summarizerModel
    )
    return {
      enabled: raw.enabled,
      thresholdPercent: clampPercent(raw.thresholdPercent),
      targetPercent: Math.max(10, Math.min(80, Math.round(raw.targetPercent))),
      recentMessages: clampRecentMessages(raw.recentMessages),
      summarizerModel: model
    }
  }

  private notify(text: string, isError = false): void {
    try {
      this.deps.callbacks.onNotice?.(text, isError)
    } catch {
      /* a UI callback must never break compaction */
    }
  }

  /**
   * The request view for one model: persisted summary comes from the system prompt, the split
   * drops everything the summary covers, old tool output is trimmed/deduped, and a transient
   * extractive digest handles anything still too large.
   */
  private buildView(model: string, pendingText?: string, notifyOversize = false): RequestView {
    const settings = this.settings()
    const budget = requestTokenBudget(model)
    // The transient digest is measured below with the view that produces it; counting the
    // previous step's digest here too would double-charge the same text.
    const overhead = this.deps.system.requestOverheadTokens(this.state, model, {
      requestDigest: null
    })
    const split = Math.max(0, Math.min(this.state.compactionSplitIndex, this.state.contents.length))
    let contents = this.state.contents.slice(split)
    // First-line savings: older tool results in the kept region only need their head and tail.
    contents = compactHistory(contents)
    const recent = recentBoundaryIndex(contents, settings.recentMessages)
    contents = trimOldToolOutputs(contents, recent)
    contents = dedupeOldToolOutputs(contents, recent)
    if (pendingText !== undefined && pyStrip(pendingText) !== '') {
      contents = [...contents, { role: 'user', parts: [{ text: pendingText }] }]
    }

    const contentBudget = Math.max(4_000, budget - overhead - 2_000)
    const plan = planHistory(contents, contentBudget)
    let view = plan.contents
    let digest = plan.summary
    let digestTokens = digest === null ? 0 : estimateTextTokens(digest)
    let tokens = overhead + estimateContentsTokens(view) + digestTokens
    if (tokens > budget) {
      view = hardTrimContents(view, Math.max(500, budget - overhead - digestTokens))
      tokens = overhead + estimateContentsTokens(view) + digestTokens
      if (notifyOversize && this.oversizeNotifiedSerial !== this.turnSerial) {
        this.oversizeNotifiedSerial = this.turnSerial
        this.notify(
          'A message was larger than the model context window, so the copy sent for this request was shortened. The stored message is unchanged.'
        )
      }
    }
    if (tokens > budget && digest !== null) {
      // The digest travels in the system prompt, so it has to be measured and, for a very small
      // window, shortened as well instead of silently pushing the request past the budget.
      digest = fitDigest(digest, Math.max(0, budget - overhead - estimateContentsTokens(view)))
      digestTokens = digest === null ? 0 : estimateTextTokens(digest)
      tokens = overhead + estimateContentsTokens(view) + digestTokens
    }
    return { contents: view, digest, overhead, tokens, budget }
  }

  /** Lets a caller stay synchronous when the next turn would not compact anyway. */
  shouldCompact(pendingText?: string): boolean {
    const settings = this.settings()
    if (!settings.enabled) return false
    return this.contextUsage(this.state.model, pendingText).percent >= settings.thresholdPercent
  }

  contextUsage(model: string, pendingText?: string): ContextUsage {
    const view = this.buildView(model, pendingText)
    const budget = Math.max(1, view.budget)
    return {
      usedTokens: view.tokens,
      budgetTokens: view.budget,
      limitTokens: modelContextWindow(model),
      percent: Math.max(0, Math.round((view.tokens / budget) * 100)),
      thresholdPercent: this.settings().thresholdPercent,
      model
    }
  }

  private beginTurn(): void {
    this.turnSerial += 1
    this.autoAttempts = 0
    this.state.requestDigest = null
  }

  /**
   * Called before a turn pushes its user message. Auto-compaction only runs here, i.e. between
   * turns, never while a response or a tool call is in flight.
   */
  async prepareBeforeTurn(pendingText?: string): Promise<CompactionResult | null> {
    this.beginTurn()
    const settings = this.settings()
    if (!settings.enabled) return null
    const usage = this.contextUsage(this.state.model, pendingText)
    if (usage.percent < settings.thresholdPercent) return null
    if (this.failedSerial === this.turnSerial) return null
    this.autoAttempts += 1
    return await this.compact('auto', { model: this.state.model, pendingText })
  }

  /**
   * A turn whose pre-send compaction (and therefore `beginTurn`) has already run. The attempt and
   * failure bookkeeping of that turn stays in place, so a failed auto-compaction is not retried
   * inside the very same turn.
   */
  resumePreparedTurn(): void {
    if (this.turnSerial === 0) this.beginTurn()
    this.state.requestDigest = null
  }

  /** Per-model preparation inside the ladder: a fallback with a smaller window may need more. */
  async prepareRequest(model: string): Promise<RequestView> {
    const settings = this.settings()
    const usage = this.contextUsage(model)
    if (
      settings.enabled &&
      usage.percent >= settings.thresholdPercent &&
      this.failedSerial !== this.turnSerial &&
      this.autoAttempts < 2
    ) {
      this.autoAttempts += 1
      await this.compact('auto', { model })
    }
    return this.buildView(model, undefined, true)
  }

  async compactNow(trigger: CompactionTrigger = 'manual'): Promise<CompactionResult | null> {
    return await this.compact(trigger, {})
  }

  private async compact(
    trigger: CompactionTrigger,
    options: { model?: string; pendingText?: string }
  ): Promise<CompactionResult | null> {
    if (this.running !== null) return await this.running
    const settings = this.settings()
    if (trigger === 'auto' && !settings.enabled) return null
    const task = this.runCompaction(trigger, options, settings)
    this.running = task
    try {
      return await task
    } finally {
      if (this.running === task) this.running = null
    }
  }

  private async runCompaction(
    trigger: CompactionTrigger,
    options: { model?: string; pendingText?: string },
    settings: CompactionSettings
  ): Promise<CompactionResult | null> {
    const model = options.model ?? this.state.model
    const budget = requestTokenBudget(model)
    const usage = this.contextUsage(model, options.pendingText)
    const start = pyTime()
    const base = this.state.contents
    const from = Math.max(0, Math.min(this.state.compactionSplitIndex, base.length))
    if (from >= base.length) {
      if (trigger === 'manual') {
        this.notify('Nothing older to compact yet. The latest request is always kept in full.')
      }
      return null
    }

    const overhead = this.deps.system.requestOverheadTokens(this.state, model, {
      requestDigest: null
    })
    const targetTokens = Math.max(4_000, Math.round((budget * settings.targetPercent) / 100))
    const split = planCompactionSplit(base, from, settings.recentMessages, targetTokens, overhead)
    if (split === null) {
      if (trigger === 'manual') {
        this.notify('Nothing older to compact yet. The latest request is always kept in full.')
      }
      return null
    }

    if (trigger === 'auto') {
      // Step A alone may already bring the request under the target; only summarize when needed.
      const recent = recentBoundaryIndex(base.slice(from), settings.recentMessages) + from
      const trimmed = dedupeOldToolOutputs(
        trimOldToolOutputs(base.slice(from), recent - from),
        recent - from
      )
      const afterStepA = overhead + estimateContentsTokens(trimmed)
      if (afterStepA <= targetTokens) return null
    }

    const key = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const beforePercent = Math.round((usage.usedTokens / Math.max(1, budget)) * 100)
    try {
      this.deps.callbacks.onStart?.({
        key,
        trigger,
        model: settings.summarizerModel,
        tokensBefore: usage.usedTokens,
        beforePercent,
        budgetTokens: budget,
        thresholdPercent: settings.thresholdPercent
      })
    } catch {
      /* a UI callback must never break compaction */
    }

    const oldRegion = base.slice(from, split)
    const batches = chunkSummaryTranscript(oldRegion, SUMMARY_TRANSCRIPT_MAX_CHARS)
    let modelUsed = settings.summarizerModel
    let summary = ''
    let failure: string | null = null

    try {
      if (batches.length <= 1) {
        const transcript = redactSecrets(batches[0] ?? '')
        const generated = await this.generateSummary(
          buildSummaryPrompt(this.state.historySummary, transcript),
          settings.summarizerModel
        )
        summary = redactSecrets(pyStrip(generated.text))
        modelUsed = generated.model
      } else {
        // An oversized region is summarized in order, each batch merging into the previous
        // summary, so the earliest messages are never silently cut off.
        let merged: string | null = this.state.historySummary
        for (const batch of batches) {
          const generated = await this.generateSummary(
            buildSummaryPrompt(merged, redactSecrets(batch)),
            settings.summarizerModel
          )
          merged = redactSecrets(pyStrip(generated.text))
          modelUsed = generated.model
          if (merged === '') throw new Error('The summarizer returned an empty summary.')
        }
        summary = merged ?? ''
      }
      if (summary === '') throw new Error('The summarizer returned an empty summary.')
    } catch (error) {
      failure =
        error instanceof KeyboardInterrupt ? 'Compaction stopped by user' : errorMessage(error)
    }

    const durationMs = Math.max(0, Math.round((pyTime() - start) * 1000))

    if (failure !== null) {
      if (trigger === 'auto') this.failedSerial = this.turnSerial
      const result: CompactionResult = {
        key,
        trigger,
        status: 'failed',
        summary: null,
        modelUsed,
        tokensBefore: usage.usedTokens,
        tokensAfter: usage.usedTokens,
        beforePercent,
        afterPercent: beforePercent,
        messagesSummarized: split - from,
        messagesKept: base.length - split,
        durationMs,
        error: failure,
        splitContentIndex: split,
        firstKeptMessageId: 0,
        coversUpToMessageId: 0
      }
      this.persistFailure(result)
      this.notify(
        `Conversation compaction failed (${failure}). The original history is untouched and is still being sent in full.`,
        true
      )
      try {
        this.deps.callbacks.onFinish?.(result)
      } catch {
        /* a UI callback must never break compaction */
      }
      return result
    }

    const previousSummaryTokens = this.state.historySummary
      ? estimateTextTokens(this.state.historySummary)
      : 0
    const kept = dedupeOldToolOutputs(
      trimOldToolOutputs(
        base.slice(split),
        recentBoundaryIndex(base.slice(split), settings.recentMessages)
      ),
      recentBoundaryIndex(base.slice(split), settings.recentMessages)
    )
    const tokensAfter =
      overhead -
      previousSummaryTokens +
      estimateTextTokens(summary) +
      estimateContentsTokens(kept) +
      (options.pendingText ? estimateTextTokens(options.pendingText) : 0)
    const afterPercent = Math.round((tokensAfter / Math.max(1, budget)) * 100)

    this.state.historySummary = summary
    this.state.compactionSplitIndex = split
    this.state.requestDigest = null

    const result: CompactionResult = {
      key,
      trigger,
      status: 'success',
      summary,
      modelUsed,
      tokensBefore: usage.usedTokens,
      tokensAfter,
      beforePercent,
      afterPercent,
      messagesSummarized: split - from,
      messagesKept: base.length - split,
      durationMs,
      error: null,
      splitContentIndex: split,
      firstKeptMessageId: 0,
      coversUpToMessageId: 0
    }

    const record = this.persistSuccess(result)
    if (record !== null) {
      result.firstKeptMessageId = record.first_kept_message_id
      result.coversUpToMessageId = record.covers_up_to_message_id
    }
    try {
      this.deps.callbacks.onFinish?.(result)
    } catch {
      /* a UI callback must never break compaction */
    }
    return result
  }

  private persistSuccess(result: CompactionResult): CompactionRow | null {
    const store = this.deps.store()
    if (store === null) return null
    return store.saveCompaction({
      summary: result.summary ?? '',
      splitContentIndex: result.splitContentIndex,
      messagesSummarizedCount: result.messagesSummarized,
      messagesKeptCount: result.messagesKept,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      modelUsed: result.modelUsed,
      trigger: result.trigger,
      status: 'success',
      durationMs: result.durationMs
    })
  }

  private persistFailure(result: CompactionResult): void {
    const store = this.deps.store()
    if (store === null) return
    store.saveCompaction({
      summary: '',
      splitContentIndex: result.splitContentIndex,
      messagesSummarizedCount: result.messagesSummarized,
      messagesKeptCount: result.messagesKept,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      modelUsed: result.modelUsed,
      trigger: result.trigger,
      status: 'failed',
      durationMs: result.durationMs,
      error: result.error ?? 'Compaction failed'
    })
  }

  private summaryLadder(configured: string): string[] {
    const ladder: string[] = []
    for (const id of [configured, ...AppConstants.FALLBACK_MODELS, ...AppConstants.MODELS]) {
      const resolved = AppConstants.resolveModelId(id)
      if (chatCapable(resolved) && !ladder.includes(resolved)) ladder.push(resolved)
    }
    return ladder
  }

  private async generateSummary(
    prompt: string,
    configured: string
  ): Promise<{ text: string; model: string }> {
    const promptTokens = estimateTextTokens(prompt)
    let originalError: unknown = null
    for (const model of this.summaryLadder(configured)) {
      if (!chatCapable(model)) continue
      if (promptTokens + SUMMARY_MAX_OUTPUT_TOKENS > requestTokenBudget(model)) continue
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (this.state.cancelRequested) throw new KeyboardInterrupt()
          const cfg: GenerateContentConfig = {
            systemInstruction: SUMMARY_SYSTEM_PROMPT,
            temperature: 0.2,
            maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS
          }
          const contents: Content[] = [{ role: 'user', parts: [{ text: prompt }] }]
          const response = await this.deps.client.generateContent(model, contents, cfg, {
            conversationId: this.state.conversationId,
            sender: 'compaction',
            kind: 'compaction',
            label: model === configured ? 'summarizer' : 'summarizer failover',
            requestedModel: configured,
            breakdown: estimateRequestBreakdown({
              systemInstruction: SUMMARY_SYSTEM_PROMPT,
              contents,
              memoryChars: 0,
              summaryChars: 0
            }),
            inputEstimate: estimateTextTokens(SUMMARY_SYSTEM_PROMPT) + promptTokens
          })
          if (this.state.cancelRequested) throw new KeyboardInterrupt()
          const text = pyStrip(response.text)
          if (text !== '') return { text, model }
          throw new Error('The summarizer returned an empty summary.')
        } catch (error) {
          if (error instanceof KeyboardInterrupt) throw error
          if (originalError === null) originalError = error
          const message = errorMessage(error)
          if (isAuthFailure(message) || AppConstants.isNetworkError(error)) throw error
          if (message.includes('503') || message.includes('UNAVAILABLE')) {
            await sleep(1.5 * (attempt + 1))
            if (this.state.cancelRequested) throw new KeyboardInterrupt()
            continue
          }
          break
        }
      }
    }
    if (originalError) throw originalError
    throw new Error('All summary models failed to respond.')
  }
}
