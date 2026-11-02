import type { GenerateContentConfig } from '@google/genai'
import { readFile, stat } from 'fs/promises'
import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { EffortLevel } from '../../shared/models/effort-level'
import { errorMessage } from '../../shared/utils/exceptions'
import { pyStrip, pyStripChars } from '../../shared/utils/pystr'
import {
  behaviorSettingsFromDict,
  behaviorSettingsToDict,
  normalizeBehaviorSettings
} from '../../shared/utils/behavior-settings'
import type { BehaviorSettings, TaskComplexity } from '../../shared/types/behavior-settings'
import { ModelController } from '../controllers/model-controller.service'
import type { CatalogClient } from './model-catalog.service'
import { AgentState, type Checkpoint, type TimelineTurn, type Todo } from '../models/agent-state'
import type { Content } from '../models/content'
import { out } from '../utils/console-out'
import { pyExpandUser, pyResolve } from '../utils/fs-path'
import type { KeyPoll } from '../utils/esc-monitor'
import { ChangeTracker } from './change-tracker.service'
import { FileOperations } from './file-operations.service'
import { AgentGenerate } from './agent-generate.service'
import { AgentMemory } from './agent-memory.service'
import { AgentPaths } from './agent-paths.service'
import {
  AgentSession,
  type ChooseHook,
  type ChooseItem,
  type ChooseOptions
} from './agent-session.service'
import { AgentSettings, type CurrentPreferences } from './agent-settings.service'
import { AgentSystem } from './agent-system.service'
import { AgentTurn, type ToolExecutor } from './agent-turn.service'
import { ConversationJournal } from './conversation-journal.service'
import { AgentCli } from './agent-cli.service'
import { AiClient } from './ai-client.service'
import { tokenUsageRepository } from './token-usage.service'
import {
  normalizeTokenSettings,
  parseTokenCommand,
  tokenSettingsFromDict,
  tokenSettingsToDict,
  type TokenCommandParse
} from '../../shared/utils/token-settings'
import type { TokenSettings } from '../../shared/types/token-settings'
import { ChangesController } from '../controllers/changes-controller.service'
import { AgentTools } from '../tools/agent-tools.service'
import { COMPACTION_DEFAULTS } from '@shared/constants/context-windows'
import type { CompactionResult, CompactionSettings, CompactionTrigger, ContextUsage } from '@shared/types/compaction'
import {
  ConversationCompactor,
  type CompactionCallbacks,
  type CompactionStore
} from './conversation-compaction.service'
import type { MultiAgentSnapshot } from '@shared/types/window'

export interface AgentOptions {
  root: string
  model: string
  autoYes?: boolean
  pinned?: boolean
  apiKey?: string
  execute?: ToolExecutor
  choose?: ChooseHook
  keyPoll?: KeyPoll
  readLine?: (prompt: string) => Promise<string | null>
  /** Enables complexity routing, the final check and loop limits (window mode). */
  advancedAgent?: boolean
  /** Marks the surface as able to render live deltas; behavior settings still gate it. */
  streamResponses?: boolean
}

export class Agent {
  readonly state: AgentState
  readonly client: AiClient
  readonly memory: AgentMemory
  readonly settings: AgentSettings
  readonly paths: AgentPaths
  readonly system: AgentSystem
  readonly session: AgentSession
  readonly compactor: ConversationCompactor
  readonly generate: AgentGenerate
  readonly turnEngine: AgentTurn
  readonly journal: ConversationJournal
  changeTracker!: ChangeTracker
  fileOps!: FileOperations
  tools!: AgentTools
  changesController!: ChangesController
  cli!: AgentCli
  modelController: ModelController | null = null
  effortLevel: EffortLevel = EffortLevel.MEDIUM
  private compactionSettings: CompactionSettings = { ...COMPACTION_DEFAULTS }
  /** False until a summarizer is chosen, so the small-job model keeps driving compaction. */
  private summarizerExplicit = false
  private compactionStore: CompactionStore | null = null
  private compactionCallbacks: CompactionCallbacks = {}
  /** The user's model and effort while a complex request is routed to a stronger pair. */
  private routedModel: string | null = null
  private routedEffortActive = false
  /** Set by the window layer so the usage chip refreshes after every model request. */
  onUsageRecorded: (() => void) | null = null

