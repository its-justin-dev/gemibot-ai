import { resolve } from 'path'

import { ChangeType } from '../../shared/models/file-change'
import type {
  BuildDocsView,
  BuildModeSetting,
  BuildRunStatus,
  BuildSettings,
  BuildView
} from '../../shared/types/build'
import {
  buildSettingsFromDict,
  buildSettingsToDict,
  normalizeBuildSettings,
  DEFAULT_BUILD_SETTINGS,
  cycleBuildMode
} from '../../shared/utils/build-settings'
import { decideBuildIntent, isBuildFeedback, isPlanApproval } from '../../shared/utils/build-intent'
import type { TaskComplexity } from '../../shared/types/behavior-settings'
import type { Agent } from './agent.service'
import { BuildDocsService } from './build-docs.service'
import { BuildModelService } from './build-model.service'
import type { BuildTaskRunnerInput, BuildTaskRunnerResult } from './build-orchestrator.service'
import { BuildOrchestrator } from './build-orchestrator.service'
import { BuildRepoMapService } from './build-repo-map.service'
import { BuildRepository, buildRepository, type BuildRunRow } from './build-repository.service'
import { BuildVerifier } from './build-verifier.service'
import type { MultiAgentService } from './multi-agent.service'

export interface BuildRuntimeDeps {
  agent: Agent
  multiAgent: () => MultiAgentService | null
  conversationId: () => string | null
  onState: (view: BuildView | null) => void
  onMode: (mode: BuildModeSetting) => void
  onNotice: (text: string) => void
  onFinalReport: (report: string, status: BuildRunStatus) => void
  onTodos: (todos: Array<Record<string, unknown>>) => void
}

export type BuildIntentAction = 'start' | 'resume' | 'approve' | 'revise' | 'none'

const RESUMABLE: BuildRunStatus[] = ['running', 'paused', 'awaiting-approval', 'failed']

export class BuildRuntimeService {
  private readonly deps: BuildRuntimeDeps
  private settings: BuildSettings = { ...DEFAULT_BUILD_SETTINGS }
  private current: BuildView | null = null
  private run: BuildOrchestrator | null = null
  private readonly repository: BuildRepository

  constructor(deps: BuildRuntimeDeps, repository: BuildRepository = buildRepository) {
    this.deps = deps
    this.repository = repository
  }

  /** Called once at startup, after the restored conversation is known. */
  async init(saved?: Record<string, string>): Promise<void> {
    this.repository.markInterrupted()
    this.settings = saved === undefined
      ? buildSettingsFromDict(await this.deps.agent.settings.readSettingsDict())
      : buildSettingsFromDict(saved)
    this.refresh()
  }

  get mode(): BuildModeSetting {
    return this.settings.mode
  }

  get config(): BuildSettings {
    return { ...this.settings, roleModels: { ...this.settings.roleModels } }
  }

  get view(): BuildView | null {
    return this.run?.view ?? this.current
  }

  isRunning(): boolean {
    return this.run?.isRunning() === true
  }

  /** A live or stored build that can still be continued. */
  hasResumable(): boolean {
    return this.resumableRow() !== null
  }

  isAwaitingApproval(): boolean {
    return this.view?.status === 'awaiting-approval'
  }

  private root(): string {
    return resolve(this.deps.agent.state.root)
  }

  private conversationId(): string | null {
    return this.deps.conversationId()
  }

  private latestRow(): BuildRunRow | null {
    const conversationId = this.conversationId()
    if (conversationId !== null) {
      const row = this.repository.latestForConversation(conversationId)
      if (row !== null) return row
    }
    return this.repository.latestForRoot(this.root())
  }

  private resumableRow(): BuildRunRow | null {
    if (this.isRunning()) return null
    const row = this.repository.latestResumable(this.root(), this.conversationId())
    if (row !== null) return row
    const current = this.view
    if (current !== null && RESUMABLE.includes(current.status)) {
      return this.repository.load(current.id)
    }
    return null
  }

  /** Re-read the latest run after a conversation switch, target change or app restart. */
  refresh(): void {
    if (this.isRunning()) return
    const row = this.latestRow()
    this.current = row?.state.view ?? null
    this.run = null
    this.deps.onState(this.current)
  }

