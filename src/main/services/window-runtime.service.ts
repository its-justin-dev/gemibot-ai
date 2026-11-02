import { existsSync, writeFileSync } from 'fs'
import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { EffortLevel } from '../../shared/models/effort-level'
import type { FileDiff } from '../../shared/models/file-diff'
import { KeyboardInterrupt, PythonError, errorMessage } from '../../shared/utils/exceptions'
import { stripAnsi } from '../../shared/utils/ansi'
import { pyFormatFixed, pyFormatThousands } from '../../shared/utils/pyformat'
import { nowStrftime } from '../../shared/utils/strftime'
import { pySlice, pyStrip } from '../../shared/utils/pystr'
import { buildMemoryHistoryReport } from '../../shared/utils/memory-report'
import { buildSettingsReport } from '../../shared/utils/settings-report'
import { cleanApiKey } from '../../shared/utils/api-key'
import {
  compactionDividerEvent,
  compactionFinalEvent,
  compactionRunningEvent
} from '../../shared/utils/compaction-event'
import type { ApiKeyInfo, ApiKeyResult } from '../../shared/types/api-key'
import type { BuildModeSetting } from '../../shared/types/build'
import { isBuildFeedback } from '../../shared/utils/build-intent'
import type {
  CompactionResult,
  CompactionStartInfo,
  CompactionView,
  ContextUsage
} from '../../shared/types/compaction'
import type {
  ConversationSummary,
  ThinkingState,
  TimelineEventPayload,
  WindowAction,
  WindowCommand,
  WindowEvent,
  WindowSnapshot
} from '../../shared/types/window'
import type { TimelineEvent } from '../models/agent-state'
import { ReviewController } from '../controllers/review-controller.service'
import { out, setShowImpl, type ShowFn } from '../utils/console-out'
import { pyPathName } from '../utils/fs-path'
import { checkInternet } from '../utils/net-check'
import { killProcessTree, pyNewlines, shellReturncode, spawnShell } from '../utils/py-subprocess'
import { apiKeyInfo, saveApiKey } from './api-key.service'
import { getDbPath } from './database.service'
import { tokenUsageRepository } from './token-usage.service'
import { DiffService } from './diff.service'
import { EffortMapper } from './effort-mapper.service'
import type { Agent } from './agent.service'
import { MultiAgentService } from './multi-agent.service'
import { BuildRuntimeService } from './build-runtime.service'
import { detectDependencyPlan } from './project-deps.service'
import {
  conversationPersistence,
  eventFromRow,
  storedContentIndex,
  type ConversationPersistence
} from './conversation-persistence.service'
import type { CompactionRow, ConversationListItem, MessageRow } from './conversation-repository.service'
import {
  conversationToJson,
  conversationToMarkdown,
  exportFileName
} from './conversation-export.service'
import type { CatalogItem, ModelDetail } from './model-catalog.service'
import {
  DEFAULT_FONT_CFG,
  DEFAULT_SCALE_LABEL,
  FONT_SIZE_MAP,
  MODE_OPTIONS,
  WindowCatalogs
} from './window-catalogs.service'

export interface WindowTransport {
  emit(event: WindowEvent): void
  readLine(prompt: string): Promise<string | null>
  permission(tool: string, detail: string): Promise<boolean | 'always'>
  cancelPermission(): void
  confirmClear(): Promise<boolean>
  browseDirectory(defaultPath: string, title: string): Promise<string>
  writeClipboard(text: string): void
  openPath(path: string): Promise<string>
  quit(): void
  saveConversationFile?(defaultName: string, format: 'md' | 'json'): Promise<string | null>
  openDataFolder?(): Promise<void>
}

const BULLET = '  \u2022  '
const HISTORY_PAGE_SIZE = 100

interface PersistOptions {
  contentIndex?: number | null
  hidden?: boolean
}

const WELCOME_MESSAGE =
  'Hey bro! Welcome to **GemiBot AI**.\n\n' +
  "I'm ready with full multimodal access, terminal execution, and automatic memory logging in " +
  'the conversation database.\n\n' +
  'Ask me anything, have me write or edit code, or run direct commands!'

interface CapturedShell {
  stdout: string
  stderr: string
  rc: number
}

function runCaptured(command: string, cwd: string, timeout = 120): Promise<CapturedShell> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (command === '') {
      resolvePromise({ stdout: '', stderr: '', rc: 0 })
      return
    }
    const child = spawnShell(command, cwd)
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessTree(child, 'SIGKILL')
      rejectPromise(
        new PythonError('TimeoutExpired', `Command '${command}' timed out after ${timeout} seconds`)
      )
    }, timeout * 1000)

    child.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(err)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        stdout: pyNewlines(Buffer.concat(outChunks).toString('utf-8')),
        stderr: pyNewlines(Buffer.concat(errChunks).toString('utf-8')),
        rc: shellReturncode(code, signal)
      })
    })
  })
}

const MAX_INSTALL_OUTPUT = 3000

function commandOutput(result: CapturedShell): string {
  const text = pyNewlines(stripAnsi(pyStrip(`${result.stdout}\n${result.stderr}`)))
    .trim()
    .replaceAll('```', "'''")
  if (text.length <= MAX_INSTALL_OUTPUT) return text
  return `...(truncated)...\n${text.slice(-MAX_INSTALL_OUTPUT)}`
}

export class WindowRuntime {
  private isGenerating = false
  /** True between an accepted send and the moment its turn starts; closes the send race. */
  private isStarting = false
  /** Guards overlapping conversation switches so a slower, older load cannot win. */
  private displayEpoch = 0
  private cancelRequested = false
  private queue: string[] = []
  private pendingSendNow: string | null = null
  private status = { text: '● READY', color: '#10b981' }
  private fontSize: number
  private scale: number
  private scaleLabel: string
  private readonly agent: Agent
  private readonly transport: WindowTransport
  private readonly catalogs: WindowCatalogs
  private readonly diffService: DiffService
  private readonly reviewController: ReviewController
  private pickerItems: ModelDetail[] | null = null
  private pickerPrewarm: NodeJS.Timeout | null = null
  private multiAgent: MultiAgentService | null = null
  private isMultiAgentRunning = false
  private readonly buildRuntime: BuildRuntimeService
  private isBuildRunning = false
  private depsInstalling = false
  private readonly persistence: ConversationPersistence
  private uiReady = false
  private loadedHistoryStartId: number | null = null
  private loadedHistoryHasMore = false
  private loadingOlder = false
  private readonly compactionRowIds = new Map<string, number>()
  private readonly subAgentRowIds = new Map<number, number>()

  private get currentConversationId(): string | null {
    return this.persistence.conversationId
  }

  static async create(agent: Agent, transport: WindowTransport): Promise<WindowRuntime> {
    const savedSettings = await agent.settings.readSettingsDict()
    const savedScaleLabel = savedSettings['ui_scale_label'] ?? DEFAULT_SCALE_LABEL
    const initialCfg = FONT_SIZE_MAP.get(savedScaleLabel) ?? DEFAULT_FONT_CFG
    let available: CatalogItem[]
    try {
      available = agent.cli.availableModels()
    } catch {
      const catalog = AppConstants.MODEL_CATALOG as Record<string, string>
      available = AppConstants.MODELS.map((modelId) => [modelId, catalog[modelId] ?? ''])
    }
    const catalogs = new WindowCatalogs(available, agent.model)
    const runtime = new WindowRuntime(
      agent,
      transport,
      catalogs,
      savedScaleLabel,
      initialCfg[0],
      initialCfg[1]
    )
    // Apply multi-agent settings from persisted preferences.
    const maEnabled = savedSettings['multi_agent_enabled'] === 'true'
    const maMax = parseInt(savedSettings['multi_agent_max_sub_agents'] ?? '4', 10) || 4
    runtime.multiAgent?.setEnabled(maEnabled)
    runtime.multiAgent?.setMaxSubAgents(maMax)
    // Restore the conversation that was open when the app last closed.  This runs before the
    // renderer asks for its first frame, so `snapshot()` already reports the restored timeline.
    await runtime.hydrateLastConversation()
    await runtime.buildRuntime.init(savedSettings)
    return runtime
  }

  private constructor(
    agent: Agent,
    transport: WindowTransport,
    catalogs: WindowCatalogs,
    scaleLabel: string,
    fontSize: number,
    scale: number
  ) {
    this.agent = agent
    this.transport = transport
    this.catalogs = catalogs
    this.scaleLabel = scaleLabel
    this.fontSize = fontSize
    this.scale = scale

    this.diffService = new DiffService(agent.state.root, agent.changeTracker.store)
    this.reviewController = new ReviewController({
      tracker: agent.changeTracker,
      diffService: this.diffService,
      onClose: () => this.onReviewPanelClose()
    })
    this.persistence = conversationPersistence
    this.persistence.setErrorReporter((message, details) => {
      out(`\n${C.RED}${message}${C.RESET} ${C.DIM}${details}${C.RESET}`)
      // Emitted directly: routing this through emit() would try to save the error to the same
      // store that just failed, and loop.
      this.transport.emit({
        kind: 'error',
        title: 'Database error',
        message: `${message} This chat is not being saved.`,
        details,
        icon: '⚠️',
        header: this.errorHeader()
      })
    })

    const state = agent.state
    state.onContentAdded = (content) => {
      this.persistence.appendContent(content)
    }
    state.onContentsTruncated = (length, compactionReset) => {
      this.persistence.truncateContents(length)
      if (!compactionReset) return
      // Compactions whose split survived the rollback still describe valid history.
      const latest = this.persistence.invalidateCompactionsAboveSplit(length)
      if (latest !== null) {
        state.historySummary = latest.summary
        state.compactionSplitIndex = latest.split_content_index
      }
    }
    agent.setCompactionStore(this.persistence)
    agent.setCompactionCallbacks({
      onStart: (info) => this.onCompactionStart(info),
      onFinish: (result) => this.onCompactionFinish(result),
      onNotice: (text, isError) => this.onCompactionNotice(text, isError)
    })
    agent.onUsageRecorded = () => this.syncContextUsage()
    const originalOnTimeline = state.onTimelineEvent
    state.onTimelineEvent = (event) => {
      const ev = event as Record<string, unknown>
      if (ev.type === 'sub-agent') {
        // One row per sub-agent: the first event is stored, later ones replace it in place.
        const idx = ev.subAgentIdx as number
        const existing = this.subAgentRowIds.get(idx)
        if (existing === undefined) {
          const dbId = this.emit({ kind: 'action', event })
          if (dbId !== null) this.subAgentRowIds.set(idx, dbId)
        } else {
          this.persistence.updateActionEvent(existing, event)
          this.transport.emit({ kind: 'action', event })
        }
      } else {
        // Emit as action event for timeline rendering (reuses existing ActionRow widget).
        this.emit({ kind: 'action', event })
      }
      // Also emit multi-agent specific events for store tracking.
      if (ev.type === 'sub-agent') {
        this.transport.emit({
          kind: 'multi-agent-sub-agent-update',
          subAgentIdx: ev.subAgentIdx as number,
          status: ev.status as string,
          result: ev.result as string | undefined,
          error: ev.error as string | undefined,
          model: ev.model as string,
          compactions: ev.compactions as CompactionView[] | undefined
        })
      }
      if (typeof originalOnTimeline === 'function') {
        try {
          originalOnTimeline(event)
        } catch {}
      }
    }
    state.onPermission = (tool, detail) => this.requestPermissionDialog(tool, detail)
    // Deltas are live-only: they are never persisted, and the final assistant row replaces the
    // streaming row once the reply lands.
    state.onAssistantDelta = (delta) => {
      this.transport.emit({
        kind: 'assistant-delta',
        text: delta.text,
        ...(delta.reset === true ? { reset: true } : {}),
        timestamp: nowStrftime('%H:%M:%S')
      })
    }
    agent.changesController.setDrawerWidget({
      updateData: (summary) => this.transport.emit({ kind: 'changes', summary })
    })

    this.multiAgent = new MultiAgentService(
      agent,
      agent.memory,
      agent.system,
      agent.settings,
      agent.paths,
      async () => null,
      this.persistence,
      () => this.currentConversationId,
      async (prompt) => await this.turnWorker(prompt)
    )

    this.buildRuntime = new BuildRuntimeService({
      agent,
      multiAgent: () => this.multiAgent,
      conversationId: () => this.currentConversationId,
      onState: (view) => {
        if (view !== null && view.milestones.length > 0) {
          this.agent.state.todos = this.buildRuntime.todos()
        }
        if (this.uiReady) this.emit({ kind: 'build-state', view })
      },
      onMode: (mode) => {
        if (this.uiReady) this.emit({ kind: 'build-mode', mode })
      },
      onNotice: (text) => this.pill(text, '\u{1F3D7}\uFE0F'),
      onFinalReport: (report) => this.assistant(report, 'Build report'),
      onTodos: (todos) => {
        this.agent.state.todos = todos
      }
    })
  }

