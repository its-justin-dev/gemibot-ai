import { randomUUID } from 'node:crypto'

import { AgentState } from '../models/agent-state'
import { AgentTurn } from './agent-turn.service'
import { AgentGenerate } from './agent-generate.service'
import { ConversationCompactor } from './conversation-compaction.service'
import { EffortLevel } from '../../shared/models/effort-level'
import {
  compactionFinalEvent,
  compactionRunningEvent
} from '../../shared/utils/compaction-event'
import type {
  CompactionResult,
  CompactionStartInfo,
  CompactionView
} from '../../shared/types/compaction'
import type {
  SubAgentSnapshot,
  ModelSwitchEvent,
  MultiAgentSnapshot
} from '../../shared/types/window'
import { AppConstants } from '../../shared/constants/app-constants'
import { nowStrftime } from '../../shared/utils/strftime'
import { pyTime } from '../../shared/utils/pytime'
import { C } from '../../shared/constants/colors'
import { out } from '../utils/console-out'
import type { Agent } from './agent.service'
import type { AgentMemory } from './agent-memory.service'
import type { AgentSystem } from './agent-system.service'
import type { AgentSettings } from './agent-settings.service'
import type { AgentPaths } from './agent-paths.service'
import type { ChooseHook } from './agent-session.service'
import type { ConversationPersistence } from './conversation-persistence.service'
import { BuildAbortedError } from './build-model.service'
import { tokenUsageRepository } from './token-usage.service'
import type {
  BuildTaskRunnerInput,
  BuildTaskRunnerResult
} from './build-orchestrator.service'

interface SubAgentOptions {
  effort?: EffortLevel
  signal?: AbortSignal
  autoApproveEdits?: boolean
}

export type SubAgentStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'switching'

function pySnippet(text: string, limit = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean
}

/** The full result stays in the sub-agent conversation; synthesis only needs the key parts. */
function trimSubAgentResult(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.round(limit * 0.7)
  const tail = limit - head
  return (
    text.slice(0, head) +
    `\n[... ${text.length - head - tail} characters omitted; the full result is in this ` +
    'sub-agent conversation] ...\n' +
    text.slice(-tail)
  )
}

export interface SubAgentContext {
  id: number
  task: string
  model: string
  effort: EffortLevel
  status: SubAgentStatus
  result: string | null
  error: string | null
  modelSwitches: ModelSwitchEvent[]
  compactions: CompactionView[]
  compactionRowIds: Map<string, number>
  startTime: number
  endTime: number | null
  state: AgentState
  turnEngine: AgentTurn
  generate: AgentGenerate
  compactor: ConversationCompactor
  conversationId: string | null
}

export class MultiAgentService {
  private readonly agent: Agent
  private enabled = false
  private maxSubAgents = 4
  private subAgents = new Map<number, SubAgentContext>()
  private readonly compactionsByAgent = new Map<number, CompactionView[]>()
  private isRunning = false
  private stopRequested = false
  private nextId = 1
  private runId = ''
  private setupFailures: Array<{ task: string; error: string }> = []