  async setMode(value: BuildModeSetting): Promise<BuildModeSetting> {
    this.settings = normalizeBuildSettings({ ...this.settings, mode: value })
    await this.deps.agent.settings.saveSettings({ build_mode: this.settings.mode })
    this.deps.onMode(this.settings.mode)
    return this.settings.mode
  }

  async cycleMode(): Promise<BuildModeSetting> {
    return await this.setMode(cycleBuildMode(this.settings.mode))
  }

  async updateSettings(partial: Partial<BuildSettings>): Promise<BuildSettings> {
    this.settings = normalizeBuildSettings({ ...this.settings, ...partial })
    await this.deps.agent.settings.saveSettings(buildSettingsToDict(this.settings))
    this.deps.onMode(this.settings.mode)
    return this.config
  }

  /**
   * Decide how a prompt relates to Build mode. Running builds are handled by the queue, so this
   * only routes starts, continuations, plan approvals and plan/requirement changes.
   */
  classify(text: string, complexity?: TaskComplexity | null): BuildIntentAction {
    const view = this.view
    if (view !== null && view.status === 'awaiting-approval' && !this.isRunning()) {
      if (isPlanApproval(text)) return 'approve'
      if (isBuildFeedback(text)) return 'revise'
      return 'none'
    }
    const intent = decideBuildIntent(text, {
      mode: this.settings.mode,
      complexity,
      hasPausedBuild: this.hasResumable(),
      hasActiveBuild: this.isRunning()
    })
    if (!intent.useBuild) return 'none'
    if (intent.continuation) return 'resume'
    const row = this.resumableRow()
    if (row !== null && row.status === 'paused') {
      // A fresh system request while a build is paused starts a new run instead of silently
      // discarding the user's request; the paused run stays in SQLite.
      return 'start'
    }
    return 'start'
  }

  private createModels(): BuildModelService {
    const cheap = this.deps.agent.state.tokenSettings?.cheapModel ?? ''
    return new BuildModelService({
      client: this.deps.agent.client,
      currentModel: this.deps.agent.model,
      cheapModel: cheap,
      roleModels: this.settings.roleModels,
      conversationId: () => this.conversationId(),
      onFailover: (from, to, reason) => {
        this.deps.onNotice(`Build model fallback: ${from} → ${to} (${reason.slice(0, 160)})`)
      }
    })
  }

  private async runTask(input: BuildTaskRunnerInput): Promise<BuildTaskRunnerResult> {
    const multiAgent = this.deps.multiAgent()
    if (multiAgent === null) throw new Error('Build tasks need the multi-agent runner')
    return await multiAgent.runBuildTask({
      ...input,
      autoApproveEdits: this.settings.autoApproveEdits
    })
  }

  private async beforeWrite(rel: string, full: string, isNew: boolean): Promise<void> {
    try {
      await this.deps.agent.changeTracker.recordChange(
        rel,
        full,
        isNew ? ChangeType.ADDED : ChangeType.MODIFIED,
        'Build mode',
        false,
        'build',
        ''
      )
    } catch {
      /* the changes drawer must not stop a build */
    }
  }

  private async beforeDelete(rel: string, full: string): Promise<void> {
    try {
      await this.deps.agent.changeTracker.recordChange(
        rel,
        full,
        ChangeType.DELETED,
        'Build mode',
        false,
        'build',
        ''
      )
    } catch {
      /* ignore tracking errors */
    }
  }

  private orchestrator(input: {
    goal: string
    conversationId: string | null
    existing?: BuildRunRow | null
  }): BuildOrchestrator {
    const root = this.root()
    return new BuildOrchestrator({
      root,
      conversationId: input.conversationId,
      goal: input.goal,
      settings: this.settings,
      models: this.createModels(),
      runTask: (task) => this.runTask(task),
      verifier: new BuildVerifier(root),
      docs: new BuildDocsService(root),
      repoMap: new BuildRepoMapService(root),
      repository: this.repository,
      onUpdate: (view) => {
        this.current = view
        this.deps.onState(view)
      },
      onNotice: (text) => this.deps.onNotice(text),
      onFinalReport: (report) => {
        this.deps.onFinalReport(report, this.current?.status ?? 'success')
      },
      onTodos: (todos) => this.deps.onTodos(todos),
      beforeWrite: (rel, full, isNew) => this.beforeWrite(rel, full, isNew),
      beforeDelete: (rel, full) => this.beforeDelete(rel, full),
      existing: input.existing?.state ?? null
    })
  }