  snapshot(): WindowSnapshot {
    this.uiReady = true
    if (this.pickerPrewarm === null) {
      this.pickerPrewarm = setTimeout(() => this.prewarmModelPicker(), 300)
    }
    return {
      history: this.latestTimeline(),
      stats: this.statsEvents(),
      pendingChanges: this.agent.changeTracker.getSummary(),
      isGenerating: this.isGenerating,
      status: { ...this.status },
      funcOptions: this.catalogs.funcOptions(),
      modelOptions: this.catalogs.modelOptions(),
      fontScaleOptions: [...FONT_SIZE_MAP.keys()],
      modeOptions: MODE_OPTIONS,
      fontScaleLabel: this.scaleLabel,
      fontScaleSize: this.fontSize,
      widgetScale: this.scale,
      targetEntry: this.agent.state.root,
      multiAgent: this.agent.multiAgentState,
      conversations: this.conversationSummaries(),
      activeConversationId: this.currentConversationId,
      hasMoreHistory: this.loadedHistoryHasMore,
      queue: [...this.queue],
      contextUsage: this.currentContextUsage(),
      build: this.buildRuntime.view,
      buildMode: this.buildRuntime.mode
    }
  }

  private currentContextUsage(): ContextUsage | null {
    try {
      const usage = this.agent.contextUsage()
      const conversationId = this.currentConversationId
      if (conversationId === null) return usage
      return { ...usage, tokenUsage: tokenUsageRepository.totals(conversationId) }
    } catch {
      return null
    }
  }

  private syncContextUsage(): void {
    if (!this.uiReady) return
    this.emit({ kind: 'context-usage', usage: this.currentContextUsage() })
  }

  /** No renderer yet, so this may only fill RAM; it must not emit events. */
  private async hydrateLastConversation(): Promise<void> {
    const last = this.persistence.last()
    if (!last || typeof last.id !== 'string' || last.id === '') return
    const contents = this.persistence.contents(last.id)
    await this.adoptConversation(last.id, contents)
    this.queue = this.persistence.loadQueue(last.id)
    const page = this.persistence.page(null, HISTORY_PAGE_SIZE)
    this.failInterruptedCompactions(page.rows)
    this.loadedHistoryStartId = page.rows.length > 0 ? page.rows[0].id : null
    this.loadedHistoryHasMore = page.hasMore
  }

  /**
   * A stored Running card without a live compactor means the previous process died mid-summary.
   * No summary was applied, so the card is settled as failed while the history stays untouched.
   */
  private failInterruptedCompactions(rows: MessageRow[]): void {
    if (this.agent.isCompacting()) return
    for (const row of rows) {
      const event = eventFromRow(row)
      if (event?.kind !== 'action') continue
      const payload = event.event as Record<string, unknown>
      if (payload['tool'] !== 'compact_conversation' || payload['status'] !== 'Running') continue
      const args = (payload['args'] ?? {}) as Record<string, unknown>
      this.persistence.updateActionEvent(row.id, {
        ...payload,
        status: 'Failed',
        is_error: true,
        output: 'Compaction interrupted by app restart. The original history is intact.',
        args: { ...args, error: 'Interrupted by app restart' }
      })
    }
  }

  private async adoptConversation(
    conversationId: string,
    contents: ReturnType<ConversationPersistence['contents']>,
    epoch?: number
  ): Promise<boolean> {
    this.persistence.use(conversationId)
    // Commands that are already in flight must not act on the previous conversation's queue
    // while this switch is still rebuilding checkpoints.
    this.queue = []
    this.pendingSendNow = null
    const state = this.agent.state
    state.conversationId = conversationId
    state.contents = contents
    state.undoStack = []
    state.lastRoutedModel = null
    const latest = this.persistence.latestCompaction(conversationId)
    state.historySummary = latest?.summary ?? this.persistence.getSummary(conversationId)
    state.compactionSplitIndex =
      latest === null ? 0 : Math.max(0, Math.min(latest.split_content_index, contents.length))
    state.requestDigest = null
    // Rebuilt so the stats bar reports the stored turn count and an older prompt still has a
    // checkpoint to roll back to.
    const checkpoints = await this.agent.session.rebuildCheckpointsFromContents(state)
    // A slower, earlier switch must not overwrite the checkpoints of a later one.
    if (epoch !== undefined && epoch !== this.displayEpoch) return false
    state.checkpoints = checkpoints
    return true
  }

  private latestTimeline(): WindowEvent[] {
    const page = this.persistence.page(null, HISTORY_PAGE_SIZE)
    if (page.rows.length === 0) {
      this.loadedHistoryStartId = null
      this.loadedHistoryHasMore = false
      return [this.assistantEvent(WELCOME_MESSAGE)]
    }
    this.loadedHistoryStartId = page.rows[0].id
    this.loadedHistoryHasMore = page.hasMore
    return this.timelineFromRows(page.rows)
  }

  private timelineFromRows(rows: MessageRow[]): WindowEvent[] {
    const dividers = new Map<number, CompactionRow>()
    for (const record of this.persistence.listCompactions()) {
      if (record.status !== 'success') continue
      const existing = dividers.get(record.first_kept_message_id)
      if (existing === undefined || existing.id < record.id) {
        dividers.set(record.first_kept_message_id, record)
      }
    }
    const events: WindowEvent[] = []
    for (const row of rows) {
      const divider = dividers.get(row.id)
      if (divider !== undefined) {
        events.push({
          kind: 'compaction-divider',
          beforeDbId: row.id,
          event: this.compactionDividerPayload(divider)
        })
      }
      const event = eventFromRow(row)
      if (event === null) continue
      if (event.kind === 'user' && event.dbId === undefined) event.dbId = row.id
      events.push(event)
    }
    return events
  }

  private compactionDividerPayload(record: CompactionRow): TimelineEventPayload {
    return compactionDividerEvent(
      {
        trigger: record.trigger,
        messagesSummarized: record.messages_summarized_count,
        tokensBefore: record.tokens_before,
        tokensAfter: record.tokens_after
      },
      nowStrftime('%H:%M:%S', new Date(record.created_at))
    )
  }

  private conversationSummaries(): ConversationSummary[] {
    return this.persistence.list(false, 200).map((item) => this.conversationSummary(item))
  }

  private conversationSummary(item: ConversationListItem): ConversationSummary {
    return {
      id: item.id,
      title: item.title,
      updatedAt: item.updated_at,
      preview: item.preview,
      messageCount: item.message_count,
      subAgentCount: item.sub_agent_count,
      parentId: item.parent_conversation_id
    }
  }

  /** Rendering may not have happened yet in headless runs; those must stay event-silent. */
  private broadcastConversations(activeId: string | null = this.currentConversationId): void {
    if (!this.uiReady) return
    this.emit({ kind: 'conversations', items: this.conversationSummaries(), activeId })
  }

  private emit(event: WindowEvent, options: PersistOptions = {}): number | null {
    const dbId = this.persistEvent(event, options)
    if (dbId !== null && event.kind === 'user' && event.dbId === undefined) {
      event.dbId = dbId
    }
    this.journalChatEvent(event)
    this.transport.emit(event)
    return dbId
  }

  /**
   * Every rendered chat row is stored with the exact event the renderer folded, so reopening the
   * conversation replays the same widgets instead of guessing from a transcript.  The routed model
   * is used rather than `agent.model`, because a ladder fallback may have answered this turn.
   */
  private persistEvent(event: WindowEvent, options: PersistOptions): number | null {
    if (this.currentConversationId === null) return null
    const state = this.agent.state
    const model = state.lastRoutedModel ?? this.agent.model
    const effortLevel = this.agent.effortLevel?.displayName
    switch (event.kind) {
      case 'user':
        return this.persistence.recordEvent(event, {
          cpIdx: event.cpIdx,
          contentIndex: options.contentIndex,
          model: this.agent.model,
          effortLevel,
          hidden: options.hidden
        })
      case 'assistant':
        return this.persistence.recordEvent(event, {
          contentIndex: options.contentIndex,
          model,
          effortLevel
        })
      case 'action':
        return this.persistence.recordEvent(event, {
          contentIndex: options.contentIndex ?? state.contents.length,
          model,
          effortLevel
        })
      case 'pill':
      case 'error':
        return this.persistence.recordEvent(event, { model, effortLevel })
      default:
        return null
    }
  }

  /**
   * Part 1 of the conversation journal mirrors the timeline UI, so the panels the user acts on
   * - pills, error cards, the review queue - are teed here instead of being re-derived in the
   * turn engine. Chat text itself is recorded where the turn engine produces it.
   */
  private journalChatEvent(event: WindowEvent): void {
    const journal = this.agent.state.journal
    if (journal === null) return
    if (event.kind === 'pill') journal.record(`Notice ${event.icon}`, event.text)
    else if (event.kind === 'error') {
      journal.record(`Error: ${event.title}`, `${event.message}\n\n${event.details}`.trim())
    } else if (event.kind === 'review-panel') {
      journal.record(
        'Changes Needing Review',
        event.changes.map((c) => `${c.change_type}: ${c.path}`).join('\n')
      )
    }
  }

  private effortPart(): string | null {
    const controller = this.agent.modelController
    if (controller === null || !controller.supportsThinking(this.agent.model)) return null
    const effort = this.agent.effortLevel
    return effort ? `${effort.icon} ${effort.displayName}` : null
  }

  private timeTag(): string {
    return nowStrftime('%H:%M:%S')
  }

  private assistantHeader(meta: string, timestamp: string): string {
    const parts = [this.agent.model]
    const effort = this.effortPart()
    if (effort) parts.push(effort)
    parts.push(timestamp)
    if (meta) parts.push(meta)
    return parts.join(BULLET)
  }

  private userHeader(timestamp: string): string {
    return ['You', timestamp].join(BULLET)
  }

  private errorHeader(): string {
    return [this.agent.model, this.timeTag()].join(BULLET)
  }

  private thinking(): ThinkingState {
    const init = [this.agent.model]
    const effort = this.effortPart()
    if (effort) init.push(effort)
    return { init: init.join(BULLET), parts: [...init, `fn:${this.agent.state.activeFunction}`] }
  }

  private assistantEvent(text: string, meta = ''): WindowEvent {
    const timestamp = this.timeTag()
    return {
      kind: 'assistant',
      text,
      meta,
      header: this.assistantHeader(meta, timestamp),
      timestamp
    }
  }

  private userEvent(text: string, cpIdx: number | null): WindowEvent {
    const timestamp = this.timeTag()
    return { kind: 'user', text, cpIdx, header: this.userHeader(timestamp), timestamp }
  }

  private assistant(text: string, meta = ''): void {
    this.emit(this.assistantEvent(text, meta))
  }

  private user(
    text: string,
    cpIdx: number | null = null,
    contentIndex: number | null = null,
    hidden = false
  ): void {
    this.emit(this.userEvent(text, cpIdx), { contentIndex, hidden })
  }

  private pill(text: string, icon = 'ℹ️'): void {
    this.emit({ kind: 'pill', text, icon })
  }

  private compactionRunningEvent(info: CompactionStartInfo): TimelineEvent {
    return compactionRunningEvent(info, this.timeTag())
  }