  constructor(
    agent: Agent,
    private readonly memory: AgentMemory,
    private readonly system: AgentSystem,
    private readonly settings: AgentSettings,
    private readonly paths: AgentPaths,
    private readonly choose: ChooseHook,
    private readonly persistence?: ConversationPersistence,
    private readonly parentConversation?: () => string | null,
    private readonly runTurn?: (prompt: string) => Promise<void>
  ) {
    this.agent = agent
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setMaxSubAgents(max: number): void {
    this.maxSubAgents = Math.max(2, Math.min(6, max))
  }

  getMaxSubAgents(): number {
    return this.maxSubAgents
  }

  private async runOrchestratorTurn(prompt: string): Promise<void> {
    if (typeof this.runTurn === 'function') await this.runTurn(prompt)
    else await this.agent.turn(prompt)
  }

  /**
   * The plan `orchestrate()` would use for this prompt. Null means the task is handled by a
   * normal single-agent turn, so no multi-agent indicator should appear.
   */
  plan(userText: string): { subTasks: string[]; numAgents: number } | null {
    if (!this.enabled) return null
    if (!this.assessComplexity(userText)) return null
    const subTasks = this.breakIntoSubTasks(userText)
    const numAgents = Math.min(subTasks.length, this.maxSubAgents)
    if (numAgents < 2) return null
    return { subTasks, numAgents }
  }

  /**
   * Main entry point. If multi-agent is disabled or the task is simple, falls back to
   * a normal single-agent turn via this.agent.turn().
   */
  async orchestrate(userText: string): Promise<void> {
    const plan = this.plan(userText)
    if (plan === null) {
      await this.runOrchestratorTurn(userText)
      return
    }

    // Complex task: break into sub-tasks and run in parallel.
    const { subTasks, numAgents } = plan

    this.isRunning = true
    this.stopRequested = false
    this.subAgents.clear()
    this.compactionsByAgent.clear()
    this.setupFailures = []
    this.nextId = 1
    this.runId = randomUUID()

    // Assign models, spreading across different models to avoid quota collisions.
    const models = this.selectStartingModels(numAgents)

    try {
      await Promise.all(
        subTasks.slice(0, numAgents).map((task, idx) =>
          this.runSubAgent(idx, task, models[idx]).catch((error) => {
            // A setup failure before the per-agent try block must not reject the whole batch:
            // the other sub-agents' results still need to reach the synthesis.
            const message = error instanceof Error ? error.message : String(error)
            this.setupFailures.push({ task, error: message })
            out(`  ${C.YELLOW}Sub-Agent setup failed: ${message}${C.RESET}`)
            return {
              id: 0,
              status: 'failed' as const,
              result: null,
              error: message,
              modelUsed: models[idx],
              modelSwitches: [],
              duration: 0
            }
          })
        )
      )

      // Stopping the task must not run an extra orchestrator turn after the sub-agents end.
      if (this.stopRequested) return

      // Orchestrator synthesizes the final answer.
      const combined = this.combineResults()
      const synthesisPrompt =
        `You are the orchestrator of a multi-agent task. The user asked:\n${userText}\n\n` +
        `${subTasks.length} sub-agents worked on independent sub-tasks in parallel. Here are their results:\n\n` +
        combined +
        `\n\nPlease synthesize these into one coherent final answer for the user. ` +
        `If any sub-agent failed, mention it. Do not claim credit for work you did not do.`

      await this.runOrchestratorTurn(synthesisPrompt)
    } finally {
      this.isRunning = false
      this.subAgents.clear()
      this.compactionsByAgent.clear()
    }
  }

  private assessComplexity(userText: string): boolean {
    const text = userText.toLowerCase()
    const complexitySignals = [
      'and also', 'then', 'additionally', 'meanwhile', 'separately',
      'independent', 'parallel', 'multiple files', 'several files',
      'update', 'create', 'modify', 'refactor', 'rewrite'
    ]
    let signalCount = 0
    for (const sig of complexitySignals) {
      if (text.includes(sig)) signalCount++
    }
    if (userText.length > 300) signalCount += 1
    const fileMentions = (userText.match(/\b\w+\.\w{2,4}\b/g) ?? []).length
    if (fileMentions >= 2) signalCount += 1
    return signalCount >= 2
  }

  private breakIntoSubTasks(userText: string): string[] {
    const parts = userText.split(/[,;]|(?:\s+and\s+)/i).map((s) => s.trim()).filter((s) => s.length > 0)
    if (parts.length >= 2) return parts
    const sentences = userText.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0)
    if (sentences.length >= 2) return sentences
    return [userText]
  }

  private selectStartingModels(count: number): string[] {
    const available = [...AppConstants.MODELS]
    const result: string[] = []
    for (let i = 0; i < count; i++) {
      result.push(available[i % available.length])
    }
    return result
  }

