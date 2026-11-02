import type { GenerateContentConfig } from '@google/genai'
import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { KeyboardInterrupt, errorMessage } from '../../shared/utils/exceptions'
import { pyFloatRepr } from '../../shared/utils/pyjson'
import { pyFormatFixed, pyRound } from '../../shared/utils/pyformat'
import { pyLen, pySlice, pyStrip } from '../../shared/utils/pystr'
import { pyTime } from '../../shared/utils/pytime'
import { nowStrftime } from '../../shared/utils/strftime'
import type { AgentState, TimelineEvent } from '../models/agent-state'
import type { Content, Part } from '../models/content'
import { outRaw, sleep } from '../utils/console-out'
import type { AgentSystem } from './agent-system.service'
import { attr, type AiClient, type AiUsageContext, type EngineResponse } from './ai-client.service'
import type { ConversationCompactor, RequestView } from './conversation-compaction.service'
import { historySummaryInstruction, summaryInstruction } from './conversation-history.service'
import { estimateRequestBreakdown, tokenUsageRepository } from './token-usage.service'

export function elapsedText(seconds: number): string {
  return pyFormatFixed(seconds, 1)
}

function pyFloatListRepr(values: readonly number[]): string {
  return `[${values.map(pyFloatRepr).join(', ')}]`
}

/** Only a result bigger than this is worth shortening; small ones ride along untouched. */
const ELIDE_RESULT_FROM = 1500
const RESULT_HEAD = 400
const RESULT_TAIL = 160

function elideToolResult(part: Part): Part {
  const call = part.function_response
  const response = call?.response
  const output = response?.output
  if (call === undefined || response === undefined || typeof output !== 'string') return part
  const length = pyLen(output)
  if (length <= ELIDE_RESULT_FROM) return part
  const shrunk =
    pySlice(output, 0, RESULT_HEAD) +
    `\n... [elided ${length - RESULT_HEAD - RESULT_TAIL} characters of an older tool result] ...\n` +
    pySlice(output, -RESULT_TAIL)
  return { ...part, function_response: { ...call, response: { ...response, output: shrunk } } }
}

/**
 * A 40-step turn re-uploads every earlier tool result on every step, so one 30k-character file
 * read costs 30k characters times however long the turn runs. This shortens only the copy handed
 * to the API — the saved session and the undo history keep the original text. The trailing
 * `keepEntries` entries are the live part of the turn and are never touched.
 */
export function compactHistory(
  contents: Content[],
  keepEntries = AppConstants.HISTORY_KEEP_ENTRIES
): Content[] {
  const stale = contents.length - keepEntries
  if (stale <= 0) return contents
  return contents.map((content, index) => {
    if (index >= stale || !content.parts?.some((p) => p.function_response)) return content
    return { ...content, parts: content.parts.map(elideToolResult) }
  })
}

/** A rejected key or permission fails identically on every model, so walking is pointless. */
function isAuthFailure(err: string): boolean {
  return ['401', '403', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'API_KEY'].some((code) =>
    err.includes(code)
  )
}

/**
 * Only load and quota failures have a chance of succeeding elsewhere. A malformed request (400),
 * an unknown model (404) or any other client error is sent back as-is instead of re-uploading the
 * same context to every candidate.
 */
function isRetryableFailure(err: string): boolean {
  const lower = err.toLowerCase()
  return (
    /\b(408|429|500|502|503|504)\b/u.test(err) ||
    lower.includes('resource_exhausted') ||
    lower.includes('unavailable') ||
    lower.includes('deadline_exceeded') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('overloaded') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('internal server error')
  )
}

function isContextSizeFailure(err: string): boolean {
  const lower = err.toLowerCase()
  return (
    /\b413\b/u.test(err) ||
    lower.includes('too large') ||
    lower.includes('too many tokens') ||
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('maximum context') ||
    lower.includes('exceeds the maximum') ||
    lower.includes('payload size')
  )
}