  private compactionFinalEvent(result: CompactionResult): TimelineEvent {
    return compactionFinalEvent(result, this.timeTag())
  }

  private onCompactionStart(info: CompactionStartInfo): void {
    const dbId = this.emit({ kind: 'action', event: this.compactionRunningEvent(info) })
    if (dbId !== null) this.compactionRowIds.set(info.key, dbId)
    this.setStatus('● COMPACTING...', '#3b82f6')
  }

  private onCompactionFinish(result: CompactionResult): void {
    const dbId = this.compactionRowIds.get(result.key) ?? null
    this.compactionRowIds.delete(result.key)
    const event = this.compactionFinalEvent(result)
    const context = this.currentContextUsage()
    if (dbId !== null) {
      this.persistence.updateActionEvent(dbId, event)
      this.transport.emit({
        kind: 'compaction-update',
        dbId,
        event,
        context
      })
    } else {
      this.transport.emit({ kind: 'compaction-update', dbId: 0, event, context })
    }
    if (result.status === 'success' && result.firstKeptMessageId > 0) {
      this.transport.emit({
        kind: 'compaction-divider',
        beforeDbId: result.firstKeptMessageId,
        event: compactionDividerEvent(
          {
            trigger: result.trigger,
            messagesSummarized: result.messagesSummarized,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter
          },
          this.timeTag()
        )
      })
    }
    this.setStatus(
      this.isGenerating || this.isMultiAgentRunning ? '● THINKING...' : '● READY',
      this.isGenerating || this.isMultiAgentRunning ? '#f59e0b' : '#22c55e'
    )
    this.syncContextUsage()
    // A manual compaction leaves the runtime idle. Advance a pending Send Now or the restored
    // queue now instead of waiting for an unrelated send.
    if (!this.isBusy()) {
      if (this.pendingSendNow) {
        const item = this.pendingSendNow
        this.pendingSendNow = null
        void this.beginQueuedTurn(item)
      } else {
        void this.processQueue()
      }
    }
  }

  private onCompactionNotice(text: string, isError: boolean): void {
    this.pill(text, isError ? '⚠️' : 'ℹ️')
  }

  /** Measures and (if needed) compacts before the next prompt is appended to the turn. */
  private async prepareCompaction(pendingText: string): Promise<void> {
    try {
      await this.agent.compactor.prepareBeforeTurn(pendingText)
    } catch (error) {
      this.pill(`Conversation compaction error: ${errorMessage(error)}`, '⚠️')
    }
    this.syncContextUsage()
  }

  private async runManualCompaction(): Promise<void> {
    // `/compact` is itself handled inside a send, so `isStarting` is true for that direct call
    // and must not reject it. A queued compact only runs when the runtime is otherwise idle.
    if (this.isTurnActive()) {
      this.pill('Cannot compact while the AI is working. Stop it first.', '⚠️')
      return
    }
    try {
      await this.agent.compactNow('manual')
    } catch (error) {
      this.pill(`Conversation compaction error: ${errorMessage(error)}`, '⚠️')
    }
    this.syncContextUsage()
  }

  private errorCard(title: string, message: string, details = '', icon = '⚠️'): void {
    this.emit({
      kind: 'error',
      title,
      message,
      details,
      icon,
      header: this.errorHeader()
    })
  }

  private modelDisplay(): string {
    return this.catalogs.modelIdToDisplay.get(this.agent.model) ?? this.agent.model
  }

  private modelButtonText(modelDisplay: string): string {
    const controller = this.agent.modelController
    return this.catalogs.modelButtonText(
      modelDisplay,
      controller !== null && controller.supportsThinking(this.agent.model),
      this.agent.effortLevel
    )
  }

  private configureModelButton(disp: string): void {
    this.emit({ kind: 'model-button', text: this.modelButtonText(disp) })
  }

  private syncEffortDisplay(): void {
    this.configureModelButton(this.modelDisplay())
  }

  private statsEvents(): WindowEvent[] {
    const state = this.agent.state
    const tok = state.tokensIn + state.tokensOut
    const tokStr = tok >= 1000 ? `${pyFormatFixed(tok / 1000, 1)}k` : `${tok}`
    const turns = state.checkpoints.length
    const currModelDisp = this.modelDisplay()
    const statsParts = [`Tokens: ${tokStr}`, `Turns: ${turns}`]

    if (currModelDisp && currModelDisp !== 'Select Model') {
      statsParts.push(`Model: ${currModelDisp}`)
      const controller = this.agent.modelController
      if (controller !== null && controller.supportsThinking(state.model)) {
        const effort = this.agent.effortLevel
        if (effort) statsParts.push(`Effort: ${effort.icon} ${effort.displayName}`)
      }
    }

    const currFnDisp =
      this.catalogs.funcCodeToDisplay.get(state.activeFunction) ?? state.activeFunction
    const projName = pyPathName(state.root) || state.root
    return [
      { kind: 'stats', text: statsParts.join(' | ') },
      { kind: 'mode', text: state.mode.toUpperCase() },
      { kind: 'function-menu', text: currFnDisp },
      { kind: 'model-button', text: this.modelButtonText(currModelDisp) },
      { kind: 'active-target', text: state.root },
      { kind: 'top-path', text: `\u{1F4C1} ${projName}  •  memory` }
    ]
  }

  private syncStats(): void {
    for (const event of this.statsEvents()) this.emit(event)
  }

  private setStatus(text: string, color: string): void {
    this.status = { text, color }
    this.emit({ kind: 'status', text, color })
  }

  private async sendMessage(raw: string): Promise<void> {
    const prompt = pyStrip(raw)
    if (!prompt) return

    // Build controls and requirement changes must not wait behind the build in the queue.
    if (this.isBuildRunning && /^\/buildmode\b/iu.test(prompt)) {
      this.ensureConversation(prompt)
      const contentIndex = this.agent.state.contents.length
      this.emit({ kind: 'input', text: '', focus: false })
      this.user(prompt, this.agent.checkpoints.length, contentIndex)
      await this.runBuildModeCommand(prompt.slice('/buildmode'.length).trim())
      return
    }
    if (this.isBuildRunning && this.buildRuntime.isRunning() && isBuildFeedback(prompt)) {
      this.ensureConversation(prompt)
      const contentIndex = this.agent.state.contents.length
      this.emit({ kind: 'input', text: '', focus: false })
      this.user(prompt, this.agent.checkpoints.length, contentIndex)
      const applied = await this.buildRuntime.revise(prompt)
      this.pill(
        applied
          ? 'Build feedback noted. The plan updates at the next safe checkpoint.'
          : 'The build could not accept that change.',
        applied ? '\u{1F3D7}\uFE0F' : '⚠️'
      )
      return
    }

    // While the AI is generating, queue messages instead of sending.  `isStarting` also queues
    // a send that arrives while an earlier one is still probing the network.
    if (this.isGenerating || this.isMultiAgentRunning || this.isStarting || this.agent.isCompacting()) {
      this.queue.push(prompt)
      this.saveQueue()
      this.emit({ kind: 'queue-add', text: prompt })
      return
    }

    // A queue restored from the database must keep FIFO order: a new prompt joins the back and
    // the head is delivered first instead of being overtaken.
    if (this.queue.length > 0) {
      this.queue.push(prompt)
      this.saveQueue()
      this.emit({ kind: 'queue-add', text: prompt })
      void this.processQueue()
      return
    }

    this.isStarting = true
    try {
      this.ensureConversation(prompt)
      const contentIndex = this.agent.state.contents.length
      this.emit({ kind: 'input', text: '', focus: false })
      const cpIdx = this.agent.checkpoints.length

      if (prompt.startsWith('/')) {
        this.user(prompt, cpIdx, contentIndex)
        await this.handleCommand(prompt)
        return
      }
      if (prompt.startsWith('!')) {
        this.user(prompt, cpIdx, contentIndex)
        this.runShellDirect(pySlice(prompt, 1).trim())
        return
      }

      // Build mode is checked before normal routing: a whole-system request, a plan approval or
      // a change to an awaiting plan must not be mistaken for a normal coding turn.
      const buildAction = this.buildRuntime.classify(prompt)
      if (buildAction !== 'none') {
        this.user(prompt, cpIdx, contentIndex)
        if (!(await checkInternet())) {
          this.errorCard(
            'No Internet Connection',
            'Error: No internet connection. Please check your network connection and try again.',
            'Network probe failed. No active internet route or DNS resolution.',
            '❌'
          )
          this.pill('Error: No internet connection', '❌')
          return
        }
        void this.runBuildAction(buildAction, prompt)
        return
      }

      // Compaction costs a model call, so it waits for the internet probe. When it is needed the
      // user row is held back until the compaction row can be emitted ahead of it; an ordinary
      // send keeps the v1 event order (input, user, then probe).
      const needsCompaction = this.agent.compactor.shouldCompact(prompt)
      if (!needsCompaction) this.user(prompt, cpIdx, contentIndex)

      if (!(await checkInternet())) {
        if (needsCompaction) this.user(prompt, cpIdx, contentIndex)
        this.errorCard(
          'No Internet Connection',
          'Error: No internet connection. Please check your network connection and try again.',
          'Network probe failed. No active internet route or DNS resolution.',
          '❌'
        )
        this.pill('Error: No internet connection', '❌')
        out(`\n${C.RED}┃ Error: No internet connection${C.RESET}`)
        return
      }

      if (needsCompaction) {
        await this.prepareCompaction(prompt)
        this.user(prompt, cpIdx, contentIndex)
      }

      // Route to multi-agent orchestrator when enabled.
      if (this.multiAgent?.isEnabled()) {
        const plan = this.multiAgent.plan(prompt)
        this.isMultiAgentRunning = true
        this.isGenerating = true
        // A stop latches cancellation for the unwinding run; the next run must start cleanly.
        this.cancelRequested = false
        this.agent.state.cancelRequested = false
        this.setStatus(
          plan === null ? '● THINKING...' : '● MULTI-AGENT',
          plan === null ? '#f59e0b' : '#8b5cf6'
        )
        this.emit({ kind: 'generating', active: true, thinking: this.thinking() })
        if (plan !== null) {
          this.subAgentRowIds.clear()
          this.emit({
            kind: 'multi-agent-start',
            orchestratorModel: this.agent.model,
            totalSubTasks: plan.numAgents
          })
        }
        void this.multiAgent
          .orchestrate(prompt)
          .then(() => {
            this.isMultiAgentRunning = false
            this.isGenerating = false
            this.cancelRequested = false
            this.agent.state.cancelRequested = false
            this.setStatus('● READY', '#22c55e')
            this.subAgentRowIds.clear()
            this.emit({ kind: 'generating', active: false, thinking: null })
            this.emit({ kind: 'multi-agent-complete' })
            this.syncStats()
            this.syncContextUsage()
            // A "send now" that interrupted a previous turn takes priority over normal queue processing.
            if (this.pendingSendNow) {
              const item = this.pendingSendNow
              this.pendingSendNow = null
              void this.beginQueuedTurn(item)
            } else {
              this.processQueue()
            }
          })
          .catch((err) => {
            // Always reset multi-agent state on error so the app is never left stuck.
            this.isMultiAgentRunning = false
            this.isGenerating = false
            this.cancelRequested = false
            this.setStatus('● READY', '#22c55e')
            this.subAgentRowIds.clear()
            this.emit({ kind: 'generating', active: false, thinking: null })
            this.emit({ kind: 'multi-agent-complete' })
            this.syncStats()
            this.syncContextUsage()
            // A "send now" that was interrupted takes priority over normal queue processing.
            if (this.pendingSendNow) {
              const item = this.pendingSendNow
              this.pendingSendNow = null
              void this.beginQueuedTurn(item)
            } else {
              this.processQueue()
            }
            out(`\n${C.RED}Multi-agent error:${C.RESET} ${errorMessage(err)}${C.RESET}`)
          })
        return
      }

      // `startAgentTurn` flips `isGenerating` before its first await, so the guard above stays
      // closed once this function returns.
      void this.startAgentTurn(prompt, needsCompaction)
    } finally {
      this.isStarting = false
      // A send that queued while this one was still probing must not be stranded when the probe
      // fails or the prompt was a command. A started turn keeps this a no-op.
      if (this.pendingSendNow && !this.isGenerating && !this.isMultiAgentRunning) {
        const item = this.pendingSendNow
        this.pendingSendNow = null
        void this.beginQueuedTurn(item)
      } else {
        void this.processQueue()
      }
    }
  }