  async startBuild(goal: string): Promise<void> {
    if (this.isRunning()) return
    const conversationId = this.conversationId()
    const run = this.orchestrator({ goal, conversationId })
    this.run = run
    this.current = run.view
    this.deps.onState(this.current)
    try {
      await run.start()
    } finally {
      this.current = run.view
      this.deps.onState(this.current)
    }
  }

  private async continueFrom(row: BuildRunRow): Promise<void> {
    if (this.isRunning()) return
    const run = this.orchestrator({
      goal: row.goal,
      conversationId: row.conversationId,
      existing: row
    })
    this.run = run
    this.current = run.view
    this.deps.onState(this.current)
    try {
      await run.start()
    } finally {
      this.current = run.view
      this.deps.onState(this.current)
    }
  }

  async resume(): Promise<boolean> {
    if (this.isRunning()) return false
    const row = this.resumableRow()
    if (row === null) return false
    await this.continueFrom(row)
    return true
  }

  async approve(): Promise<boolean> {
    if (this.isRunning()) return false
    const view = this.view
    if (view === null || view.status !== 'awaiting-approval') return false
    const row = this.repository.load(view.id)
    if (row === null) return false
    const run = this.orchestrator({
      goal: row.goal,
      conversationId: row.conversationId,
      existing: row
    })
    this.run = run
    try {
      await run.approvePlan()
    } finally {
      this.current = run.view
      this.deps.onState(this.current)
    }
    return true
  }

  async revise(feedback: string): Promise<boolean> {
    if (this.isRunning()) {
      await this.run?.revise(feedback)
      return true
    }
    const view = this.view
    if (view === null || !RESUMABLE.includes(view.status)) return false
    const row = this.repository.load(view.id)
    if (row === null) return false
    const run = this.orchestrator({
      goal: row.goal,
      conversationId: row.conversationId,
      existing: row
    })
    this.run = run
    try {
      await run.revise(feedback)
    } finally {
      this.current = run.view
      this.deps.onState(this.current)
    }
    return true
  }

  pause(): void {
    this.run?.pause()
  }

  stop(): void {
    if (this.run?.isRunning() === true) {
      this.run.stop()
      return
    }
    const view = this.view
    if (view === null || !RESUMABLE.includes(view.status)) return
    const row = this.repository.load(view.id)
    if (row === null) return
    row.state.view.status = 'stopped'
    row.state.view.error = null
    row.state.view.finishedAt = Date.now()
    this.repository.save(row.state)
    this.current = row.state.view
    this.run = null
    this.deps.onState(this.current)
  }

  async docs(): Promise<BuildDocsView> {
    const root = this.view?.root ?? this.root()
    const service = new BuildDocsService(root)
    const result = await service.readAll()
    if (result.docs.length > 0) return result
    if (root !== this.root()) {
      return await new BuildDocsService(this.root()).readAll()
    }
    return result
  }

  todos(): Array<Record<string, unknown>> {
    const view = this.view
    if (view === null) return []
    const todos: Array<Record<string, unknown>> = []
    for (const milestone of view.milestones) {
      for (const task of milestone.taskResults) {
        const status =
          task.status === 'succeeded'
            ? 'completed'
            : task.status === 'running'
              ? 'in_progress'
              : 'pending'
        todos.push({ content: `${milestone.title}: ${task.title}`, status, taskId: task.taskId })
      }
    }
    return todos
  }