export class AgentGenerate {
  /** The model that answered last this turn, so step 2 does not re-probe a dead candidate. */
  private sticky: string | null = null
  /** Routing is announced once per target model, not once per step of a long turn. */
  private notifiedFor: string | null = null
  /** Bumped per turn, so a request that outlives its turn cannot route the next one. */
  private epoch = 0
  /** Aborts the request in flight as soon as Stop or Esc is pressed. */
  private abortController: AbortController | null = null

  constructor(
    private readonly state: AgentState,
    private readonly client: AiClient,
    private readonly system: AgentSystem,
    private readonly compactor: ConversationCompactor
  ) {}

  /** Called once per user turn so the model the user picked is always the first one asked. */
  beginTurn(): void {
    this.abortController?.abort()
    this.abortController = null
    this.epoch += 1
    this.sticky = null
    this.notifiedFor = null
    this.state.lastRoutedModel = null
    this.state.requestDigest = null
  }

  /** Stops the request in flight, so Stop does not keep paying for a reply nobody will read. */
  cancel(): void {
    this.abortController?.abort()
  }

  private assertCurrent(epoch: number): void {
    if (epoch !== this.epoch || this.state.cancelRequested) throw new KeyboardInterrupt()
  }

  /**
   * v1.0's own four candidates come first, then every remaining model the app lists, so a quota
   * problem walks the whole picker before anything is shown to the user.
   */
  private ladder(primary: string): string[] {
    const ladder: string[] = []
    for (const id of [primary, ...AppConstants.FALLBACK_MODELS, ...AppConstants.MODELS]) {
      const resolved = AppConstants.resolveModelId(id)
      if (!ladder.includes(resolved)) ladder.push(resolved)
    }
    if (this.sticky === null) return ladder
    return [this.sticky, ...ladder.filter((model) => model !== this.sticky)]
  }

  private announceFailover(chosenModel: string, model: string, primary: string): void {
    if (model === primary || this.notifiedFor === model) return
    this.notifiedFor = model
    this.emitFailoverNotice(chosenModel, model)
  }

  private emitFailoverNotice(chosenModel: string, model: string): void {
    const ev: TimelineEvent = {
      type: 'notice',
      tool: 'model_failover',
      args: { requested: chosenModel, routed_to: model },
      output: `Notice: [${chosenModel}] unavailable or rate-limited. Auto-routed via ${model}.`,
      is_error: false,
      status: 'Routed',
      duration: 0,
      timestamp: nowStrftime('%H:%M:%S'),
      file_changes: []
    }
    this.state.turnTimelineEvents.push(ev)
    this.state.journal?.recordEvent(ev)
    if (typeof this.state.onTimelineEvent === 'function') {
      try {
        this.state.onTimelineEvent(ev)
      } catch {}
    }
  }

  private streamingActive(): boolean {
    return (
      this.state.streamingAllowed &&
      this.state.behaviorSettings.streamResponses &&
      typeof this.state.onAssistantDelta === 'function'
    )
  }

  private streamReset(): void {
    const notify = this.state.onAssistantDelta
    if (typeof notify !== 'function') return
    try {
      notify({ text: '', reset: true })
    } catch {}
  }

  private lastUserPrompt(): string {
    let userPrompt = ''
    for (let i = this.state.contents.length - 1; i >= 0; i--) {
      const c = this.state.contents[i]
      if ((c.role ?? '') !== 'user') continue
      for (const p of c.parts ?? []) {
        if (p.text) {
          userPrompt = p.text
          break
        }
      }
      if (userPrompt) break
    }
    return userPrompt
  }

  /**
   * The whole ladder is walked on every step. `announceFailover` keeps the notice to one per
   * target model, and `sticky` ordering keeps a long turn from re-paying a dead model's upload.
   */
  private route(chosenModel: string, model: string, primary: string): void {
    this.sticky = model
    this.state.lastRoutedModel = model
    this.announceFailover(chosenModel, model, primary)
  }