  private async runBuildAction(action: 'start' | 'resume' | 'approve' | 'revise', text: string): Promise<void> {
    if (this.isBuildRunning) return
    // Resume/approve can be clicked while an ordinary turn is running; starting a build then
    // would run two turn owners against the same conversation.
    if (this.isGenerating || this.isMultiAgentRunning || this.agent.isCompacting()) {
      this.pill('Wait for the current response to finish before changing the build.', '⚠️')
      return
    }
    this.isBuildRunning = true
    this.isGenerating = true
    this.cancelRequested = false
    this.setStatus('● BUILDING...', '#8b5cf6')
    this.emit({ kind: 'generating', active: true, thinking: this.thinking() })
    try {
      if (action === 'start') {
        await this.buildRuntime.startBuild(text)
      } else if (action === 'resume') {
        if (!(await this.buildRuntime.resume())) this.pill('No paused or failed build to resume.', 'ℹ️')
      } else if (action === 'approve') {
        if (!(await this.buildRuntime.approve())) this.pill('There is no plan waiting for approval.', 'ℹ️')
      } else {
        if (!(await this.buildRuntime.revise(text))) {
          this.pill('There is no active build to change.', 'ℹ️')
        }
      }
    } catch (error) {
      const message = errorMessage(error)
      this.errorCard('Build mode error', 'The build stopped before it could finish.', message, '⚠️')
      this.pill(`Build error: ${message}`, '❌')
    } finally {
      this.isBuildRunning = false
      this.isGenerating = false
      this.cancelRequested = false
      this.setStatus('● READY', '#22c55e')
      this.emit({ kind: 'generating', active: false, thinking: null })
      this.syncStats()
      this.syncContextUsage()
      if (this.pendingSendNow) {
        const item = this.pendingSendNow
        this.pendingSendNow = null
        void this.beginQueuedTurn(item)
      } else {
        this.processQueue()
      }
    }
  }

  private async openBuildDocs(): Promise<void> {
    const docs = await this.buildRuntime.docs()
    if (docs.docs.length === 0) {
      this.pill('No build docs yet. Start a build to create SPEC/ARCHITECTURE/PLAN/PROGRESS.', 'ℹ️')
      return
    }
    this.emit({ kind: 'build-docs', docs: docs.docs, open: true })
  }

  private async onBuildModeChange(mode: BuildModeSetting): Promise<void> {
    const next = await this.buildRuntime.setMode(mode)
    const labels: Record<BuildModeSetting, string> = {
      auto: 'automatic for whole-system requests',
      on: 'always for new systems',
      off: 'never (normal agent only)'
    }
    this.pill(`Build mode: ${next.toUpperCase()} (${labels[next]})`, '\u{1F3D7}\uFE0F')
  }

  private actionBuild(): void {
    const view = this.buildRuntime.view
    const lines = ['**Build Mode**', '', ...this.buildRuntime.summaryLines().map((line) => `- ${line}`)]
    if (view !== null) {
      lines.push('', `- Run: \`${view.id}\` — ${view.goal.slice(0, 240)}`)
    }
    lines.push(
      '',
      'Commands: `/buildmode on|off|auto`, `/buildmode status`, `/buildmode settings`, ' +
        '`/buildmode set <key> <value>`, `/buildmode pause|resume|stop|approve`, ' +
        '`/buildmode revise <change>`, `/buildmode docs`.'
    )
    this.assistant(lines.join('\n'), '/buildmode')
  }

  private async runBuildModeCommand(arg: string): Promise<void> {
    const raw = arg.trim()
    const parts = raw.split(/\s+/u)
    const verb = (parts[0] ?? '').toLowerCase()
    if (raw === '' || verb === 'status' || verb === 'settings') {
      this.actionBuild()
      return
    }
    if (verb === 'on' || verb === 'off' || verb === 'auto') {
      await this.onBuildModeChange(verb as BuildModeSetting)
      return
    }
    if (verb === 'set') {
      const key = parts[1] ?? ''
      const value = parts.slice(2).join(' ')
      if (key === '' || value === '') {
        this.pill('Usage: /buildmode set <key> <value>', '⚠️')
        return
      }
      try {
        const message = await this.buildRuntime.applySetting(key, value)
        this.pill(message, '\u{1F3D7}\uFE0F')
      } catch (error) {
        this.pill(errorMessage(error), '⚠️')
      }
      return
    }
    if (verb === 'pause') {
      if (this.buildRuntime.isRunning()) {
        this.buildRuntime.pause()
        this.pill('Build paused. Resume with /buildmode resume.', '⏸️')
      } else {
        this.pill('No running build to pause.', 'ℹ️')
      }
      return
    }
    if (verb === 'stop') {
      this.buildRuntime.stop()
      this.pill('Build stopped.', '⏹️')
      return
    }
    if (verb === 'resume') {
      if (this.buildRuntime.isRunning()) {
        this.pill('The build is already running.', 'ℹ️')
        return
      }
      void this.runBuildAction('resume', raw)
      return
    }
    if (verb === 'approve') {
      void this.runBuildAction('approve', raw)
      return
    }
    if (verb === 'revise') {
      const text = parts.slice(1).join(' ').trim()
      if (text === '') {
        this.pill('Usage: /buildmode revise <what should change>', '⚠️')
        return
      }
      if (this.buildRuntime.isRunning()) {
        const applied = await this.buildRuntime.revise(text)
        this.pill(
          applied
            ? 'Build feedback noted. The plan updates at the next safe checkpoint.'
            : 'The build could not accept that change.',
          applied ? '\u{1F3D7}\uFE0F' : '⚠️'
        )
        return
      }
      void this.runBuildAction('revise', text)
      return
    }
    if (verb === 'docs') {
      await this.openBuildDocs()
      return
    }
    this.pill(
      `Unknown build command "${verb}". Use on, off, auto, status, settings, set, pause, ` +
        'resume, stop, approve, revise or docs.',
      '⚠️'
    )
  }

  private runShellDirect(command: string): void {
    const suspicious = this.agent.tools.checkCommandPaths(command)
    if (suspicious.length > 0) {
      this.pill(`Warning: Command references paths outside target (${suspicious.join(', ')})`, '⚠️')
    }
    this.pill(`Running terminal command: ${command}`, '⚡')
    void this.runShellWorker(command)
  }

  private async runShellWorker(command: string): Promise<void> {
    try {
      const done = await runCaptured(command, this.agent.state.root)
      const text =
        pyStrip(`${done.stdout}${done.stderr}`) || `(Command exited with code ${done.rc})`
      this.assistant(text, `!${command}`)
    } catch (e) {
      this.assistant(errorMessage(e), 'Error')
    }
  }

  private async startAgentTurn(prompt: string, compactionPrepared = false): Promise<void> {
    this.isGenerating = true
    this.cancelRequested = false
    this.setStatus('● THINKING...', '#f59e0b')
    this.emit({ kind: 'generating', active: true, thinking: this.thinking() })
    out(`\n${C.BOLD}${C.BLUE}> ${prompt}${C.RESET}`)
    await this.turnWorker(prompt, compactionPrepared)
  }

  private async turnWorker(prompt: string, compactionPrepared = false): Promise<void> {
    const state = this.agent.state
    const origShow = setShowImpl(null)
    setShowImpl(this.guiShow(origShow))
    state.onError = (userMsg, rawErr) => {
      let title = 'Backend / API Error'
      let message = userMsg
      if (AppConstants.isNetworkError(rawErr)) {
        title = 'No Internet Connection'
        message =
          'Error: No internet connection. Please check your network connection and try again.'
      } else if (rawErr.includes('429')) {
        title = 'API Quota / Rate Limit Exceeded (429)'
      } else if (rawErr.includes('404')) {
        title = 'Model Not Found / Unsupported (404)'
      } else if (rawErr.includes('503') || rawErr.includes('UNAVAILABLE')) {
        title = 'Google API Service Unavailable (503)'
      } else if (rawErr.includes('API_KEY') || rawErr.includes('403')) {
        title = 'API Authentication / Permission Error'
      } else if (rawErr.includes('400')) {
        title = 'API Rejected The Request (400)'
      }
      this.errorCard(title, message, rawErr)
    }
    state.onToolError = (toolName, toolErr) => {
      this.errorCard(
        `Tool Call Rejected: ${toolName}`,
        `The '${toolName}' call was refused. The agent was given the reason and continues the turn.`,
        toolErr
      )
    }
    // `state.onTimelineEvent` is installed once in the constructor; it persists the action row and
    // forwards sub-agent updates, so a turn must not replace it.
    state.onPermission = (tool, detail) => this.requestPermissionDialog(tool, detail)

    try {
      await this.agent.turn(prompt, { compactionPrepared })
    } catch (e) {
      if (e instanceof KeyboardInterrupt) {
        this.pill('Generation stopped by user.', '⏹️')
      } else {
        const errStr = errorMessage(e)
        let title = 'Backend Exception'
        if (AppConstants.isNetworkError(errStr)) {
          this.errorCard(
            'No Internet Connection',
            'Error: No internet connection. Please check your network connection and try again.',
            'Network connection failed during request. Please check your connection and try again.',
            '❌'
          )
          this.pill('Error: No internet connection', '❌')
          return
        } else if (errStr.includes('429')) {
          title = 'API Rate Limit Exceeded (429)'
        } else if (errStr.includes('403') || errStr.includes('401')) {
          title = 'API Authentication / Key Error'
        }
        this.errorCard(title, 'An unhandled backend error occurred during execution.', errStr)
      }
    } finally {
      setShowImpl(origShow)
      this.onTurnFinished()
    }
  }

  private guiShow(origShow: ShowFn): ShowFn {
    return async (label, text, color, meta = '', escMonitor = null) => {
      this.assistant(text, meta)
      try {
        await origShow(label, text, color, meta, null)
      } catch {}
      if (escMonitor && this.cancelRequested) throw new KeyboardInterrupt()
    }
  }

  private onTurnFinished(): void {
    // Do not touch generating state while a multi-agent task is running;
    // the multi-agent completion handler manages state instead.
    if (this.isMultiAgentRunning) return

    this.isGenerating = false
    this.cancelRequested = false
    this.setStatus('● READY', '#22c55e')
    this.emit({ kind: 'generating', active: false, thinking: null })
    this.syncStats()
    this.syncContextUsage()
    // A "send now" that interrupted a previous turn takes priority over normal queue processing.
    if (this.pendingSendNow) {
      const item = this.pendingSendNow
      this.pendingSendNow = null
      void this.beginQueuedTurn(item)
    } else {
      this.processQueue()
    }
  }

  private ensureConversation(titleSource?: string): string | null {
    if (this.currentConversationId !== null && this.persistence.exists()) {
      return this.currentConversationId
    }
    const state = this.agent.state
    const id = this.persistence.start('New Conversation', titleSource)
    state.conversationId = id
    state.contents = []
    state.checkpoints = []
    state.undoStack = []
    state.lastRoutedModel = null
    state.historySummary = null
    state.compactionSplitIndex = 0
    state.requestDigest = null
    this.loadedHistoryStartId = null
    this.loadedHistoryHasMore = false
    this.queue = []
    this.pendingSendNow = null
    this.broadcastConversations(id)
    this.syncContextUsage()
    return id
  }

  private saveQueue(): void {
    this.persistence.saveQueue(this.queue)
  }