  multiAgentState: MultiAgentSnapshot = {
    isActive: false,
    orchestratorModel: '',
    subAgents: [],
    activeSubAgentIdx: null,
    totalSubTasks: 0,
    completedSubTasks: 0
  }

  private readonly chooseHook: ChooseHook

  private readonly overrideExecute: ToolExecutor | null

  private constructor(opts: AgentOptions) {
    this.overrideExecute = opts.execute ?? null
    this.chooseHook = opts.choose ?? (async () => null)
    const appRoot = pyResolve(opts.root)
    this.state = new AgentState(appRoot, opts.model, opts.autoYes ?? false, opts.pinned ?? false)
    this.state.advancedAgent = opts.advancedAgent === true
    this.state.streamingAllowed = opts.streamResponses === true
    this.client = new AiClient(opts.apiKey ?? '')
    this.client.setUsageReporter((report) => {
      tokenUsageRepository.record(report)
      const notify = this.onUsageRecorded
      if (typeof notify === 'function') {
        try {
          notify()
        } catch {}
      }
    })
    this.memory = new AgentMemory(appRoot)
    this.journal = new ConversationJournal(this.memory.io())
    this.state.journal = this.journal
    this.settings = new AgentSettings(appRoot)
    this.paths = new AgentPaths(appRoot)
    this.system = new AgentSystem({
      paths: this.paths,
      memory: this.memory,
      modelController: () => this.modelController
    })
    this.compactor = new ConversationCompactor({
      state: this.state,
      client: this.client,
      system: this.system,
      settings: () => this.compactionSettings,
      store: () => this.compactionStore,
      callbacks: {
        onStart: (info) => this.compactionCallbacks.onStart?.(info),
        onFinish: (result) => this.compactionCallbacks.onFinish?.(result),
        onNotice: (text, isError) => this.compactionCallbacks.onNotice?.(text, isError)
      }
    })
    this.generate = new AgentGenerate(this.state, this.client, this.system, this.compactor)
    this.session = new AgentSession({
      paths: this.paths,
      memory: this.memory,
      buildSystem: () => this.buildSystem(),
      choose: this.chooseHook,
      onFileRestored: async (full) => {
        // Drop the drawer entry only when the restored bytes really match its snapshot; an
        // intermediate undo leaves a different version on disk, so the change is still pending.
        const tracker = this.changeTracker
        const rel = this.paths.rel(full)
        const change = tracker.pendingChanges.get(tracker.normalizePath(rel))
        if (!change) return
        const current = await readFile(full).catch(() => null)
        const original = change.snapshot_id
          ? await tracker.store.getSnapshotBytes(change.snapshot_id)
          : null
        const matches = change.original_exists
          ? current !== null && original !== null && current.equals(original)
          : current === null
        if (matches) await this.changesController.acceptFile(rel)
      }
    })
    this.turnEngine = new AgentTurn({
      state: this.state,
      paths: this.paths,
      memory: this.memory,
      system: this.system,
      settings: this.settings,
      generate: this.generate,
      compactor: this.compactor,
      execute: (name, args) => this.dispatch(name, args),
      choose: this.chooseHook,
      keyPoll: opts.keyPoll,
      journal: this.journal,
      effort: () =>
        (this.modelController?.effectiveEffort() ?? this.effortLevel).displayName,
      routeTask: (level) => this.routeTask(level),
      restoreRoute: () => this.restoreTaskRoute()
    })
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.overrideExecute) return await this.overrideExecute(name, args)
    return await this.tools.execute(name, args)
  }

  static async create(opts: AgentOptions): Promise<Agent> {
    const agent = new Agent(opts)
    await agent.memory.ensureMemory()
    await agent.settings.ensureSettings(agent.preferences())
    await agent.loadSettings()
    agent.state.system = await agent.system.buildSystem(agent.state)
    agent.changeTracker = await ChangeTracker.create(agent.state.root)
    agent.fileOps = new FileOperations(agent.state.root, agent.changeTracker)
    agent.changesController = new ChangesController(agent.changeTracker)
    agent.tools = new AgentTools({
      state: agent.state,
      paths: agent.paths,
      system: agent.system,
      generate: agent.generate,
      client: agent.client,
      fileOps: agent.fileOps,
      changeTracker: agent.changeTracker,
      readLine: opts.readLine
    })
    agent.modelController = await ModelController.create(
      agent.state.appRoot,
      agent.client.client as unknown as CatalogClient
    )
    if (!agent.state.pinned && agent.modelController.currentModel) {
      agent.state.model = agent.modelController.currentModel
    } else {
      await agent.modelController.selectModel(agent.state.model)
    }
    agent.effortLevel = agent.modelController.currentEffort
    agent.cli = new AgentCli(agent)
    return agent
  }

  preferences(): CurrentPreferences {
    return {
      model: this.state.model,
      activeFunction: this.state.activeFunction,
      mode: this.state.mode
    }
  }

  async loadSettings(): Promise<Record<string, string>> {
    const state = this.state
    const settings = await this.settings.readSettingsDict()
    state.tokenSettings = tokenSettingsFromDict(settings)
    state.behaviorSettings = behaviorSettingsFromDict(settings)
    const savedSummarizer = (settings['compaction_summarizer_model'] ?? '').trim()
    this.summarizerExplicit = savedSummarizer !== ''
    this.compactionSettings = {
      enabled: parseBoolSetting(settings['compaction_enabled'], COMPACTION_DEFAULTS.enabled),
      thresholdPercent: parseNumberSetting(
        settings['compaction_threshold'],
        COMPACTION_DEFAULTS.thresholdPercent
      ),
      targetPercent: parseNumberSetting(
        settings['compaction_target'],
        COMPACTION_DEFAULTS.targetPercent
      ),
      recentMessages: parseNumberSetting(
        settings['compaction_recent_messages'],
        COMPACTION_DEFAULTS.recentMessages
      ),
      summarizerModel: savedSummarizer !== '' ? savedSummarizer : state.tokenSettings.cheapModel
    }
    if (Object.keys(settings).length === 0) return settings

    if (!state.pinned && settings['model']) state.model = settings['model']
    if (settings['function_suite']) state.activeFunction = settings['function_suite']
    if (settings['mode']) state.mode = settings['mode']
    if (settings['effort_level']) {
      this.effortLevel = EffortLevel.fromString(settings['effort_level'])
      if (this.modelController) await this.modelController.selectEffortLevel(this.effortLevel)
    }

    const targetDir = (settings['target_directory'] ?? '').trim()
    if (targetDir) {
      try {
        const candidate = pyResolve(pyExpandUser(targetDir))
        if (await isDir(candidate)) {
          this.setRoot(candidate)
        } else {
          out(
            `\n  ${C.YELLOW}Warning: Saved target directory does not exist:${C.RESET} ${targetDir}`
          )
          out(`  ${C.GRAY}Defaulting target to application folder: ${state.appRoot}${C.RESET}\n`)
          this.setRoot(state.appRoot)
        }
      } catch (e) {
        out(
          `\n  ${C.YELLOW}Warning: Could not parse saved target directory (${errorMessage(e)}).${C.RESET}`
        )
        this.setRoot(state.appRoot)
      }
    } else {
      this.setRoot(state.appRoot)
    }
    return settings
  }

  private setRoot(root: string): void {
    this.state.root = root
    this.paths.setRoot(root)
  }

  /** File tracking must follow the project, or pending changes land under the old root. */
  private async rebindTarget(root: string): Promise<void> {
    this.setRoot(root)
    if (this.changeTracker) await this.changeTracker.setRoot(root)
    if (this.fileOps) this.fileOps.setRoot(root)
  }

  async saveSettings(updates: Record<string, string>): Promise<void> {
    await this.settings.saveSettings(updates)
  }

  async setTargetDirectory(targetPathStr: string): Promise<[ok: boolean, message: string]> {
    const cleanStr = pyStripChars(pyStrip(targetPathStr), '\'"')
    if (!cleanStr) return [false, 'No path provided. Usage: /target <path> or /target clear']

    if (['clear', 'reset', 'default'].includes(cleanStr.toLowerCase())) {
      await this.rebindTarget(this.state.appRoot)
      await this.saveSettings({ target_directory: '' })
      this.state.system = await this.buildSystem()
      return [
        true,
        `Target directory cleared. Defaulting to application folder:\n${this.state.root}`
      ]
    }

    let candidate: string
    try {
      candidate = pyResolve(pyExpandUser(cleanStr))
    } catch (e) {
      return [false, `Invalid path syntax: ${errorMessage(e)}`]
    }

    if (!(await exists(candidate))) return [false, `Target folder does not exist: ${candidate}`]
    if (!(await isDir(candidate))) return [false, `Path is not a directory: ${candidate}`]

    await this.rebindTarget(candidate)
    await this.saveSettings({ target_directory: candidate })
    this.state.system = await this.buildSystem()
    return [
      true,
      `Target directory updated successfully!\nActive Target: ${this.state.root}\n` +
        'Project context, file map and AGENTS.md reloaded.'
    ]
  }

  async buildSystem(): Promise<string> {
    this.state.system = await this.system.buildSystem(this.state)
    return this.state.system
  }

  /** The model catalog caches the client it was built with, so it has to follow the new key. */
  setApiKey(key: string): void {
    this.client.setApiKey(key)
    if (this.modelController) {
      this.modelController.catalog.client = this.client.client as unknown as CatalogClient
    }
  }

  config(): GenerateContentConfig {
    return this.system.config(this.state)
  }

  tree(depth = 2, limit = 120): string {
    return this.system.tree(this.state.root, depth, limit)
  }

  async turn(userText: string, options?: { compactionPrepared?: boolean }): Promise<void> {
    await this.turnEngine.turn(userText, options)
  }

  compactionConfig(): CompactionSettings {
    return this.compactor.settings()
  }

  async updateCompactionSettings(updates: Partial<CompactionSettings>): Promise<void> {
    const next: CompactionSettings = { ...this.compactionSettings, ...updates }
    const normalized = {
      enabled: next.enabled,
      thresholdPercent: Math.max(50, Math.min(95, Math.round(next.thresholdPercent))),
      targetPercent: Math.max(10, Math.min(80, Math.round(next.targetPercent))),
      recentMessages: Math.max(2, Math.min(50, Math.round(next.recentMessages))),
      summarizerModel: next.summarizerModel
    }
    if (updates.summarizerModel !== undefined) this.summarizerExplicit = true
    this.compactionSettings = normalized
    await this.saveSettings({
      compaction_enabled: normalized.enabled ? 'true' : 'false',
      compaction_threshold: String(normalized.thresholdPercent),
      compaction_target: String(normalized.targetPercent),
      compaction_recent_messages: String(normalized.recentMessages),
      ...(this.summarizerExplicit
        ? { compaction_summarizer_model: normalized.summarizerModel }
        : {})
    })
  }

  setCompactionStore(store: CompactionStore): void {
    this.compactionStore = store
  }

  setCompactionCallbacks(callbacks: CompactionCallbacks): void {
    this.compactionCallbacks = callbacks
  }

  contextUsage(model = this.state.model, pendingText?: string): ContextUsage {
    return this.compactor.contextUsage(model, pendingText)
  }

  tokenConfig(): TokenSettings {
    return this.state.tokenSettings ?? normalizeTokenSettings({})
  }

  async updateTokenSettings(updates: Partial<TokenSettings>): Promise<TokenSettings> {
    const next = normalizeTokenSettings({ ...this.tokenConfig(), ...updates })
    this.state.tokenSettings = next
    // Until the user names a summarizer, the small-job model is what compaction runs on.
    if (!this.summarizerExplicit && this.compactionSettings.summarizerModel !== next.cheapModel) {
      this.compactionSettings = { ...this.compactionSettings, summarizerModel: next.cheapModel }
    }
    await this.saveSettings(tokenSettingsToDict(next))
    return next
  }

  behaviorConfig(): BehaviorSettings {
    return this.state.behaviorSettings
  }

  async updateBehaviorSettings(updates: Partial<BehaviorSettings>): Promise<BehaviorSettings> {
    const next = normalizeBehaviorSettings({ ...this.state.behaviorSettings, ...updates })
    this.state.behaviorSettings = next
    await this.saveSettings(behaviorSettingsToDict(next))
    this.state.system = await this.buildSystem()
    return next
  }

  /**
   * Complex requests get one turn on the strongest model at a higher effort. The user's saved
   * model and effort are restored when the turn ends, and an explicitly pinned model is never
   * overridden.
   */
  routeTask(level: TaskComplexity): { model: string; effort: string } | null {
    if (level !== 'complex' || this.state.pinned || this.modelController === null) return null
    if (this.routedModel !== null) return null
    const controller = this.modelController
    const backup = this.state.model
    let changed = false
    if (!/pro/iu.test(this.state.model)) {
      const target = AppConstants.MODELS.find((id) => /pro/iu.test(id))
      if (target !== undefined && target !== this.state.model) {
        this.state.model = target
        changed = true
      }
    }
    const wanted = deepEffort(controller.effectiveEffort())
    if (!wanted.equals(controller.effectiveEffort())) {
      controller.setEffortOverride(wanted)
      this.routedEffortActive = true
      changed = true
    }
    if (!changed) return null
    this.routedModel = backup
    this.state.routedFromModel = backup
    return { model: this.state.model, effort: controller.effectiveEffort().displayName }
  }

  restoreTaskRoute(): void {
    if (this.routedModel !== null) {
      this.state.model = this.routedModel
      this.routedModel = null
    }
    this.state.routedFromModel = null
    if (this.routedEffortActive) {
      this.modelController?.setEffortOverride(null)
      this.routedEffortActive = false
    }
    this.state.taskComplexity = null
    this.state.deepActive = false
  }

  async runTokenCommand(arg: string): Promise<TokenCommandParse> {
    const parsed = parseTokenCommand(arg)
    if (parsed.kind !== 'update') return parsed
    if (parsed.updates !== undefined) await this.updateTokenSettings(parsed.updates)
    if (parsed.compaction !== undefined) {
      await this.updateCompactionSettings(parsed.compaction)
    }
    return parsed
  }

  compactNow(trigger: CompactionTrigger = 'manual'): Promise<CompactionResult | null> {
    return this.compactor.compactNow(trigger)
  }

  isCompacting(): boolean {
    return this.compactor.isRunning()
  }

  async pickFunction(): Promise<void> {
    await this.turnEngine.pickFunction()
  }

  async choose(
    title: string,
    items: ChooseItem[],
    options?: ChooseOptions
  ): Promise<string | null> {
    return await this.chooseHook(title, items, options)
  }

  async command(line: string): Promise<'exit' | null> {
    return await this.cli.command(line)
  }

  cancel(): void {
    this.turnEngine.cancel()
  }

  async resolvePath(path: string | null | undefined): Promise<string> {
    return await this.paths.resolve(path)
  }

  rel(fullPath: string): string {
    return this.paths.rel(fullPath)
  }

  async undo(): Promise<void> {
    await this.session.undo(this.state)
  }

  async revert(): Promise<void> {
    await this.session.revert(this.state)
  }

  async rollbackToCheckpoint(targetIdx: number): Promise<boolean> {
    return await this.session.rollbackToCheckpoint(this.state, targetIdx)
  }

  async readMemoryContent(): Promise<string> {
    return await this.memory.readMemoryContent()
  }

  async clearMemory(): Promise<boolean> {
    return await this.memory.clearMemory()
  }

  get contents(): Content[] {
    return this.state.contents
  }

  get checkpoints(): Checkpoint[] {
    return this.state.checkpoints
  }

  get todos(): Todo[] {
    return this.state.todos
  }

  get timelineHistory(): TimelineTurn[] {
    return this.state.timelineHistory
  }

  get model(): string {
    return this.state.model
  }

  set model(value: string) {
    this.state.model = value
  }

  get tokensIn(): number {
    return this.state.tokensIn
  }

  get tokensOut(): number {
    return this.state.tokensOut
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function parseNumberSetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function parseBoolSetting(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  const clean = raw.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(clean)) return true
  if (['0', 'false', 'off', 'no'].includes(clean)) return false
  return fallback
}

/** Deep work never gets less thinking than HIGH; a deliberate HIGH/EXTRA_HIGH choice is kept. */
function deepEffort(level: EffortLevel): EffortLevel {
  if (level.equals(EffortLevel.HIGH) || level.equals(EffortLevel.EXTRA_HIGH)) return level
  return EffortLevel.HIGH
}