  /**
   * The compactor measures the request per model. Its digest covers any older turns this request
   * had to leave out; the persisted summary is carried by the system prompt instead.
   */
  private applyRequestView(view: RequestView): void {
    this.state.lastPromptTokensEstimate = view.tokens
    this.state.requestDigest = view.digest
  }

  /** Labels and estimated part sizes for the usage log; the provider still reports the totals. */
  private usageContext(
    chosenModel: string,
    model: string,
    cfg: GenerateContentConfig,
    contents: Content[]
  ): AiUsageContext {
    const summaryChars =
      (this.state.historySummary ? historySummaryInstruction(this.state.historySummary).length : 0) +
      (this.state.requestDigest ? summaryInstruction(this.state.requestDigest).length : 0)
    const breakdown = estimateRequestBreakdown({
      systemInstruction:
        typeof cfg.systemInstruction === 'string' ? cfg.systemInstruction : null,
      toolDeclarations: cfg.tools,
      contents,
      memoryChars: this.state.memoryPromptChars,
      summaryChars
    })
    return {
      conversationId: this.state.conversationId,
      sender: this.state.usageSender,
      kind: 'chat',
      label: model === chosenModel ? 'turn' : 'failover',
      requestedModel: chosenModel,
      breakdown,
      inputEstimate: Object.values(breakdown).reduce((sum, value) => sum + value, 0)
    }
  }