  /** A prompt that was waiting in the queue becomes a normal turn, with its own timeline row. */
  private async beginQueuedTurn(text: string): Promise<void> {
    if (this.isStarting) return
    this.ensureConversation(text)
    const cpIdx = this.agent.checkpoints.length
    // The composer is cleared when a message is queued, so clearing it here would wipe a draft
    // typed while the previous response was still running.
    if (text.startsWith('/')) {
      this.user(text, cpIdx, this.agent.state.contents.length)
      await this.handleCommand(text)
      // A command is not a turn, so nothing else will advance the queue.
      void this.processQueue()
      return
    }
    if (text.startsWith('!')) {
      this.user(text, cpIdx, this.agent.state.contents.length)
      this.runShellDirect(pySlice(text, 1).trim())
      void this.processQueue()
      return
    }
    const buildAction = this.buildRuntime.classify(text)
    if (buildAction !== 'none') {
      this.user(text, cpIdx, this.agent.state.contents.length)
      // The probe can take a while; keep the runtime busy so a conversation switch or a second
      // prompt cannot land before the build actually starts.
      this.isStarting = true
      try {
        if (!(await checkInternet())) {
          this.errorCard(
            'No Internet Connection',
            'Error: No internet connection. Please check your network connection and try again.',
            'Network probe failed. No active internet route or DNS resolution.',
            '❌'
          )
          this.pill('Error: No internet connection', '❌')
          void this.processQueue()
          return
        }
        void this.runBuildAction(buildAction, text)
        return
      } finally {
        this.isStarting = false
      }
    }
    // The queued prompt waits for the previous turn to finish, then the same auto-compaction
    // rule runs before it is appended. `isStarting` closes the gap while that async work runs.
    const needsCompaction = this.agent.compactor.shouldCompact(text)
    this.isStarting = true
    try {
      if (needsCompaction) await this.prepareCompaction(text)
      this.user(text, cpIdx, this.agent.state.contents.length)
      void this.startAgentTurn(text, needsCompaction)
    } finally {
      this.isStarting = false
    }
  }

  private async processQueue(): Promise<void> {
    // A queued item may only start once the previous turn has fully released the runtime.
    if (
      this.isGenerating ||
      this.isBuildRunning ||
      this.isMultiAgentRunning ||
      this.isStarting ||
      this.agent.isCompacting()
    ) {
      return
    }
    if (this.queue.length === 0) return
    const nextMessage = this.queue.shift()
    if (nextMessage) {
      this.saveQueue()
      this.emit({ kind: 'queue-process', text: nextMessage })
      await this.beginQueuedTurn(nextMessage)
    }
  }

  private async handleQueueSendNow(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    // The single pending slot is consumed once. A second Send Now must not overwrite the first
    // message, which would drop it from both the queue and the database.
    if (this.pendingSendNow !== null) {
      this.pill('Another queued message is already sending next.', 'ℹ️')
      return
    }
    const item = this.queue[index]
    this.queue.splice(index, 1)
    this.saveQueue()
    this.emit({ kind: 'queue-delete', index })

    if (
      this.isGenerating ||
      this.isMultiAgentRunning ||
      this.isStarting ||
      this.agent.isCompacting()
    ) {
      // Interrupt the current response safely (same as Stop), then send this message next. While a
      // send is still probing there is no turn to interrupt, so only mark it as next; starting it
      // here would run a second turn underneath the probe.
      if (this.isGenerating || this.isMultiAgentRunning) this.stopGeneration()
      this.pendingSendNow = item
    } else {
      void this.beginQueuedTurn(item)
    }
  }

  private async handleQueueDelete(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    this.queue.splice(index, 1)
    this.saveQueue()
    this.emit({ kind: 'queue-delete', index })
  }

  private async handleQueueEdit(index: number, text: string): Promise<void> {
    if (index < 0 || index >= this.queue.length) return
    const cleaned = pyStrip(text)
    if (!cleaned) return
    this.queue[index] = cleaned
    this.saveQueue()
    this.emit({ kind: 'queue-edit', index, text: cleaned })
  }

  private stopGeneration(): void {
    // Stop every sub-agent, but leave the multi-agent flags set until `orchestrate()` actually
    // settles; clearing them here would let the queue start a second turn underneath it.
    const wasBuild = this.isBuildRunning
    if (wasBuild) this.buildRuntime.stop()
    const wasMultiAgent = this.isMultiAgentRunning
    if (wasMultiAgent && this.multiAgent) {
      this.multiAgent.stopAllSubAgents()
    }
    // Cancel the main agent turn (covers a simple fallback and the synthesis phase too).
    if (this.isGenerating || wasMultiAgent || wasBuild) {
      this.cancelRequested = true
      this.agent.state.cancelRequested = true
      this.agent.cancel()
      this.transport.cancelPermission()
      this.setStatus('● STOPPING...', '#ef4444')
    }
  }

  private async requestPermissionDialog(tool: string, detail: string): Promise<boolean | 'always'> {
    if (this.cancelRequested || this.agent.state.cancelRequested) return false
    return await this.transport.permission(tool, detail)
  }

  private async onAcceptAllChanges(): Promise<void> {
    try {
      const accepted = await this.agent.changesController.acceptAll()
      this.diffService.clearCache()
      if (accepted.length > 0) {
        this.pill(`Accepted all pending changes (${accepted.length} files kept).`, '✓')
        out(`\n${C.GREEN}✓ Accepted all pending changes (${accepted.length} files kept).${C.RESET}`)
      } else {
        this.pill('No pending changes to accept', '✗')
        out(`\n${C.YELLOW}No pending changes to accept.${C.RESET}`)
      }
    } catch (e) {
      this.pill('Error accepting changes', '✗')
      out(`\n${C.RED}Error accepting changes: ${errorMessage(e)}${C.RESET}`)
    }
  }

  private async onRejectAllChanges(): Promise<void> {
    try {
      const rejected = await this.agent.changesController.rejectAll()
      this.diffService.clearCache()
      if (rejected.length > 0) {
        this.pill(`Rejected all pending changes (${rejected.length} files restored).`, '↺')
        out(
          `\n${C.RED}✕ Rejected all pending changes (${rejected.length} files restored).${C.RESET}`
        )
      } else {
        this.pill('No pending changes to reject', '✗')
        out(`\n${C.YELLOW}No pending changes to reject.${C.RESET}`)
      }
    } catch (e) {
      this.pill('Error rejecting changes', '✗')
      out(`\n${C.RED}Error rejecting changes: ${errorMessage(e)}${C.RESET}`)
    }
  }

  private async onAcceptFileChange(relPath: string): Promise<void> {
    try {
      const result = await this.agent.changesController.acceptFile(relPath)
      this.diffService.clearCache()
      if (result) {
        this.pill(`Accepted change: ${relPath}`, '✓')
      } else {
        this.pill(`Failed to accept change: ${relPath}`, '✗')
        out(`\n${C.RED}Failed to accept file ${relPath}: operation returned False${C.RESET}`)
      }
    } catch (e) {
      this.pill(`Error accepting ${relPath}`, '✗')
      out(`\n${C.RED}Error accepting file: ${errorMessage(e)}${C.RESET}`)
    }
  }

  private async onRejectFileChange(relPath: string): Promise<void> {
    try {
      const result = await this.agent.changesController.rejectFile(relPath)
      this.diffService.clearCache()
      if (result) {
        this.pill(`Restored original file: ${relPath}`, '↺')
      } else {
        this.pill(`Failed to restore: ${relPath}`, '✗')
        out(`\n${C.RED}Failed to reject file ${relPath}: operation returned False${C.RESET}`)
      }
    } catch (e) {
      this.pill(`Error restoring ${relPath}`, '✗')
      out(`\n${C.RED}Error rejecting file: ${errorMessage(e)}${C.RESET}`)
    }
  }

  private openReviewPanel(): void {
    try {
      const changes = this.reviewController.openReviewPanel()
      if (!changes) return
      this.emit({ kind: 'review-panel', changes })
    } catch (e) {
      out(`\n${C.RED}Error opening review panel: ${errorMessage(e)}${C.RESET}`)
    }
  }

  private onReviewPanelClose(): void {
    this.emit({ kind: 'changes', summary: this.agent.changeTracker.getSummary() })
    this.diffService.clearCache()
  }

  private async handleMultiAgentStart(): Promise<void> {
    // `sendMessage` already announces the start when the planner actually runs sub-agents, and it
    // owns the completion handler that clears the flags. Acting on this legacy command would mark
    // a run that never settles and strand the queue, so it stays deliberately inert.
    return
  }

  private handleMultiAgentStop(_subAgentIdx?: number): void {
    if (!this.multiAgent) return
    // Same path as the stop button: sub-agents are cancelled and the completion handler resets
    // the flags, so the queue cannot start while the orchestrator is still unwinding.
    this.stopGeneration()
  }

  async getFileDiff(relPath: string): Promise<FileDiff | null> {
    return await this.reviewController.getFileDiff(relPath)
  }

  exportMeta(): { project: string; model: string } {
    return { project: this.agent.state.root, model: this.agent.model }
  }

  getApiKeyInfo(): ApiKeyInfo {
    return apiKeyInfo()
  }

  async applyApiKey(raw: string): Promise<ApiKeyResult> {
    const result = await saveApiKey(raw)
    if (!result.ok) return result
    this.agent.setApiKey(cleanApiKey(raw))
    this.pill(`API key updated: ${apiKeyInfo().masked} - saved and used from now on.`, '\u{1F511}')
    return result
  }

  private writeTimelineExport(path: string, content: string): void {
    try {
      const text = process.platform === 'win32' ? content.replaceAll('\n', '\r\n') : content
      writeFileSync(path, text, 'utf8')
      this.pill(`Exported timeline activity to ${pyPathName(path)}`, '📥')
    } catch (e) {
      this.pill(`Export failed: ${errorMessage(e)}`, '⚠️')
    }
  }

  private async handleCommand(cmdLine: string): Promise<void> {
    const cleanCmd = cmdLine.trim().toLowerCase()
    if (['/accept', 'accept', '/accept_all'].includes(cleanCmd)) {
      await this.onAcceptAllChanges()
      return
    }
    if (['/reject', 'reject', '/reject_all'].includes(cleanCmd)) {
      await this.onRejectAllChanges()
      return
    }
    if (['/changes', 'changes', '/pending'].includes(cleanCmd)) {
      this.emit({ kind: 'expand-changes' })
      return
    }
    if (['/clear', 'clear', '/11'].includes(cleanCmd)) {
      await this.actionClear(true)
      return
    }
    if (['/compact', 'compact'].includes(cleanCmd)) {
      await this.runManualCompaction()
      return
    }
    if (cleanCmd === '/token' || cleanCmd.startsWith('/token ')) {
      await this.runTokenCommand(cmdLine.trim().slice('/token'.length).trim())
      return
    }
    if (cleanCmd === '/buildmode' || cleanCmd.startsWith('/buildmode ')) {
      await this.runBuildModeCommand(cmdLine.trim().slice('/buildmode'.length).trim())
      return
    }
    // `/init` runs a real agent turn from inside the command handler. Track it as generation so
    // Stop works, sends queue behind it, and the runtime cannot start a second turn meanwhile.
    const runsTurn = cleanCmd === '/init'
    if (runsTurn) {
      this.isGenerating = true
      this.cancelRequested = false
      this.agent.state.cancelRequested = false
      this.setStatus('● THINKING...', '#f59e0b')
      this.emit({ kind: 'generating', active: true, thinking: this.thinking() })
    }
    try {
      const res = await this.agent.command(cmdLine)
      this.syncStats()
      this.emit({ kind: 'target-entry', text: this.agent.state.root })
      this.pill(`Executed command: ${cmdLine}`)
      if (res === 'exit') this.transport.quit()
    } finally {
      if (runsTurn) this.onTurnFinished()
    }
  }

  private async runAction(name: WindowAction): Promise<void> {
    switch (name) {
      case 'todos':
        return await this.actionTodos()
      case 'settings':
        return await this.actionSettings()
      case 'undo':
        return await this.actionUndo()
      case 'revert':
        return await this.actionRevert()
      case 'memory':
        return await this.actionMemory()
      case 'pip':
        return await this.actionPip()
      case 'usage':
        return this.actionUsage()
      case 'token':
        return this.actionToken()
      case 'clear':
        return await this.actionClear()
    }
  }