  summaryLines(): string[] {
    const settings = this.settings
    const view = this.view
    const lines = [
      `Build mode: ${settings.mode} · plan approval: ${settings.planApproval}`,
      `Budgets: ${settings.maxTokens.toLocaleString()} tokens · ${settings.maxSteps} steps · ` +
        `${settings.repairAttempts} repair attempt(s)`,
      `Workers: up to ${settings.subAgents} sub-agent(s) · auto-approve edits: ` +
        `${settings.autoApproveEdits ? 'on' : 'off'}`,
      `Verify: install ${settings.installDependencies ? 'on' : 'off'} · each milestone ` +
        `${settings.verifyEachMilestone ? 'on' : 'off'} · smoke ${settings.smokeTest ? 'on' : 'off'} · ` +
        `clarify ${settings.clarify ? 'on' : 'off'}`,
      `Effort: planning ${settings.planningEffort} · implementation ${settings.implementationEffort} · review ${settings.reviewEffort}`,
      `Models: strong ${settings.roleModels.strong || 'auto'} · implementation ` +
        `${settings.roleModels.implementation || 'auto'} · cheap ${settings.roleModels.cheap || 'auto'}`
    ]
    if (view !== null) {
      lines.push(
        `Last build: ${view.status} · ${view.completedMilestones}/${view.totalMilestones} milestone(s) · ` +
          `${view.tasksDone}/${view.tasksTotal} task(s) · ${view.tokensUsed.toLocaleString()} tokens · ` +
          `${view.repairAttempts} repair(s)`
      )
    }
    return lines
  }

  async applySetting(key: string, value: string): Promise<string> {
    const clean = key.trim().toLowerCase()
    const onOff = (raw: string): boolean => {
      const text = raw.trim().toLowerCase()
      if (['on', 'true', '1', 'yes'].includes(text)) return true
      if (['off', 'false', '0', 'no'].includes(text)) return false
      throw new Error(`${key} expects on or off`)
    }
    const number = (raw: string): number => {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) throw new Error(`${key} expects a number`)
      return parsed
    }
    const partial: Partial<BuildSettings> = {}
    switch (clean) {
      case 'mode':
        partial.mode = value as BuildModeSetting
        break
      case 'approval':
      case 'plan_approval':
        partial.planApproval = value.trim().toLowerCase() === 'ask' ? 'ask' : 'auto'
        break
      case 'tokens':
      case 'max_tokens':
        partial.maxTokens = number(value)
        break
      case 'steps':
      case 'max_steps':
        partial.maxSteps = number(value)
        break
      case 'repairs':
      case 'repair_attempts':
        partial.repairAttempts = number(value)
        break
      case 'subagents':
      case 'sub_agents':
        partial.subAgents = number(value)
        break
      case 'autowrite':
      case 'auto_approve_edits':
        partial.autoApproveEdits = onOff(value)
        break
      case 'install':
      case 'install_dependencies':
        partial.installDependencies = onOff(value)
        break
      case 'verify':
      case 'verify_each_milestone':
        partial.verifyEachMilestone = onOff(value)
        break
      case 'smoke':
      case 'smoke_test':
        partial.smokeTest = onOff(value)
        break
      case 'clarify':
        partial.clarify = onOff(value)
        break
      case 'strong':
      case 'strong_model':
        partial.roleModels = { ...this.settings.roleModels, strong: value.trim() }
        break
      case 'implementation':
      case 'implementation_model':
        partial.roleModels = { ...this.settings.roleModels, implementation: value.trim() }
        break
      case 'cheap':
      case 'cheap_model':
        partial.roleModels = { ...this.settings.roleModels, cheap: value.trim() }
        break
      case 'planning_effort':
      case 'plan_effort':
        partial.planningEffort = value.trim().toLowerCase() as BuildSettings['planningEffort']
        break
      case 'implementation_effort':
      case 'implement_effort':
        partial.implementationEffort = value
          .trim()
          .toLowerCase() as BuildSettings['implementationEffort']
        break
      case 'review_effort':
        partial.reviewEffort = value.trim().toLowerCase() as BuildSettings['reviewEffort']
        break
      default:
        throw new Error(
          `Unknown build setting "${key}". Use mode, approval, tokens, steps, repairs, subagents, ` +
            'autowrite, install, verify, smoke, clarify, strong, implementation, cheap, ' +
            'plan_effort, implement_effort or review_effort.'
        )
    }
    const next = await this.updateSettings(partial)
    if (clean === 'mode') return `Build mode set to ${next.mode}.`
    return `Build setting ${clean} updated.`
  }
}