  async generateSync(): Promise<EngineResponse> {
    const epoch = this.epoch
    const controller = new AbortController()
    this.abortController = controller
    const chosenModel = this.state.model
    const resolvedPrimary = AppConstants.resolveModelId(chosenModel)
    const ladder = this.ladder(resolvedPrimary)

    let originalError: unknown = null
    for (const model of ladder) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          this.assertCurrent(epoch)
          if (AppConstants.isAntigravity(model)) {
            const userPrompt = this.lastUserPrompt() || 'Hello'
            const interactions = this.client.interactions
            let text: string
            if (interactions) {
              const agentId =
                model === 'antigravity' || model === 'antigravity-latest'
                  ? 'antigravity-preview-latest'
                  : model
              const res = await interactions.create({
                agent: agentId,
                input: userPrompt,
                environment: {}
              })
              text = attr<string>(res, 'output_text') ?? ''
              // The interactions API reports no usage, so this request is logged as an estimate.
              const inputEstimate = Math.ceil(
                this.system.singleTurnPrompt(this.state, userPrompt).length / 4
              )
              const outputEstimate = Math.ceil(pyLen(text) / 4)
              tokenUsageRepository.record({
                conversationId: this.state.conversationId,
                sender: this.state.usageSender,
                kind: 'chat',
                label: 'antigravity interactions',
                model,
                requestedModel: chosenModel,
                inputTokens: inputEstimate,
                outputTokens: outputEstimate,
                cachedTokens: 0,
                thoughtTokens: 0,
                totalTokens: inputEstimate + outputEstimate,
                estimated: true,
                breakdown: {
                  system: 0,
                  memory: 0,
                  summary: 0,
                  history: 0,
                  toolDefinitions: 0,
                  toolResults: 0,
                  toolCalls: 0,
                  newMessage: inputEstimate,
                  media: 0,
                  other: 0
                }
              })
            } else {
              // These agents reject a replayed history *and* a system instruction with a 400, so
              // the conversation collapses to one user turn that carries the persona inline.
              const single: Content = {
                role: 'user',
                parts: [{ text: this.system.singleTurnPrompt(this.state, userPrompt) }]
              }
              const singleCfg: GenerateContentConfig = {}
              const res = await this.client.generateContent(
                model,
                [single],
                singleCfg,
                this.usageContext(chosenModel, model, singleCfg, [single])
              )
              text = res.text
            }
            this.assertCurrent(epoch)
            this.route(chosenModel, model, resolvedPrimary)
            const stripped = pyStrip(text)
            const content: Content = { role: 'model', parts: [{ text: stripped }] }
            return {
              candidates: [{ content }],
              text: stripped,
              usage_metadata: null,
              raw_response: { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }
            }
          }

          if (AppConstants.isEmbedding(model) && this.client.hasEmbedContent) {
            const userPrompt = this.lastUserPrompt()
            const input = userPrompt || 'Gemibot'
            const embedRes = await this.client.embedContent(model, input, {
              conversationId: this.state.conversationId,
              sender: this.state.usageSender,
              kind: 'embedding',
              label: 'embedding',
              requestedModel: chosenModel,
              inputEstimate: Math.ceil(input.length / 4)
            })
            const embeddings = attr<unknown[]>(embedRes, 'embeddings') ?? [[]]
            const vec = attr<unknown>(embedRes, 'embedding') || embeddings[0]
            const vecValues = attr<number[]>(vec, 'values') ?? (Array.isArray(vec) ? vec : [])
            const dim = vecValues.length
            const sample = vecValues.slice(0, 8).map((x) => pyRound(Number(x), 4))
            const text =
              `### Vector Embedding Report (${model})\n` +
              `- **Dimensions:** ${dim}\n` +
              `- **Input Sample:** "${pySlice(input, 0, 60)}"\n` +
              `- **Vector Sample (first 8 components):** \`${pyFloatListRepr(sample)}\`\n` +
              `- **Status:** Embedding generated successfully.\n`
            const stripped = pyStrip(text)
            const content: Content = { role: 'model', parts: [{ text: stripped }] }
            this.assertCurrent(epoch)
            this.route(chosenModel, model, resolvedPrimary)
            return {
              candidates: [{ content }],
              text: stripped,
              usage_metadata: null,
              raw_response: { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }
            }
          }

          // A fallback model can have a smaller window than the one that just failed, so the
          // request is measured (and compacted further) for each candidate before it is sent.
          const view = await this.compactor.prepareRequest(model)
          this.assertCurrent(epoch)
          this.applyRequestView(view)

          let cfg: GenerateContentConfig = this.system.configFor(this.state, model)
          if (AppConstants.isGemma(model)) cfg = this.system.noToolConfig(this.state)
          cfg = { ...cfg, abortSignal: controller.signal }

          let response: EngineResponse
          const history = view.contents
          const callModel = async (requestCfg: GenerateContentConfig): Promise<EngineResponse> => {
            const context = this.usageContext(chosenModel, model, requestCfg, history)
            if (!this.streamingActive()) {
              return await this.client.generateContent(model, history, requestCfg, context)
            }
            this.streamReset()
            try {
              return await this.client.generateContentStream(
                model,
                history,
                requestCfg,
                context,
                (delta) => {
                  const notify = this.state.onAssistantDelta
                  if (typeof notify !== 'function') return
                  try {
                    notify({ text: delta })
                  } catch {}
                }
              )
            } catch (streamErr) {
              if (controller.signal.aborted) throw streamErr
              const streamText = errorMessage(streamErr)
              if (
                AppConstants.isNetworkError(streamErr) ||
                isAuthFailure(streamText) ||
                isContextSizeFailure(streamText)
              ) {
                throw streamErr
              }
              // A model or proxy that cannot stream still gets one normal request instead of
              // failing the turn.
              this.streamReset()
              return await this.client.generateContent(model, history, requestCfg, context)
            }
          }
          try {
            response = await callModel(cfg)
          } catch (callErr) {
            if (controller.signal.aborted) throw new KeyboardInterrupt()
            const errStr = errorMessage(callErr)
            const hasTools = Boolean((cfg as { tools?: unknown[] }).tools?.length)
            if (
              (errStr.toLowerCase().includes('tool') ||
                errStr.toLowerCase().includes('function')) &&
              hasTools
            ) {
              const noTools: GenerateContentConfig = {
                ...this.system.noToolConfig(this.state),
                abortSignal: controller.signal
              }
              response = await callModel(noTools)
            } else {
              throw callErr
            }
          }

          this.assertCurrent(epoch)
          this.route(chosenModel, model, resolvedPrimary)
          return response
        } catch (e) {
          if (e instanceof KeyboardInterrupt) throw e
          if (controller.signal.aborted) throw new KeyboardInterrupt()
          if (originalError === null) originalError = e
          const err = errorMessage(e)
          // An automatically routed model that the key does not expose must not fail a task
          // that the user's own model could still handle; the ladder moves to the next entry.
          // 401/API_KEY stay fatal: the whole key is wrong, not just the routed model.
          const routeMiss =
            this.state.routedFromModel !== null &&
            (/\b404\b|not found|not supported|does not exist/iu.test(err) ||
              /\b403\b|permission_denied/iu.test(err))
          if (isAuthFailure(err) || AppConstants.isNetworkError(e)) {
            if (!routeMiss) throw originalError
            break
          }
          // A request that was silently too big for the window gets one retry after a forced
          // compaction instead of being re-uploaded unchanged to the next candidate.
          if (isContextSizeFailure(err) && attempt === 0) {
            const compacted = await this.compactor.compactNow('auto').catch(() => null)
            if (compacted !== null) {
              this.assertCurrent(epoch)
              continue
            }
          }
          if (!isRetryableFailure(err)) {
            if (!routeMiss) throw originalError
            break
          }
          if (
            err.includes('503') ||
            err.includes('UNAVAILABLE') ||
            err.toLowerCase().includes('overloaded')
          ) {
            await sleep(1.5 * (attempt + 1))
            this.assertCurrent(epoch)
            continue
          }
          break
        }
      }
    }

    if (originalError) throw originalError
    throw new Error('All candidate models failed to respond.')
  }

  async generate(): Promise<EngineResponse> {
    const box: { response: EngineResponse | null; error: unknown; done: boolean } = {
      response: null,
      error: null,
      done: false
    }
    // The loop below only wakes on a spinner tick, so the settled request has to ring the bell
    // itself; otherwise the reply sits in `box` for up to a whole tick before it is rendered.
    let wake: () => void = (): void => undefined
    const settled = new Promise<void>((resolve) => {
      wake = resolve
    })
    this.generateSync().then(
      (value) => {
        box.response = value
        box.done = true
        wake()
      },
      (err) => {
        box.error = err
        box.done = true
        wake()
      }
    )

    const start = pyTime()
    let frame = 0
    try {
      while (!box.done) {
        if (this.state.escMonitor?.check() || this.state.cancelRequested) {
          // The request is still in flight; abort it so the provider stops generating.
          this.cancel()
          throw new KeyboardInterrupt()
        }
        const elapsed = pyTime() - start
        const spin = AppConstants.SPINNER_FRAMES[frame % AppConstants.SPINNER_FRAMES.length]
        frame += 1
        outRaw(
          `\r\x1b[K${C.CYAN}${spin}${C.RESET} ${C.BOLD}Thinking...${C.RESET} ` +
            `${C.GRAY}[${this.state.model} - fn:${this.state.activeFunction} - ` +
            `${elapsedText(elapsed)}s - press ${C.YELLOW}esc${C.GRAY} to interrupt]${C.RESET}`
        )
        await Promise.race([settled, sleep(0.06)])
      }
    } finally {
      outRaw('\r\x1b[K')
    }

    if (box.error) throw box.error
    return box.response as EngineResponse
  }

  countUsage(response: EngineResponse): void {
    try {
      const usage = response.usage_metadata
      if (usage) {
        this.state.tokensIn += usage.prompt_token_count || usage.promptTokenCount || 0
        this.state.tokensOut += usage.candidates_token_count || usage.candidatesTokenCount || 0
        return
      }
      const metadata = response.raw_response
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const u = metadata.usageMetadata || {}
        this.state.tokensIn += u.promptTokenCount || 0
        this.state.tokensOut += u.candidatesTokenCount || 0
      }
    } catch {}
  }
}