  private actionTodos(): void {
    const todos = this.agent.todos
    if (todos.length === 0) {
      this.pill('Tasks: No active todos.')
      return
    }
    const lines = ['Active Tasks:']
    for (const t of todos) {
      const status = (t.status as string) ?? 'pending'
      const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '→' : '•'
      lines.push(`  [${icon}] ${(t.content as string) ?? ''} (${status})`)
    }
    this.assistant(lines.join('\n'), '/todos')
  }

  private async actionUndo(): Promise<void> {
    if (this.agent.state.undoStack.length === 0) {
      this.pill('Undo: Nothing to undo.')
      return
    }
    await this.agent.undo()
    this.diffService.clearCache()
    this.pill('Reverted the last file change.', '↩️')
    this.syncStats()
  }

  private async actionRevert(): Promise<void> {
    const state = this.agent.state
    if (state.checkpoints.length === 0) {
      this.pill('Revert: No checkpoints available.')
      return
    }
    const targetIdx = Math.max(0, state.checkpoints.length - 1)
    const cp = state.checkpoints[targetIdx]
    while (state.undoStack.length > ((cp.undo_len as number) ?? 0)) {
      await this.agent.session.popAndRestoreFile(state)
    }
    state.truncateContents((cp.contents_len as number) ?? 0)
    state.checkpoints = state.checkpoints.slice(0, targetIdx)
    await this.agent.buildSystem()
    this.diffService.clearCache()
    this.pill(`Reverted to checkpoint #${targetIdx + 1}`, '⏪')
    this.syncStats()
  }

  private async actionSettings(): Promise<void> {
    const settings = await this.agent.settings.readSettingsDict()
    const storage = this.agent.settings.storageInfo()
    const behavior = this.agent.behaviorConfig()
    this.assistant(
      buildSettingsReport({
        settings,
        database: getDbPath(),
        scope: storage.scope,
        behavior: {
          responseStyle: behavior.responseStyle,
          deepMode: behavior.deepMode,
          maxSteps: behavior.maxSteps,
          streaming: behavior.streamResponses && this.agent.state.streamingAllowed
        }
      }),
      '/settings'
    )
  }

  private async actionMemory(): Promise<void> {
    const storage = await this.agent.memory.storageInfo()
    const text = await this.agent.readMemoryContent()
    this.assistant(
      buildMemoryHistoryReport({ text, database: getDbPath(), documentKey: storage.key }),
      '/memory'
    )
  }

  private async actionPip(): Promise<void> {
    if (this.depsInstalling) {
      this.pill('Dependency installation is already running.', 'ℹ️')
      return
    }

    const root = this.agent.state.root
    const detected = detectDependencyPlan(root)
    if (!detected.ok) {
      if (detected.reason === 'missing-package-json') {
        this.assistant(
          [
            '# Install Project Dependencies',
            '',
            'No package.json was found in the workspace.',
            '',
            `- Workspace: ${root}`,
            '- Supported projects: npm, pnpm, yarn and bun',
            '- Fix: point the WORKSPACE card at a Node.js or TypeScript project.'
          ].join('\n'),
          '/libraries'
        )
        this.pill('No package.json found in the workspace.', '⚠️')
        return
      }
      this.depsFailure(detected.message)
      return
    }

    const plan = detected.plan
    this.depsInstalling = true
    this.pill(`Installing project dependencies with ${plan.manager}...`, '\u{1F4E6}')
    const startedAt = Date.now()
    try {
      const probe = await runCaptured(`${plan.manager} --version`, root, 30)
      if (probe.rc !== 0) {
        this.depsFailure(
          `${plan.manager} is not available on PATH.`,
          commandOutput(probe) || `Install ${plan.manager} and reopen GemiBot.`
        )
        return
      }

      const result = await runCaptured(plan.command, root, 900)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (result.rc !== 0) {
        this.depsFailure(
          `${plan.command} exited with code ${result.rc}.`,
          commandOutput(result) || 'No output was captured.'
        )
        return
      }

      const output = commandOutput(result)
      const lines = [
        '# Project Dependencies Installed',
        '',
        `- Workspace: ${root}`,
        `- Package manager: ${plan.manager} (${plan.source})`,
        `- Command: ${plan.command}`,
        `- Duration: ${seconds}s`
      ]
      if (output !== '') lines.push('', '## Output', '```text', output, '```')
      this.assistant(lines.join('\n'), '/libraries')
      this.pill(`Project dependencies installed with ${plan.manager}.`, '✅')
    } catch (error) {
      this.depsFailure(errorMessage(error))
    } finally {
      this.depsInstalling = false
    }
  }

  private depsFailure(message: string, details = ''): void {
    this.errorCard('Dependency installation failed', message, details, '❌')
    this.pill(`Dependency installation failed: ${message}`, '❌')
  }

  private actionUsage(): void {
    const conversationId = this.currentConversationId
    const summary = conversationId === null ? null : tokenUsageRepository.summary(conversationId, 3)
    const usage = this.agent.contextUsage()
    const compaction = this.agent.compactionConfig()
    const count = (value: number): string => pyFormatThousands(value)
    const total = this.agent.tokensIn + this.agent.tokensOut
    const lines = [
      '# Session Token Usage',
      '',
      '## Session',
      `- Input tokens: ${count(this.agent.tokensIn)}`,
      `- Output tokens: ${count(this.agent.tokensOut)}`,
      `- Total tokens: ${count(total)}`,
      `- Current model: ${this.agent.model}`
    ]

    const controller = this.agent.modelController
    if (controller !== null && controller.supportsThinking(this.agent.model)) {
      const effort = this.agent.effortLevel
      lines.push(`- Reasoning effort: ${effort.icon} ${effort.displayName}`)
    }

    if (summary !== null) {
      lines.push('', '## This conversation')
      if (summary.requests === 0) {
        lines.push('- No model requests logged yet.')
      } else {
        const estimated =
          summary.estimatedRequests > 0 ? ` (${count(summary.estimatedRequests)} estimated)` : ''
        lines.push(`- Requests: ${count(summary.requests)}${estimated}`)
        const cached =
          summary.inputTokens > 0
            ? ` · cached ${count(summary.cachedTokens)} ` +
              `(${Math.round((summary.cachedTokens / summary.inputTokens) * 100)}%)`
            : ''
        lines.push(`- Input tokens: ${count(summary.inputTokens)}${cached}`)
        const thought =
          summary.thoughtTokens > 0 ? ` · thinking ${count(summary.thoughtTokens)}` : ''
        lines.push(`- Output tokens: ${count(summary.outputTokens)}${thought}`)
        lines.push(`- Total tokens: ${count(summary.totalTokens)}`)
        lines.push(
          `- Average per request: ` +
            `${count(Math.round(summary.inputTokens / summary.requests))} in / ` +
            `${count(Math.round(summary.outputTokens / summary.requests))} out`
        )
      }

      if (summary.byModel.length > 0) {
        lines.push('', '## By model')
        for (const group of summary.byModel.slice(0, 5)) {
          const cached = group.cachedTokens > 0 ? ` · ${count(group.cachedTokens)} cached` : ''
          const thought = group.thoughtTokens > 0 ? ` · ${count(group.thoughtTokens)} thinking` : ''
          lines.push(
            `- ${group.key || 'unknown'}: ${count(group.requests)} req · ` +
              `${count(group.inputTokens)} in / ${count(group.outputTokens)} out` +
              `${cached}${thought}`
          )
        }
      }

      if (summary.bySender.length > 0) {
        lines.push('', '## By sender')
        for (const group of summary.bySender.slice(0, 5)) {
          lines.push(
            `- ${group.key || 'other'}: ${count(group.requests)} req · ` +
              `${count(group.inputTokens)} in / ${count(group.outputTokens)} out`
          )
        }
      }

      if (summary.biggest.length > 0) {
        lines.push('', '## Biggest requests')
        for (const row of summary.biggest) {
          const label = row.label || row.kind
          const time = nowStrftime('%H:%M:%S', new Date(row.createdAt))
          lines.push(
            `- ${label} · ${row.model} · ${count(row.inputTokens)} in / ` +
              `${count(row.outputTokens)} out · ${time}`
          )
        }
      }
    }

    lines.push('', '## Context window')
    const windowNote =
      usage.limitTokens !== usage.budgetTokens ? ` (model window ${count(usage.limitTokens)})` : ''
    lines.push(`- Request budget: ${count(usage.budgetTokens)} tokens${windowNote}`)
    lines.push(`- Used: ${count(usage.usedTokens)} tokens (${usage.percent}% of budget)`)
    lines.push(
      compaction.enabled
        ? `- Auto-compaction: at ${compaction.thresholdPercent}% → target ` +
            `${compaction.targetPercent}% (keeps ${compaction.recentMessages} recent turns)`
        : '- Auto-compaction: off (manual only)'
    )

    this.assistant(lines.join('\n'), '/usage')
  }

  private actionToken(): void {
    const conversationId = this.currentConversationId
    const summary = tokenUsageRepository.summary(conversationId, 5)
    const settings = this.agent.tokenConfig()
    const compaction = this.agent.compactionConfig()
    const usage = this.agent.contextUsage()
    const onOff = (value: boolean): string => (value ? 'on' : 'off')
    const count = (value: number): string => pyFormatThousands(value)
    const lines = ['# Token Usage & Limits']

    lines.push('', conversationId === null ? '## All conversations' : '## This conversation')
    if (conversationId === null) lines.push('- No active conversation.')
    if (summary.requests === 0) {
      lines.push('- No model requests logged yet.')
    } else {
      const estimated =
        summary.estimatedRequests > 0 ? ` (${count(summary.estimatedRequests)} estimated)` : ''
      lines.push(`- Requests: ${count(summary.requests)}${estimated}`)
      lines.push(`- Input tokens: ${count(summary.inputTokens)}`)
      lines.push(
        summary.inputTokens > 0
          ? `- Cached tokens: ${count(summary.cachedTokens)} ` +
              `(${Math.round((summary.cachedTokens / summary.inputTokens) * 100)}% of input)`
          : `- Cached tokens: ${count(summary.cachedTokens)}`
      )
      lines.push(`- Output tokens: ${count(summary.outputTokens)}`)
      if (summary.thoughtTokens > 0) {
        lines.push(`- Thinking tokens: ${count(summary.thoughtTokens)}`)
      }
      lines.push(`- Total tokens: ${count(summary.totalTokens)}`)
      lines.push(
        `- Average per request: ` +
          `${count(Math.round(summary.inputTokens / summary.requests))} in / ` +
          `${count(Math.round(summary.outputTokens / summary.requests))} out`
      )
    }

    lines.push('', '## Context window', `- Model: ${this.agent.model}`)
    const windowNote =
      usage.limitTokens !== usage.budgetTokens ? ` (model window ${count(usage.limitTokens)})` : ''
    lines.push(`- Request budget: ${count(usage.budgetTokens)} tokens${windowNote}`)
    lines.push(`- Used: ${count(usage.usedTokens)} tokens (${usage.percent}% of budget)`)
    lines.push(
      compaction.enabled
        ? `- Auto-compaction: at ${compaction.thresholdPercent}% → target ` +
            `${compaction.targetPercent}% · keeps ${compaction.recentMessages} recent turns`
        : '- Auto-compaction: off (manual only)'
    )

    if (summary.byModel.length > 0) {
      lines.push('', '## By model')
      for (const group of summary.byModel.slice(0, 5)) {
        const cached = group.cachedTokens > 0 ? ` · ${count(group.cachedTokens)} cached` : ''
        const thought = group.thoughtTokens > 0 ? ` · ${count(group.thoughtTokens)} thinking` : ''
        lines.push(
          `- ${group.key || 'unknown'}: ${count(group.requests)} req · ` +
            `${count(group.inputTokens)} in / ${count(group.outputTokens)} out` +
            `${cached}${thought}`
        )
      }
    }

    if (summary.bySender.length > 0) {
      lines.push('', '## By sender')
      for (const group of summary.bySender.slice(0, 5)) {
        lines.push(
          `- ${group.key || 'other'}: ${count(group.requests)} req · ` +
            `${count(group.inputTokens)} in / ${count(group.outputTokens)} out`
        )
      }
    }

    if (summary.biggest.length > 0) {
      lines.push('', '## Biggest requests')
      for (const row of summary.biggest) {
        const label = row.label || row.kind
        const time = nowStrftime('%H:%M:%S', new Date(row.createdAt))
        lines.push(
          `- ${label} · ${row.model} · ${count(row.inputTokens)} in / ` +
            `${count(row.outputTokens)} out · ${time}`
        )
      }
    }

    const mixture = summary.biggest.find((row) => row.breakdown !== null)
    if (mixture !== undefined && mixture.breakdown !== null) {
      const breakdown = mixture.breakdown
      const parts: Array<[string, number]> = [
        ['System prompt', breakdown.system],
        ['Memory', breakdown.memory],
        ['Conversation summary', breakdown.summary],
        ['History', breakdown.history],
        ['Tool definitions', breakdown.toolDefinitions],
        ['Tool results', breakdown.toolResults],
        ['Tool calls', breakdown.toolCalls],
        ['New message', breakdown.newMessage],
        ['Media', breakdown.media],
        ['Other', breakdown.other]
      ]
      const mixTotal = parts.reduce((sum, [, value]) => sum + value, 0)
      if (mixTotal > 0) {
        const time = nowStrftime('%H:%M:%S', new Date(mixture.createdAt))
        lines.push(
          '',
          '## Request breakdown (estimated)',
          `- ${mixture.label || mixture.kind} · ${mixture.model} · ${time}`,
          `- Estimated input: ${count(mixTotal)} tokens`
        )
        for (const [name, value] of parts
          .filter(([, value]) => value > 0)
          .sort((left, right) => right[1] - left[1])) {
          lines.push(`- ${name}: ${count(value)} (${Math.round((value / mixTotal) * 100)}%)`)
        }
      }
    }

    lines.push(
      '',
      '## Token settings',
      `- Memory: ${
        settings.maxMemoryChars === 0 ? 'no app cap' : `${count(settings.maxMemoryChars)} chars`
      } · relevance selection ${onOff(settings.memoryRelevance)}`,
      `- Tool output: ${
        settings.maxToolOutputChars === 0
          ? 'no app cap'
          : `${count(settings.maxToolOutputChars)} chars`
      }`,
      `- Slim tool schemas: ${onOff(settings.slimTools)} · read-result reuse: ` +
        `${onOff(settings.reuseReadResults)} · loop guard: ${onOff(settings.loopGuard)}`,
      `- Output limit: ${
        settings.maxOutputTokens === 0
          ? 'provider default'
          : `${count(settings.maxOutputTokens)} tokens`
      }`,
      `- Small-job model: ${settings.cheapModel}`,
      `- Compaction summarizer: ${compaction.summarizerModel}`,
      '',
      '## Change settings',
      '- Memory budget: /token memory 12000',
      '- Tool output limit: /token tools 12000',
      '- Slim tool schemas: /token slim on|off',
      '- Relevance selection: /token relevance on|off',
      '- Read-result reuse: /token cache on|off',
      '- Loop guard: /token loop on|off',
      '- Output limit: /token output 0|N',
      '- Small-job model: /token cheap <model>',
      '- Summarizer model: /token summarizer <model>',
      '- Auto-compaction threshold: /token threshold 50-95',
      '- Reset token settings: /token reset'
    )
    this.assistant(lines.join('\n'), '/token')
  }