  private async runSubAgent(
    _index: number,
    task: string,
    model: string,
    options: SubAgentOptions = {}
  ): Promise<{
    id: number
    status: 'succeeded' | 'failed'
    result: string | null
    error: string | null
    modelUsed: string
    modelSwitches: ModelSwitchEvent[]
    duration: number
  }> {
    const id = this.nextId++
    const effort = options.effort ?? this.agent.effortLevel
    const subState = new AgentState(this.agent.state.appRoot, model, false, false)
    // The sub-agent sees the same project the orchestrator is pointed at, not the app folder.
    subState.root = this.agent.state.root
    subState.usageSender = `sub-agent ${id}`
    subState.tokenSettings = this.agent.state.tokenSettings
    subState.behaviorSettings = { ...this.agent.state.behaviorSettings }
    subState.advancedAgent = this.agent.state.advancedAgent
    subState.mode = this.agent.state.mode
    subState.effortOverride = effort
    subState.activeFunction = this.agent.state.activeFunction
    subState.autoApproveEdits = options.autoApproveEdits === true
    const ctx: SubAgentContext = {
      id,
      task,
      model,
      effort,
      status: 'running',
      result: null,
      error: null,
      modelSwitches: [],
      compactions: [],
      compactionRowIds: new Map<string, number>(),
      startTime: pyTime(),
      endTime: null,
      state: subState,
      turnEngine: null as unknown as AgentTurn,
      generate: null as unknown as AgentGenerate,
      compactor: null as unknown as ConversationCompactor,
      conversationId: null
    }

    // Each sub-agent gets its own child conversation so its transcript survives a restart while
    // staying out of the normal (parent-only) conversation list.
    const parentId = this.parentConversation?.() ?? null
    const child =
      parentId !== null && this.persistence !== undefined
        ? this.persistence.child(parentId, `Sub-Agent ${id}: ${pySnippet(task)}`)
        : null
    if (child !== null) {
      ctx.conversationId = child.conversationId
      subState.conversationId = child.conversationId
      child.recordUser(task, { contentIndex: 0 }, child.conversationId)
      ctx.state.onContentAdded = (content) => child.appendContent(content, child.conversationId)
      ctx.state.onContentsTruncated = (length, compactionReset) => {
        child.truncateContents(length, child.conversationId)
        if (compactionReset) child.invalidateCompactionsAboveSplit(length, child.conversationId)
      }
    }

    // Sub-agents compact under the same rules as the parent, against their own history.
    const compactorCallbacks = {
      onStart: (info: CompactionStartInfo): void => {
        const event = compactionRunningEvent(info, nowStrftime('%H:%M:%S'))
        const dbId =
          child === null
            ? null
            : child.recordAction(event, {
                model: ctx.state.lastRoutedModel ?? ctx.state.model,
                effortLevel: effort.displayName
              })
        if (dbId !== null) ctx.compactionRowIds.set(info.key, dbId)
        ctx.compactions.push({
          key: info.key,
          trigger: info.trigger,
          status: 'running',
          modelUsed: info.model,
          tokensBefore: info.tokensBefore,
          tokensAfter: null,
          beforePercent: info.beforePercent,
          afterPercent: null,
          messagesSummarized: 0,
          messagesKept: 0,
          durationMs: 0,
          error: null,
          createdAt: Date.now()
        })
        this.compactionsByAgent.set(id, ctx.compactions)
        this.emitSubAgentUpdate(
          id,
          ctx.status,
          ctx.state.lastRoutedModel ?? ctx.state.model,
          undefined,
          undefined,
          ctx.conversationId,
          ctx.compactions
        )
      },
      onFinish: (result: CompactionResult): void => {
        const dbId = ctx.compactionRowIds.get(result.key) ?? null
        ctx.compactionRowIds.delete(result.key)
        const event = compactionFinalEvent(result, nowStrftime('%H:%M:%S'))
        if (child !== null && dbId !== null) child.updateActionEvent(dbId, event)
        else if (child !== null) {
          child.recordAction(event, {
            model: ctx.state.lastRoutedModel ?? ctx.state.model,
            effortLevel: effort.displayName
          })
        }
        const view: CompactionView = {
          key: result.key,
          trigger: result.trigger,
          status: result.status,
          modelUsed: result.modelUsed,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          beforePercent: result.beforePercent,
          afterPercent: result.afterPercent,
          messagesSummarized: result.messagesSummarized,
          messagesKept: result.messagesKept,
          durationMs: result.durationMs,
          error: result.error,
          summary: result.summary,
          createdAt: Date.now()
        }
        const at = ctx.compactions.findIndex((item) => item.key === result.key)
        if (at >= 0) ctx.compactions[at] = view
        else ctx.compactions.push(view)
        this.compactionsByAgent.set(id, ctx.compactions)
        this.emitSubAgentUpdate(
          id,
          ctx.status,
          ctx.state.lastRoutedModel ?? ctx.state.model,
          undefined,
          undefined,
          ctx.conversationId,
          ctx.compactions
        )
      },
      onNotice: (text: string, isError: boolean): void => {
        out(`  ${isError ? C.YELLOW : C.DIM}Sub-Agent ${id}: ${text}${C.RESET}`)
        if (child !== null) {
          child.recordEvent(
            {
              kind: 'pill',
              text,
              icon: isError ? '⚠️' : 'ℹ️'
            },
            {},
            child.conversationId
          )
        }
      }
    }
    ctx.compactor = new ConversationCompactor({
      state: ctx.state,
      client: this.agent.client,
      system: this.system,
      settings: () => this.agent.compactionConfig(),
      store: () => child,
      callbacks: compactorCallbacks
    })

    // Build isolated services for this sub-agent.
    ctx.generate = new AgentGenerate(ctx.state, this.agent.client, this.system, ctx.compactor)
    ctx.turnEngine = new AgentTurn({
      state: ctx.state,
      paths: this.paths,
      memory: this.memory,
      system: this.system,
      settings: this.settings,
      generate: ctx.generate,
      compactor: ctx.compactor,
      execute: (name, args) =>
        this.agent.tools.executeFor(subState.usageSender, subState, name, args),
      choose: this.choose,
      effort: () => effort.displayName,
      onAssistantReply: (text, meta) => {
        if (child === null) return
        const timestamp = nowStrftime('%H:%M:%S')
        child.recordAssistant(text, {
          model: ctx.state.lastRoutedModel ?? ctx.state.model,
          effortLevel: effort.displayName,
          event: {
            kind: 'assistant',
            text,
            meta,
            header: `${meta || 'GemiBot AI'}  •  ${timestamp}`,
            timestamp
          }
        })
      }
    })

    // Override the model for this sub-agent's generate ladder.
    ctx.state.model = model
    ctx.state.cancelRequested = false

    // Wire up callbacks so errors/tool results are captured in this sub-agent context.
    ctx.state.onError = (_userMsg, _rawErr) => {
      out(`  ${C.YELLOW}Sub-Agent ${id} error${C.RESET}`)
    }
    ctx.state.onToolError = (_toolName, _toolErr) => {
      out(`  ${C.YELLOW}Sub-Agent ${id} tool error${C.RESET}`)
    }
    ctx.state.onTimelineEvent = (event) => {
      if (child !== null) {
        child.recordAction(event, {
          model: ctx.state.lastRoutedModel ?? ctx.state.model,
          effortLevel: effort.displayName
        })
      }
      if (event.tool === 'model_failover') {
        const args = event.args as Record<string, unknown> | undefined
        const from = args?.requested as string | undefined
        const to = args?.routed_to as string | undefined
        const reason = (event.output as string) ?? ''
        if (from && to) {
          ctx.modelSwitches.push({ fromModel: from, toModel: to, reason, timestamp: nowStrftime('%H:%M:%S') })
          ctx.status = 'switching'
          this.emitSubAgentUpdate(id, 'switching', to, undefined, undefined, ctx.conversationId)
        }
      }
    }

    this.subAgents.set(id, ctx)
    this.emitSubAgentUpdate(id, 'running', model, undefined, undefined, ctx.conversationId)

    const onAbort = (): void => {
      subState.cancelRequested = true
      ctx.turnEngine?.cancel()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      if (this.stopRequested) {
        ctx.status = 'failed'
        ctx.error = 'Stopped by user'
        ctx.endTime = pyTime()
        const used = ctx.state.lastRoutedModel ?? ctx.state.model
        this.emitSubAgentUpdate(id, 'failed', used, undefined, ctx.error, ctx.conversationId)
        return {
          id,
          status: 'failed',
          result: null,
          error: ctx.error,
          modelUsed: used,
          modelSwitches: ctx.modelSwitches,
          duration: ctx.endTime - ctx.startTime
        }
      }

      await ctx.turnEngine.turn(task)

      // The turn engine swallows errors and user stops, so its outcome flags decide the status.
      if (this.stopRequested || ctx.status === 'failed' || !ctx.state.lastTurnSucceeded) {
        if (ctx.status !== 'failed') {
          const cancelled = this.stopRequested || ctx.state.lastTurnCancelled
          ctx.status = 'failed'
          ctx.error = cancelled
            ? 'Stopped by user'
            : (ctx.state.lastTurnError ?? 'Turn did not complete')
          ctx.endTime = pyTime()
          this.emitSubAgentUpdate(
            id,
            'failed',
            ctx.state.lastRoutedModel ?? ctx.state.model,
            undefined,
            ctx.error,
            ctx.conversationId
          )
        }
        return {
          id,
          status: 'failed',
          result: null,
          error: ctx.error,
          modelUsed: ctx.state.lastRoutedModel ?? ctx.state.model,
          modelSwitches: ctx.modelSwitches,
          duration: (ctx.endTime ?? pyTime()) - ctx.startTime
        }
      }

      ctx.status = 'succeeded'
      ctx.result = this.extractLastAssistantText(ctx.state)
      ctx.endTime = pyTime()
      this.emitSubAgentUpdate(
        id,
        'succeeded',
        ctx.state.lastRoutedModel ?? ctx.state.model,
        ctx.result,
        undefined,
        ctx.conversationId
      )

      return {
        id,
        status: 'succeeded',
        result: ctx.result,
        error: null,
        modelUsed: ctx.state.lastRoutedModel ?? ctx.state.model,
        modelSwitches: ctx.modelSwitches,
        duration: ctx.endTime - ctx.startTime
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      ctx.endTime = pyTime()
      // Avoid duplicate 'failed' emission if stopSubAgent() already set it.
      if (ctx.status !== 'failed') {
        ctx.status = 'failed'
        ctx.error = errMsg
        this.emitSubAgentUpdate(
          id,
          'failed',
          ctx.state.lastRoutedModel ?? ctx.state.model,
          undefined,
          errMsg,
          ctx.conversationId
        )
      }
      return {
        id,
        status: 'failed',
        result: null,
        error: errMsg,
        modelUsed: ctx.state.lastRoutedModel ?? ctx.state.model,
        modelSwitches: ctx.modelSwitches,
        duration: ctx.endTime - ctx.startTime
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * One Build-mode task. Unlike a normal sub-agent its previous context is dropped after the
   * task, because a large build would otherwise keep every task transcript in memory.
   */
  async runBuildTask(input: BuildTaskRunnerInput): Promise<BuildTaskRunnerResult> {
    if (input.signal?.aborted === true) throw new BuildAbortedError()
    this.stopRequested = false
    const result = await this.runSubAgent(0, input.prompt, input.model, {
      effort: EffortLevel.fromString(input.effort),
      signal: input.signal,
      autoApproveEdits: input.autoApproveEdits === true
    })
    const ctx = this.subAgents.get(result.id)
    const filesChanged = (ctx?.state.turnFileChanges ?? []).map((change) => change.path)
    const tokens =
      ctx?.conversationId != null
        ? tokenUsageRepository.summary(ctx.conversationId).totalTokens
        : 0
    this.subAgents.delete(result.id)
    this.compactionsByAgent.delete(result.id)
    if (input.signal?.aborted) throw new BuildAbortedError()
    return {
      summary: result.result ?? result.error ?? '',
      filesChanged,
      error: result.error,
      model: result.modelUsed,
      durationMs: Math.max(0, Math.round(result.duration * 1000)),
      tokens
    }
  }

  private stopSubAgent(id: number): void {
    const ctx = this.subAgents.get(id)
    if (!ctx) return
    // Do not overwrite a sub-agent that already completed (success or failure).
    if (ctx.status === 'succeeded' || ctx.status === 'failed') return
    ctx.status = 'failed'
    ctx.error = 'Stopped by user'
    ctx.endTime = pyTime()
    ctx.turnEngine.cancel()
    this.emitSubAgentUpdate(
      id,
      'failed',
      ctx.state.lastRoutedModel ?? ctx.model,
      undefined,
      ctx.error,
      ctx.conversationId
    )
  }

  stopAllSubAgents(): void {
    this.stopRequested = true
    for (const [id] of this.subAgents) {
      this.stopSubAgent(id)
    }
  }

  getSubAgentSnapshot(id: number): SubAgentSnapshot | null {
    const ctx = this.subAgents.get(id)
    if (!ctx) return null
    return {
      id: ctx.id,
      task: ctx.task,
      model: ctx.state.lastRoutedModel ?? ctx.state.model,
      effort: ctx.effort.displayName,
      status: ctx.status,
      result: ctx.result,
      error: ctx.error,
      fileChanges: [],
      modelSwitches: ctx.modelSwitches,
      compactions: [...ctx.compactions]
    }
  }

  getAllSubAgentSnapshots(): SubAgentSnapshot[] {
    return Array.from(this.subAgents.values()).map((ctx) => ({
      id: ctx.id,
      task: ctx.task,
      model: ctx.state.lastRoutedModel ?? ctx.state.model,
      effort: ctx.effort.displayName,
      status: ctx.status,
      result: ctx.result,
      error: ctx.error,
      fileChanges: [],
      modelSwitches: ctx.modelSwitches,
      compactions: [...ctx.compactions]
    }))
  }

  getMultiAgentSnapshot(): MultiAgentSnapshot {
    const subAgents = this.getAllSubAgentSnapshots()
    const total = subAgents.length
    const completed = subAgents.filter((s) => s.status === 'succeeded' || s.status === 'failed').length
    const activeIdx = subAgents.findIndex((s) => s.status === 'running')
    return {
      isActive: this.isRunning,
      orchestratorModel: this.agent.model,
      subAgents,
      activeSubAgentIdx: activeIdx >= 0 ? activeIdx : null,
      totalSubTasks: total,
      completedSubTasks: completed
    }
  }

  private extractLastAssistantText(state: AgentState): string | null {
    const contents = state.contents
    for (let i = contents.length - 1; i >= 0; i--) {
      const c = contents[i]
      if ((c.role ?? '') === 'model' || (c.role ?? '') === 'assistant') {
        const parts = c.parts ?? []
        for (const p of parts) {
          if (p.text && !(p.thought ?? false)) return p.text
        }
      }
    }
    return null
  }

  private combineResults(): string {
    const lines: string[] = []
    // Each sub-agent's own transcript keeps the untouched result; only the orchestrator's copy
    // is bounded so four long reports do not become one enormous synthesis request.
    const limit = (this.agent.state.tokenSettings ?? null) === null ? 0 : 6_000
    // Iterate over actual sub-agent contexts (IDs start at 1, not 0).
    for (const ctx of this.subAgents.values()) {
      const n = ctx.id
      if (ctx.status === 'succeeded' && ctx.result) {
        const result = limit > 0 ? trimSubAgentResult(ctx.result, limit) : ctx.result
        lines.push(`## Sub-Agent ${n}\n${result}`)
      } else {
        lines.push(`## Sub-Agent ${n}\n**Status:** Failed\n**Error:** ${ctx.error ?? 'unknown error'}`)
      }
    }
    for (const failure of this.setupFailures) {
      lines.push(
        `## Sub-Agent (did not start)\n**Task:** ${failure.task}\n` +
          `**Status:** Failed\n**Error:** ${failure.error}`
      )
    }
    return lines.join('\n\n')
  }

  private emitSubAgentUpdate(
    id: number,
    status: SubAgentStatus,
    model: string,
    result?: string | null,
    error?: string | null,
    conversationId?: string | null,
    compactions?: CompactionView[]
  ): void {
    const state = this.agent.state
    if (typeof state.onTimelineEvent === 'function') {
      const ctx = this.subAgents.get(id)
      const ev: Record<string, unknown> = {
        type: 'sub-agent',
        subAgentIdx: id,
        runId: this.runId,
        status,
        model,
        timestamp: nowStrftime('%H:%M:%S')
      }
      if (ctx !== undefined) {
        ev['task'] = ctx.task
        ev['effort'] = ctx.effort.displayName
        if (ctx.endTime !== null) {
          ev['duration'] = Math.max(0, Math.round((ctx.endTime - ctx.startTime) * 10) / 10)
        }
      }
      if (result !== undefined) ev['result'] = result
      if (error !== undefined) ev['error'] = error
      if (conversationId) ev['conversationId'] = conversationId
      const list =
        compactions !== undefined && compactions.length > 0
          ? compactions
          : this.compactionsByAgent.get(id)
      if (list !== undefined && list.length > 0) ev['compactions'] = list
      try {
        state.onTimelineEvent(ev)
      } catch {
        /* a timeline callback must never break a sub-agent */
      }
    }
  }
}

export default MultiAgentService