  private async runTokenCommand(arg: string): Promise<void> {
    const outcome = await this.agent.runTokenCommand(arg)
    if (outcome.kind === 'view') {
      this.actionToken()
      return
    }
    if (outcome.kind === 'error') {
      this.pill(outcome.message, '⚠️')
      return
    }
    this.pill(outcome.message)
  }

  private async actionClear(fromCommand = false): Promise<void> {
    // A direct `/clear` is handled inside its own send, so `isStarting` is true there. From the
    // toolbar it still protects an in-flight probe.
    if (fromCommand ? this.isTurnActive() : this.isBusy()) {
      this.pill('Cannot clear the chat while the AI is working. Stop it first.', '⚠️')
      return
    }
    const confirmed = await this.transport.confirmClear()
    if (!confirmed) {
      this.pill('Clear cancelled by user.', 'ℹ️')
      return
    }
    // `/clear` starts a fresh conversation.  The previous one is kept in the database so it can
    // still be reopened or exported; only the live RAM window and its pending queue are dropped.
    const abandoned = this.currentConversationId
    if (abandoned !== null) {
      this.persistence.saveQueue([], abandoned)
      this.persistence.use(null)
    }
    this.queue = []
    this.pendingSendNow = null
    this.loadedHistoryStartId = null
    this.loadedHistoryHasMore = false
    const state = this.agent.state
    state.contents = []
    state.todos = []
    state.checkpoints = []
    state.undoStack = []
    state.lastRoutedModel = null
    state.historySummary = null
    state.compactionSplitIndex = 0
    state.requestDigest = null
    state.conversationId = null
    const memoryCleared = await this.agent.clearMemory()
    await this.agent.buildSystem()
    // The reducer clears both the chat and the queue for this event.
    this.emit({ kind: 'clear-chat' })
    this.syncStats()
    this.syncContextUsage()
    this.pill(
      memoryCleared
        ? 'Active chat and conversation memory cleared.'
        : 'Active chat cleared, but app memory could not be saved to the database.',
      memoryCleared ? '\u{1F9F9}' : '⚠️'
    )
    if (abandoned !== null) this.broadcastConversations(null)
  }

  private prewarmModelPicker(): void {
    try {
      const controller = this.agent.modelController
      if (controller === null) return
      if (this.pickerItems === null) this.pickerItems = controller.catalog.getAllDetails()
    } catch {}
  }

  private openModelPicker(): void {
    const controller = this.agent.modelController
    if (controller === null) return
    this.prewarmModelPicker()
    const items = this.pickerItems ?? []
    const currentModel = controller.currentModel
    this.emit({
      kind: 'model-picker',
      items,
      currentModel,
      currentEffort: controller.currentEffort.value,
      activeDisplay: controller.catalog.getModelInfo(currentModel).display,
      supportsThinking: EffortMapper.supportsThinking(controller.currentModel)
    })
  }

  private async onTargetApply(pathValue: string): Promise<void> {
    if (this.isBuildRunning) {
      this.emit({ kind: 'target-entry', text: this.agent.state.root })
      this.pill('Cannot change the target folder while a build is running. Stop it first.', '⚠️')
      return
    }
    const [ok, msg] = await this.agent.setTargetDirectory(pathValue)
    if (ok) {
      this.diffService.clearCache()
      this.emit({ kind: 'target-error', text: null })
      this.syncStats()
      this.buildRuntime.refresh()
      this.pill(`Target set to: ${this.agent.state.root}`, '\u{1F4C1}')
    } else {
      this.emit({ kind: 'target-error', text: msg })
      this.pill(`Target error: ${msg}`, '⚠️')
    }
  }

  private async onTargetBrowse(): Promise<void> {
    if (this.isBuildRunning) {
      this.pill('Cannot change the target folder while a build is running. Stop it first.', '⚠️')
      return
    }
    try {
      const chosen = await this.transport.browseDirectory(
        this.agent.state.root,
        'Select Target Project Directory'
      )
      if (chosen) {
        this.emit({ kind: 'target-entry', text: chosen })
        await this.onTargetApply(pyStrip(chosen))
      }
    } catch (e) {
      this.pill(`Browse error: ${errorMessage(e)}`, '⚠️')
    }
  }

  private async onTargetClear(): Promise<void> {
    if (this.isBuildRunning) {
      this.emit({ kind: 'target-entry', text: this.agent.state.root })
      this.pill('Cannot reset the target folder while a build is running. Stop it first.', '⚠️')
      return
    }
    await this.agent.setTargetDirectory('clear')
    this.diffService.clearCache()
    this.emit({ kind: 'target-entry', text: this.agent.state.root })
    this.emit({ kind: 'target-error', text: null })
    this.syncStats()
    this.buildRuntime.refresh()
    this.pill('Target reset to application default folder.', '↩️')
  }

  private async onModeChange(val: string): Promise<void> {
    const state = this.agent.state
    const mode = val.toLowerCase()
    state.mode = mode
    state.activeFunction = mode === 'plan' || mode === 'read' ? mode : 'all'
    await this.agent.buildSystem()
    await this.agent.saveSettings({ mode: state.mode, function_suite: state.activeFunction })
    this.syncStats()
    this.pill(`Mode switched to ${mode.toUpperCase()} (Suite: ${state.activeFunction})`)
  }

  private async onFunctionChangeDisplay(selectedDisplay: string): Promise<void> {
    const state = this.agent.state
    const funcCode = this.catalogs.funcDisplayToCode.get(selectedDisplay) ?? selectedDisplay
    if (funcCode === 'pip_installer') {
      await this.actionPip()
      this.syncStats()
      return
    }
    state.activeFunction = funcCode
    state.mode = ['build', 'plan', 'read'].includes(funcCode) ? funcCode : 'build'
    await this.agent.buildSystem()
    await this.agent.saveSettings({ function_suite: funcCode, mode: state.mode })
    this.syncStats()
    this.pill(`Suite activated: ${selectedDisplay} [${funcCode}]`)
  }

  private async onModelChangeDisplay(selectedDisplay: string): Promise<void> {
    const modelId = this.catalogs.modelDisplayToId.get(selectedDisplay) ?? selectedDisplay
    this.agent.model = modelId
    this.agent.state.pinned = true
    await this.agent.saveSettings({ model: modelId })
    if (this.agent.modelController) await this.agent.modelController.selectModel(modelId)
    if (this.agent.model !== selectedDisplay) this.configureModelButton(selectedDisplay)
    this.syncEffortDisplay()
    this.syncStats()
    this.syncContextUsage()
    this.pill(`AI Model changed: ${selectedDisplay} (${modelId})`)
  }

  private async onModelSelectedFromModal(modelId: string, displayName: string): Promise<void> {
    this.agent.model = modelId
    this.agent.state.pinned = true
    await this.agent.saveSettings({ model: modelId })
    if (this.agent.modelController) await this.agent.modelController.selectModel(modelId)
    this.configureModelButton(displayName)
    this.syncEffortDisplay()
    this.syncStats()
    this.syncContextUsage()
    this.pill(`AI Model changed: ${displayName} (${modelId})`)
  }

  private async onEffortSelectedFromModal(effortLevel: EffortLevel): Promise<void> {
    this.agent.effortLevel = effortLevel
    await this.agent.saveSettings({ effort_level: effortLevel.value })
    if (this.agent.modelController) await this.agent.modelController.selectEffortLevel(effortLevel)
    this.syncEffortDisplay()
    this.pill(
      `Reasoning Effort set to: ${effortLevel.icon} ${effortLevel.displayName} (${effortLevel.costHint})`
    )
  }

  private async onFontSizeChange(selectedLabel: string): Promise<void> {
    const [newSize, scale] = FONT_SIZE_MAP.get(selectedLabel) ?? DEFAULT_FONT_CFG
    this.fontSize = newSize
    this.scale = scale
    this.emit({ kind: 'font-scale', label: selectedLabel, size: newSize, scale })
    this.scaleLabel = selectedLabel
    await this.agent.saveSettings({ ui_scale: `${newSize}px`, ui_scale_label: selectedLabel })
    this.pill(`Applied UI font scale: ${newSize}px (${Math.trunc(scale * 100)}%)`, '\u{1F524}')
  }

  private async onEditUserMessage(
    text: string,
    cpIdx: number | null,
    rowId: number,
    dbId?: number
  ): Promise<void> {
    if (this.isGenerating) return
    // The renderer supplies the stored row id. A stale id from another conversation would make
    // clearFrom delete everything from that numeric position onward in the active conversation.
    const row =
      dbId !== undefined && this.currentConversationId !== null
        ? this.persistence.message(dbId)
        : null
    if (dbId !== undefined && this.currentConversationId !== null && row === null) {
      this.pill('That message is no longer in the conversation.', '⚠️')
      return
    }
    if (row !== null && row.conversation_id !== this.currentConversationId) {
      this.pill('That message belongs to another conversation.', '⚠️')
      return
    }
    const cut = row !== null ? storedContentIndex(row) : null
    this.emit({ kind: 'input', text, focus: true })
    if (cpIdx !== null && cpIdx >= 0 && cpIdx < this.agent.checkpoints.length) {
      await this.agent.rollbackToCheckpoint(cpIdx)
      this.pill(`Rolled back to prompt #${cpIdx + 1} for edit.`, '↩️')
      this.syncStats()
    }
    if (dbId !== undefined && row !== null) {
      // Never hide rows the store failed to delete; the error card already reports the failure.
      if (!this.persistence.clearFrom(dbId, cut)) return
      if (cut !== null) this.agent.state.truncateContents(cut)
      // Editing a prompt can remove messages a summary covered, so those records stop applying.
      const latest = this.persistence.invalidateCompactionsFrom(dbId)
      const state = this.agent.state
      if (
        latest !== null &&
        latest.split_content_index <= state.contents.length &&
        state.contents.length > 0
      ) {
        state.historySummary = latest.summary
        state.compactionSplitIndex = latest.split_content_index
      } else {
        state.historySummary = null
        state.compactionSplitIndex = 0
      }
      state.requestDigest = null
    }
    this.emit({ kind: 'truncate-chat', rowId })
    this.syncContextUsage()
  }

  /** Work that owns the live conversation; excludes the pre-turn network probe of a send. */
  private isTurnActive(): boolean {
    return (
      this.isGenerating ||
      this.isBuildRunning ||
      this.isMultiAgentRunning ||
      this.agent.isCompacting()
    )
  }

  private isBusy(): boolean {
    // A send that is still probing will start a turn against the live state, so a conversation
    // switch during that window would land the turn in the wrong conversation.
    return this.isTurnActive() || this.isStarting
  }

  private resetLiveConversationState(): void {
    const state = this.agent.state
    state.conversationId = null
    state.contents = []
    state.checkpoints = []
    state.undoStack = []
    state.lastRoutedModel = null
    state.historySummary = null
    state.compactionSplitIndex = 0
    state.requestDigest = null
    this.queue = []
    this.pendingSendNow = null
    this.loadedHistoryStartId = null
    this.loadedHistoryHasMore = false
  }

  private async displayConversation(conversationId: string | null): Promise<void> {
    const epoch = ++this.displayEpoch
    if (conversationId === null || !this.persistence.exists(conversationId)) {
      this.persistence.use(null)
      this.resetLiveConversationState()
      this.emit({
        kind: 'history-reset',
        events: [this.assistantEvent(WELCOME_MESSAGE)],
        hasMore: false
      })
      this.emit({ kind: 'queue-sync', items: [] })
      this.syncStats()
      this.syncContextUsage()
      this.broadcastConversations(null)
      this.buildRuntime.refresh()
      return
    }

    const contents = this.persistence.contents(conversationId)
    if (!(await this.adoptConversation(conversationId, contents, epoch))) return
    this.queue = this.persistence.loadQueue(conversationId)
    const page = this.persistence.page(null, HISTORY_PAGE_SIZE)
    this.loadedHistoryStartId = page.rows.length > 0 ? page.rows[0].id : null
    this.loadedHistoryHasMore = page.hasMore
    const events = this.timelineFromRows(page.rows)
    this.emit({
      kind: 'history-reset',
      events: events.length > 0 ? events : [this.assistantEvent(WELCOME_MESSAGE)],
      hasMore: page.hasMore
    })
    this.emit({ kind: 'queue-sync', items: [...this.queue] })
    this.syncStats()
    this.syncContextUsage()
    this.broadcastConversations(conversationId)
    this.buildRuntime.refresh()
  }

  private async onConversationNew(): Promise<void> {
    if (this.isBusy()) return
    await this.displayConversation(null)
  }

  private async onConversationOpen(id: string): Promise<void> {
    if (this.isBusy()) return
    await this.displayConversation(id)
  }

  private onConversationRename(id: string, title: string): void {
    const clean = pyStrip(title)
    if (!clean) return
    if (!this.persistence.rename(id, clean)) return
    this.broadcastConversations()
  }

  private async onConversationDelete(id: string): Promise<void> {
    if (this.isBusy()) return
    const wasActive = this.currentConversationId === id
    if (!this.persistence.remove(id)) return
    if (wasActive) {
      const last = this.persistence.last()
      const nextId = last !== null && typeof last.id === 'string' && last.id !== '' ? last.id : null
      await this.displayConversation(nextId)
      return
    }
    this.broadcastConversations()
  }

  private async onConversationExport(id: string, format: 'md' | 'json'): Promise<void> {
    const conversation = this.persistence.get(id)
    if (conversation === null) return
    const save = this.transport.saveConversationFile
    if (typeof save !== 'function') return
    const path = await save(exportFileName(conversation.title, format), format)
    if (path === null) return
    try {
      const messages = this.persistence.allMessages(id)
      const compactions = this.persistence.listCompactions(id)
      const content =
        format === 'json'
          ? conversationToJson(conversation, messages, compactions)
          : conversationToMarkdown(conversation, messages, compactions)
      const text = process.platform === 'win32' ? content.replaceAll('\n', '\r\n') : content
      writeFileSync(path, text, 'utf8')
      this.pill(`Exported conversation to ${pyPathName(path)}`, '📥')
    } catch (e) {
      this.pill(`Export failed: ${errorMessage(e)}`, '⚠️')
    }
  }

  private onLoadOlder(): void {
    if (this.loadingOlder) return
    if (!this.loadedHistoryHasMore || this.currentConversationId === null) return
    this.loadingOlder = true
    try {
      const page = this.persistence.page(this.loadedHistoryStartId, HISTORY_PAGE_SIZE)
      if (page.rows.length > 0) this.loadedHistoryStartId = page.rows[0].id
      this.loadedHistoryHasMore = page.hasMore
      this.emit({
        kind: 'history-prepend',
        events: this.timelineFromRows(page.rows),
        hasMore: page.hasMore
      })
    } finally {
      this.loadingOlder = false
    }
  }

  private async onOpenDataFolder(): Promise<void> {
    const open = this.transport.openDataFolder
    if (typeof open === 'function') await open()
  }

  private copyToClipboard(text: string): void {
    try {
      this.transport.writeClipboard(text)
      this.pill('Copied to clipboard!', '\u{1F4CB}')
    } catch (e) {
      this.pill(`Copy failed: ${errorMessage(e)}`, '⚠️')
    }
  }

  private async openFileInEditor(rel: string): Promise<void> {
    try {
      const full = await this.agent.resolvePath(rel)
      if (!existsSync(full)) {
        this.pill(`File not found: ${rel}`, '⚠️')
        return
      }
      const failure = await this.transport.openPath(full)
      if (failure) throw new Error(failure)
      this.pill(`Opened ${rel}`, '\u{1F4C2}')
    } catch (e) {
      this.pill(`Could not open file: ${errorMessage(e)}`, '⚠️')
    }
  }

  async dispatch(cmd: WindowCommand): Promise<void> {
    switch (cmd.cmd) {
      case 'send':
        return await this.sendMessage(cmd.text)
      case 'action':
        return await this.runAction(cmd.name)
      case 'compact':
        return await this.runManualCompaction()
      case 'stop': {
        this.stopGeneration()
        return
      }
      case 'accept-all':
        return await this.onAcceptAllChanges()
      case 'reject-all':
        return await this.onRejectAllChanges()
      case 'accept-file':
        return await this.onAcceptFileChange(cmd.path)
      case 'reject-file':
        return await this.onRejectFileChange(cmd.path)
      case 'review-open':
        return this.openReviewPanel()
      case 'review-panel-close':
        this.reviewController.onPanelDestroy()
        return
      case 'target-apply':
        return await this.onTargetApply(cmd.path)
      case 'target-browse':
        return await this.onTargetBrowse()
      case 'target-clear':
        return await this.onTargetClear()
      case 'mode-change':
        return await this.onModeChange(cmd.value)
      case 'function-change':
        return await this.onFunctionChangeDisplay(cmd.display)
      case 'model-change':
        return await this.onModelChangeDisplay(cmd.display)
      case 'model-picker':
        return this.openModelPicker()
      case 'model-selected':
        return await this.onModelSelectedFromModal(cmd.modelId, cmd.display)
      case 'effort-selected':
        return await this.onEffortSelectedFromModal(EffortLevel.fromString(cmd.value))
      case 'font-scale':
        return await this.onFontSizeChange(cmd.label)
      case 'edit-user':
        return await this.onEditUserMessage(cmd.text, cmd.cpIdx, cmd.rowId, cmd.dbId)
      case 'copy':
        return this.copyToClipboard(cmd.text)
      case 'copy-path':
        return this.copyToClipboard(await this.agent.resolvePath(cmd.rel))
      case 'open-file':
        return await this.openFileInEditor(cmd.rel)
      case 'export-timeline':
        return this.writeTimelineExport(cmd.path, cmd.content)
      case 'queue-add':
        // Handled by sendMessage() which pushes to this.queue and emits queue-add event
        return undefined
      case 'queue-process':
        // Process next queued message (handled by onTurnFinished / processQueue)
        return undefined
      case 'queue-delete':
        return await this.handleQueueDelete(cmd.index)
      case 'queue-edit':
        return await this.handleQueueEdit(cmd.index, cmd.text)
      case 'queue-send-now':
        return await this.handleQueueSendNow(cmd.index)
      case 'multi-agent-start':
        return await this.handleMultiAgentStart()
      case 'multi-agent-stop':
        return this.handleMultiAgentStop(cmd.subAgentIdx)
      case 'multi-agent-enable':
        if (this.multiAgent) {
          this.multiAgent.setEnabled(cmd.enabled)
          await this.agent.saveSettings({ multi_agent_enabled: String(cmd.enabled) })
          this.pill(`Multi-Agent mode ${cmd.enabled ? 'enabled' : 'disabled'}`, '\u{1F916}')
        }
        return
      case 'multi-agent-max':
        if (this.multiAgent) {
          this.multiAgent.setMaxSubAgents(cmd.max)
          await this.agent.saveSettings({
            multi_agent_max_sub_agents: String(this.multiAgent.getMaxSubAgents())
          })
          this.pill(`Max sub-agents set to ${this.multiAgent.getMaxSubAgents()}`, '\u{1F916}')
        }
        return
      case 'build-mode':
        return await this.onBuildModeChange(cmd.mode)
      case 'build-pause':
        if (this.buildRuntime.isRunning()) {
          this.buildRuntime.pause()
          this.pill('Build paused. Resume when ready.', '⏸️')
        } else {
          this.pill('No running build to pause.', 'ℹ️')
        }
        return
      case 'build-resume':
        void this.runBuildAction('resume', 'continue')
        return
      case 'build-stop':
        this.buildRuntime.stop()
        this.pill('Build stopped.', '⏹️')
        return
      case 'build-approve':
        void this.runBuildAction('approve', 'approve')
        return
      case 'build-revise':
        void this.runBuildAction('revise', cmd.text)
        return
      case 'build-docs':
        return await this.openBuildDocs()
      case 'build-docs-close':
        this.emit({ kind: 'build-docs', docs: [], open: false })
        return
      case 'build-setting':
        try {
          const message = await this.buildRuntime.applySetting(cmd.key, cmd.value)
          this.pill(message, '\u{1F3D7}\uFE0F')
        } catch (error) {
          this.pill(errorMessage(error), '⚠️')
        }
        return
      case 'conversation-new':
        return await this.onConversationNew()
      case 'conversation-open':
        return await this.onConversationOpen(cmd.id)
      case 'conversation-rename':
        return this.onConversationRename(cmd.id, cmd.title)
      case 'conversation-delete':
        return await this.onConversationDelete(cmd.id)
      case 'conversation-export':
        return await this.onConversationExport(cmd.id, cmd.format)
      case 'load-older':
        return this.onLoadOlder()
      case 'open-data-folder':
        return await this.onOpenDataFolder()
    }
  }
}
