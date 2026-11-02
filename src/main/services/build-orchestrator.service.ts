import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, resolve, sep } from 'path'

import {
  findBuildTemplate,
  projectNameFromGoal
} from '../../shared/constants/build-templates'
import {
  architecturePrompt,
  architectureSystemPrompt,
  buildTaskPrompt,
  milestoneReviewPrompt,
  planPrompt,
  planSystemPrompt,
  progressMarkdown,
  readmePrompt,
  readmeSystemPrompt,
  repairPrompt,
  repairSystemPrompt,
  reviewSystemPrompt,
  scaffoldPrompt,
  scaffoldSystemPrompt,
  specPrompt,
  specSystemPrompt
} from '../../shared/prompts/build-prompts'
import type {
  BuildArchitecture,
  BuildEffortSetting,
  BuildPersistedState,
  BuildPlan,
  BuildRunStatus,
  BuildSettings,
  BuildSpec,
  BuildStageName,
  BuildStageRecord,
  BuildTask,
  BuildTaskResult,
  BuildTaskStatus,
  BuildVerification,
  BuildVerifyKind,
  BuildView
} from '../../shared/types/build'
import { needsPlanApproval } from '../../shared/utils/build-settings'
import {
  validateArchitecture,
  validatePlan,
  validateRepair,
  validateReview,
  validateScaffold,
  validateSpec,
  type BuildRepairResult,
  type ValidationResult
} from '../../shared/utils/build-validate'
import type { BuildModelResult, BuildModelRole, BuildModelService } from './build-model.service'
import { BuildAbortedError, isBuildAbort } from './build-model.service'
import type { BuildUsageCounts } from './build-model.service'
import { BuildDocsService } from './build-docs.service'
import { BuildRepoMapService } from './build-repo-map.service'
import { BuildRepository, buildRepository } from './build-repository.service'
import { BuildVerifier } from './build-verifier.service'

export type BuildTaskRunnerResult = {
  summary: string
  filesChanged: string[]
  error: string | null
  model: string
  durationMs: number
  tokens?: number
}

export interface BuildTaskRunnerInput {
  task: BuildTask
  milestone: { id: string; title: string; goal: string }
  prompt: string
  files: string[]
  model: string
  effort: BuildEffortSetting
  signal: AbortSignal | undefined
  /** Build sub-agents may only auto-approve file writes, never shell commands or deletes. */
  autoApproveEdits?: boolean
}

export type BuildTaskRunner = (input: BuildTaskRunnerInput) => Promise<BuildTaskRunnerResult>

export interface BuildOrchestratorDeps {
  root: string
  conversationId: string | null
  goal: string
  settings: BuildSettings
  models: BuildModelService
  runTask: BuildTaskRunner
  verifier?: BuildVerifier
  docs?: BuildDocsService
  repoMap?: BuildRepoMapService
  repository?: Pick<BuildRepository, 'save'>
  onUpdate?: (view: BuildView) => void
  onNotice?: (text: string) => void
  onFinalReport?: (report: string) => void
  onTodos?: (todos: Array<Record<string, unknown>>) => void
  /** Called before the orchestrator writes or deletes a file, so the changes drawer sees it. */
  beforeWrite?: (relPath: string, fullPath: string, isNew: boolean) => Promise<void> | void
  beforeDelete?: (relPath: string, fullPath: string) => Promise<void> | void
  existing?: BuildPersistedState | null
  now?: () => number
  id?: () => string
}

const STAGE_ORDER: BuildStageName[] = [
  'spec',
  'architecture',
  'plan',
  'scaffold',
  'implement',
  'verify',
  'finish'
]

const STAGE_LABELS: Record<BuildStageName, string> = {
  spec: 'Spec',
  architecture: 'Architecture',
  plan: 'Plan',
  scaffold: 'Scaffold',
  implement: 'Implementation',
  verify: 'Verify',
  finish: 'Final report'
}

const MAX_STAGE_OUTPUT = 3_000

export class BuildBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildBudgetError'
  }
}

class BuildReplanError extends Error {
  constructor() {
    super('Build plan needs an update')
    this.name = 'BuildReplanError'
  }
}

function posixRel(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/u, '')
}

function safeRelative(path: string): string | null {
  const rel = posixRel(path)
  if (rel === '' || rel.startsWith('/') || /^[a-z]:/iu.test(rel)) return null
  const parts = rel.split('/')
  if (parts.includes('..')) return null
  if (rel === '.gemibot' || rel.startsWith('.gemibot/')) return null
  if (rel === '.env' || rel.endsWith('/.env')) return null
  return rel
}

function clip(text: string, max = MAX_STAGE_OUTPUT): string {
  const clean = text.replace(/\r\n?/gu, '\n').trim()
  return clean.length > max ? `${clean.slice(0, max)}\n[... truncated]` : clean
}

function normalizeRelList(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const rel = safeRelative(path)
    if (rel === null || seen.has(rel)) continue
    seen.add(rel)
    result.push(rel)
  }
  return result
}

/** A task that owns a folder and one that owns a file inside it can still collide. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function createView(deps: BuildOrchestratorDeps): BuildView {
  const now = deps.now?.() ?? Date.now()
  const root = resolve(deps.root)
  const docsDir = resolve(root, '.gemibot')
  return {
    id: deps.id?.() ?? `build-${now}-${randomUUID().slice(0, 8)}`,
    conversationId: deps.conversationId,
    root,
    goal: deps.goal.trim().slice(0, 4_000),
    status: 'running',
    stage: 'spec',
    stageLabel: STAGE_LABELS.spec,
    stages: STAGE_ORDER.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      status: 'pending',
      model: '',
      startedAt: 0,
      durationMs: 0,
      detail: '',
      output: ''
    })),
    milestones: [],
    totalMilestones: 0,
    completedMilestones: 0,
    tasksDone: 0,
    tasksTotal: 0,
    tokensUsed: 0,
    tokenBudget: deps.settings.maxTokens,
    stepsUsed: 0,
    stepBudget: deps.settings.maxSteps,
    repairAttempts: 0,
    maxRepairAttempts: deps.settings.repairAttempts,
    planApprovalRequired: false,
    assumptions: [],
    summary: '',
    error: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    usage: [],
    specPath: resolve(docsDir, 'SPEC.md'),
    architecturePath: resolve(docsDir, 'ARCHITECTURE.md'),
    planPath: resolve(docsDir, 'PLAN.md'),
    progressPath: resolve(docsDir, 'PROGRESS.md')
  }
}

function freshState(deps: BuildOrchestratorDeps): BuildPersistedState {
  return {
    view: createView(deps),
    spec: null,
    architecture: null,
    plan: null,
    taskResults: {},
    milestoneReviews: {},
    decisions: [],
    verification: null,
    report: null,
    scaffoldFiles: [],
    pendingFeedback: [],
    planApproved: false,
    budgetWarned: {}
  }
}

export class BuildOrchestrator {
  readonly root: string
  private readonly deps: BuildOrchestratorDeps
  private readonly state: BuildPersistedState
  private readonly models: BuildModelService
  private readonly verifier: BuildVerifier
  private readonly docs: BuildDocsService
  private readonly repoMap: BuildRepoMapService
  private readonly settings: BuildSettings
  private readonly now: () => number

  private controller: AbortController | null = null
  private running = false
  private pauseRequested = false
  private stopRequested = false
  private replanFeedback: string[] = []
  /** Kept because replan() must clear the live plan before the redesigned one is compared. */
  private previousPlanForReplan: BuildPlan | null = null
  private decisionsWritten = false

  constructor(deps: BuildOrchestratorDeps) {
    this.root = resolve(deps.root)
    this.deps = deps
    this.settings = deps.settings
    this.now = deps.now ?? (() => Date.now())
    this.models = deps.models
    this.state = deps.existing ?? freshState(deps)
    if (deps.existing !== null && deps.existing !== undefined) {
      this.state.view.tokenBudget = deps.settings.maxTokens
      this.state.view.stepBudget = deps.settings.maxSteps
      this.state.view.maxRepairAttempts = deps.settings.repairAttempts
    }
    this.docs = deps.docs ?? new BuildDocsService(this.root)
    this.verifier = deps.verifier ?? new BuildVerifier(this.root)
    this.repoMap = deps.repoMap ?? new BuildRepoMapService(this.root)
  }

  get view(): BuildView {
    return this.state.view
  }

  get persisted(): BuildPersistedState {
    return this.state
  }

  isRunning(): boolean {
    return this.running
  }

  private signal(): AbortSignal | undefined {
    return this.controller?.signal
  }

  private throwIfInterrupted(): void {
    if (
      this.pauseRequested ||
      this.stopRequested ||
      this.controller?.signal.aborted === true
    ) {
      throw new BuildAbortedError()
    }
  }

  private checkFeedback(): void {
    // replanFeedback is the batch currently being applied to the regenerated spec/architecture/
    // plan. Only feedback queued after that batch started should interrupt the pipeline again.
    if (this.state.pendingFeedback.length > 0) {
      throw new BuildReplanError()
    }
  }

  private emit(): void {
    this.state.view.updatedAt = this.now()
    try {
      this.deps.onUpdate?.(this.state.view)
    } catch {}
  }

  private persist(): void {
    try {
      ;(this.deps.repository ?? buildRepository).save(this.state)
    } catch {}
  }

  private save(): void {
    this.persist()
    this.emit()
  }

  private noteDecision(text: string): void {
    const clean = text.trim()
    if (clean === '' || this.state.decisions.includes(clean)) return
    this.state.decisions.push(clean)
    if (this.state.decisions.length > 60) this.state.decisions.shift()
  }

  private stageRecord(stage: BuildStageName): BuildStageRecord {
    const record = this.state.view.stages.find((item) => item.stage === stage)
    if (record !== undefined) return record
    const created: BuildStageRecord = {
      stage,
      label: STAGE_LABELS[stage],
      status: 'pending',
      model: '',
      startedAt: 0,
      durationMs: 0,
      detail: '',
      output: ''
    }
    this.state.view.stages.push(created)
    return created
  }

  private resetStage(stage: BuildStageName): void {
    const record = this.stageRecord(stage)
    record.status = 'pending'
    record.model = ''
    record.startedAt = 0
    record.durationMs = 0
    record.detail = ''
    record.output = ''
  }

  private async runStage(stage: BuildStageName, body: () => Promise<void>): Promise<void> {
    const record = this.stageRecord(stage)
    record.status = 'running'
    record.startedAt = this.now()
    record.durationMs = 0
    record.detail = ''
    record.output = ''
    this.state.view.stage = stage
    this.state.view.stageLabel = record.label
    this.save()
    try {
      await body()
      if (record.status === 'running') {
        record.status = 'success'
        record.durationMs = this.now() - record.startedAt
        if (record.detail === '') record.detail = 'Done'
      }
      this.save()
    } catch (error) {
      if (this.pauseRequested || this.stopRequested || isBuildAbort(error)) {
        record.status = 'pending'
        record.detail = this.stopRequested ? 'Stopped before completion' : 'Paused'
        record.durationMs = Math.max(0, this.now() - record.startedAt)
        this.save()
        throw new BuildAbortedError()
      }
      record.status = 'failed'
      record.detail = clip(error instanceof Error ? error.message : String(error), 1_000)
      record.output = record.detail
      record.durationMs = Math.max(0, this.now() - record.startedAt)
      this.save()
      throw error
    }
  }

  private assertBudget(): void {
    this.throwIfInterrupted()
    const view = this.state.view
    if (view.tokensUsed >= view.tokenBudget) {
      throw new BuildBudgetError(
        `Token budget reached (${view.tokensUsed.toLocaleString()} / ${view.tokenBudget.toLocaleString()}). Raise "Build token budget" in settings, then resume.`
      )
    }
    if (view.stepsUsed >= view.stepBudget) {
      throw new BuildBudgetError(
        `Step budget reached (${view.stepsUsed} / ${view.stepBudget}). Raise "Build step budget" in settings, then resume.`
      )
    }
    this.warnBudget()
  }

  private warnBudget(): void {
    const view = this.state.view
    const warned = this.state.budgetWarned ?? {}
    if (!warned.tokens && view.tokensUsed >= view.tokenBudget * 0.8) {
      warned.tokens = true
      this.state.budgetWarned = warned
      this.deps.onNotice?.(
        `Build has used ${Math.round((view.tokensUsed / view.tokenBudget) * 100)}% of its token budget.`
      )
      this.noteDecision('Token budget reached 80%; the build continues but will pause at 100%.')
    }
    if (!warned.steps && view.stepsUsed >= view.stepBudget * 0.8) {
      warned.steps = true
      this.state.budgetWarned = warned
      this.deps.onNotice?.(
        `Build has used ${Math.round((view.stepsUsed / view.stepBudget) * 100)}% of its step budget.`
      )
      this.noteDecision('Step budget reached 80%; the build continues but will pause at 100%.')
    }
  }

  private addUsage(
    label: string,
    model: string,
    usage: BuildUsageCounts,
    durationMs: number
  ): void {
    const view = this.state.view
    view.tokensUsed += Math.max(0, usage.totalTokens)
    const existing = view.usage.find((row) => row.label === label && row.model === model)
    if (existing !== undefined) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.totalTokens += usage.totalTokens
      existing.durationMs += durationMs
    } else {
      view.usage.push({
        label,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        durationMs
      })
    }
  }

  private addTaskTokens(label: string, model: string, tokens: number, durationMs: number): void {
    if (tokens <= 0 && durationMs <= 0) return
    this.addUsage(label, model, { inputTokens: 0, outputTokens: 0, totalTokens: tokens }, durationMs)
  }

  private async modelJson<T>(input: {
    stage: string
    label: string
    role: BuildModelRole
    effort: BuildEffortSetting
    system: string
    prompt: string
    validate: (value: unknown) => ValidationResult<T>
  }): Promise<BuildModelResult<T>> {
    this.assertBudget()
    const stage = this.stageRecord(
      (['spec', 'architecture', 'plan', 'scaffold', 'implement', 'verify', 'finish'] as BuildStageName[]).includes(
        input.stage as BuildStageName
      )
        ? (input.stage as BuildStageName)
        : this.state.view.stage
    )
    const result = await this.models.json<T>({
      stage: input.stage,
      role: input.role,
      effort: input.effort,
      system: input.system,
      prompt: input.prompt,
      validate: input.validate,
      signal: this.signal()
    })
    stage.model = result.model
    this.state.view.stepsUsed += 1
    this.addUsage(input.label, result.model, result.usage, result.durationMs)
    this.assertBudgetAfterSpend()
    return result
  }

  private async modelText(input: {
    stage: string
    label: string
    role: BuildModelRole
    effort: BuildEffortSetting
    system: string
    prompt: string
  }): Promise<BuildModelResult<string>> {
    this.assertBudget()
    const result = await this.models.text({
      stage: input.stage,
      role: input.role,
      effort: input.effort,
      system: input.system,
      prompt: input.prompt,
      signal: this.signal()
    })
    const stage = this.stageRecord(this.state.view.stage)
    stage.model = result.model
    this.state.view.stepsUsed += 1
    this.addUsage(input.label, result.model, result.usage, result.durationMs)
    this.assertBudgetAfterSpend()
    return result
  }

  private assertBudgetAfterSpend(): void {
    const view = this.state.view
    if (view.tokensUsed >= view.tokenBudget || view.stepsUsed >= view.stepBudget) {
      this.assertBudget()
      return
    }
    this.warnBudget()
  }

  private async docsTry(label: string, body: () => Promise<void>): Promise<void> {
    try {
      await body()
    } catch {
      if (!this.decisionsWritten) {
        this.decisionsWritten = true
        this.noteDecision(`Could not write ${label} under .gemibot; the build continues.`)
      }
    }
  }

  private async writeProgress(nextStep: string): Promise<void> {
    const plan = this.state.plan
    const spec = this.state.spec
    if (plan === null && spec === null) return
    const markdown = progressMarkdown({
      goal: this.state.view.goal,
      spec,
      plan,
      milestones: (plan?.milestones ?? []).map((milestone) => {
        const viewMilestone = this.state.view.milestones.find((item) => item.id === milestone.id)
        return {
          title: milestone.title,
          status: viewMilestone?.status ?? 'pending',
          tasks: milestone.tasks.map((task) => {
            const result = this.state.taskResults[task.id]
            return {
              title: task.title,
              status: result?.status ?? 'pending',
              summary: result?.summary ?? ''
            }
          })
        }
      }),
      decisions: this.state.decisions,
      verification: this.state.verification,
      nextStep
    })
    await this.docsTry('PROGRESS.md', () => this.docs.writeProgress(markdown))
  }

  private fullPath(rel: string): string | null {
    const clean = safeRelative(rel)
    if (clean === null) return null
    const full = resolve(this.root, clean)
    const base = resolve(this.root)
    const lowerBase = base.toLowerCase().replace(/[\\/]+$/u, '')
    const lowerFull = full.toLowerCase()
    if (lowerFull !== lowerBase && !lowerFull.startsWith(`${lowerBase}${sep}`)) return null
    return full
  }

  private async readText(rel: string): Promise<string | null> {
    const full = this.fullPath(rel)
    if (full === null) return null
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size > 500_000) return null
      const text = await readFile(full, 'utf8')
      return text
    } catch {
      return null
    }
  }

  private async writeText(rel: string, content: string, overwrite: boolean): Promise<boolean> {
    const full = this.fullPath(rel)
    if (full === null) return false
    const isNew = !existsSync(full)
    if (!isNew && !overwrite) return false
    try {
      await this.deps.beforeWrite?.(rel, full, isNew)
    } catch {}
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
    return true
  }

  private isProtectedDelete(rel: string): boolean {
    const changed = new Set<string>([
      ...this.state.scaffoldFiles,
      ...Object.values(this.state.taskResults).flatMap((result) => result.filesChanged)
    ])
    return !changed.has(rel)
  }

  private async removeText(rel: string): Promise<boolean> {
    const full = this.fullPath(rel)
    if (full === null || this.isProtectedDelete(rel)) return false
    try {
      await this.deps.beforeDelete?.(rel, full)
      const { unlink } = await import('fs/promises')
      await unlink(full)
      return true
    } catch {
      return false
    }
  }

  private async projectSummary(): Promise<string> {
    return this.repoMap.map(250)
  }

  private emitTodos(): void {
    const plan = this.state.plan
    if (plan === null) return
    const todos: Array<Record<string, unknown>> = []
    for (const milestone of plan.milestones) {
      for (const task of milestone.tasks) {
        const result = this.state.taskResults[task.id]
        const status: string =
          result?.status === 'succeeded'
            ? 'completed'
            : result?.status === 'running'
              ? 'in_progress'
              : 'pending'
        todos.push({ content: `${milestone.title}: ${task.title}`, status, taskId: task.id })
      }
    }
    try {
      this.deps.onTodos?.(todos)
    } catch {}
  }

  private async applyRepair(repair: BuildRepairResult): Promise<{
    changed: string[]
    errors: string[]
  }> {
    const changed: string[] = []
    const errors: string[] = []
    for (const edit of repair.edits) {
      const rel = safeRelative(edit.path)
      if (rel === null) {
        errors.push(`Refused unsafe path ${edit.path}`)
        continue
      }
      const current = await this.readText(rel)
      if (current === null) {
        errors.push(`${rel} does not exist; use creates for a new file.`)
        continue
      }
      const first = current.indexOf(edit.search)
      if (first === -1) {
        errors.push(`Search text was not found in ${rel}.`)
        continue
      }
      if (current.indexOf(edit.search, first + edit.search.length) !== -1) {
        errors.push(`Search text appears more than once in ${rel}; make it unique.`)
        continue
      }
      const next = `${current.slice(0, first)}${edit.replace}${current.slice(first + edit.search.length)}`
      if (await this.writeText(rel, next, true)) changed.push(rel)
    }
    for (const create of repair.creates) {
      const rel = safeRelative(create.path)
      if (rel === null) {
        errors.push(`Refused unsafe path ${create.path}`)
        continue
      }
      const exists = await this.readText(rel)
      if (exists !== null) {
        errors.push(`${rel} already exists; use edits for existing files.`)
        continue
      }
      if (await this.writeText(rel, create.content, false)) changed.push(rel)
    }
    for (const del of repair.deletes) {
      const rel = safeRelative(del)
      if (rel === null) {
        errors.push(`Refused unsafe path ${del}`)
        continue
      }
      if (this.isProtectedDelete(rel)) {
        errors.push(`Refused to delete ${rel}; the build did not create it.`)
        continue
      }
      if (await this.removeText(rel)) changed.push(rel)
    }
    return { changed, errors }
  }

  private failureText(verification: BuildVerification): string {
    const failed = verification.steps.filter((step) => step.status === 'failed')
    const body = failed
      .map((step) => `${step.kind}: ${step.command} (exit ${step.exitCode})\n${step.output}`)
      .join('\n\n')
    return clip(body === '' ? verification.summary : body, 12_000)
  }

  private errorFiles(text: string): string[] {
    const files: string[] = []
    for (const match of text.matchAll(
      /([\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|css|html|vue|svelte|sql|toml|yaml|yml))/gu
    )) {
      const rel = posixRel(match[1])
      if (rel.includes('node_modules/') || rel.includes('.venv/') || rel.includes('.gemibot/')) continue
      if (!files.includes(rel)) files.push(rel)
    }
    return files.slice(0, 12)
  }

  private async verifyWithRepair(input: {
    kinds: BuildVerifyKind[]
    label: string
    relevantFiles?: string[]
  }): Promise<BuildVerification> {
    const kinds = input.kinds.filter((kind) => kind !== 'smoke' || this.settings.smokeTest)
    const run = async (): Promise<BuildVerification> => {
      this.throwIfInterrupted()
      this.verifier.invalidate()
      const verification = await this.verifier.verify({
        kinds,
        signal: this.signal(),
        install: this.settings.installDependencies
      })
      this.throwIfInterrupted()
      this.state.view.stepsUsed += 1
      this.state.verification = verification
      this.save()
      return verification
    }
    let verification = await run()
    if (verification.passed) return verification
    const previousAttempts: string[] = []
    const relevant = normalizeRelList(input.relevantFiles ?? [])

    for (let attempt = 1; attempt <= this.settings.repairAttempts; attempt++) {
      this.assertBudget()
      const failure = this.failureText(verification)
      const files = normalizeRelList([
        ...this.errorFiles(failure),
        ...relevant,
        ...this.state.scaffoldFiles.slice(-8),
        ...Object.values(this.state.taskResults).flatMap((result) => result.filesChanged)
      ]).slice(0, 8)
      const snippets = await this.repoMap.readRelevant(files)
      const map = await this.projectSummary()
      const repair = await this.modelJson<BuildRepairResult>({
        stage: 'verify',
        label: 'Repair',
        role: 'strong',
        effort: this.settings.reviewEffort,
        system: repairSystemPrompt(),
        prompt: repairPrompt({
          failure,
          repoMap: map,
          files: snippets,
          previousAttempts,
          attempt
        }),
        validate: validateRepair
      })
      this.state.view.repairAttempts += 1
      const applied = await this.applyRepair(repair.value)
      previousAttempts.push(
        `${repair.value.diagnosis} [${applied.changed.join(', ') || 'no files changed'}]`
      )
      if (applied.changed.length === 0) {
        this.noteDecision(`Repair attempt ${attempt} changed no files: ${applied.errors.join(' ')}`)
      }
      for (const error of applied.errors) this.noteDecision(error)
      await this.writeProgress(`${input.label}: repair ${attempt}`)
      this.save()
      verification = await run()
      if (verification.passed) return verification
    }
    return verification
  }

  private async generateSpec(feedback: string[]): Promise<void> {
    const summary = await this.projectSummary()
    const result = await this.modelJson<BuildSpec>({
      stage: 'spec',
      label: 'Spec',
      role: 'strong',
      effort: this.settings.planningEffort,
      system: specSystemPrompt(),
      prompt: specPrompt({
        goal: this.state.view.goal,
        projectSummary: summary,
        conventions: '',
        feedback
      }),
      validate: validateSpec
    })
    this.state.spec = result.value
    this.state.view.assumptions = result.value.assumptions
    const record = this.stageRecord('spec')
    record.detail = `${result.value.features.length} feature(s), ${result.value.assumptions.length} assumption(s)`
    await this.docsTry('SPEC.md', () => this.docs.writeSpec(result.value))
    await this.writeProgress('Architecture')
    this.save()
  }

  private async generateArchitecture(feedback: string[]): Promise<void> {
    const spec = this.state.spec
    if (spec === null) return
    const result = await this.modelJson<BuildArchitecture>({
      stage: 'architecture',
      label: 'Architecture',
      role: 'strong',
      effort: this.settings.planningEffort,
      system: architectureSystemPrompt(),
      prompt: architecturePrompt({
        goal: this.state.view.goal,
        spec,
        projectSummary: await this.projectSummary(),
        feedback
      }),
      validate: validateArchitecture
    })
    this.state.architecture = result.value
    const record = this.stageRecord('architecture')
    record.detail = `${result.value.modules.length} module(s), ${result.value.contracts.length} contract(s)`
    await this.docsTry('ARCHITECTURE.md', () => this.docs.writeArchitecture(result.value))
    await this.writeProgress('Plan')
    this.save()
  }

  private async generatePlan(feedback: string[]): Promise<void> {
    const spec = this.state.spec
    const architecture = this.state.architecture
    if (spec === null || architecture === null) return
    const previousPlan = this.previousPlanForReplan ?? this.state.plan
    this.previousPlanForReplan = null
    const result = await this.modelJson<BuildPlan>({
      stage: 'plan',
      label: 'Plan',
      role: 'strong',
      effort: this.settings.planningEffort,
      system: planSystemPrompt(),
      prompt: planPrompt({ goal: this.state.view.goal, spec, architecture, feedback }),
      validate: validatePlan
    })
    this.state.plan = result.value
    this.state.planApproved = false
    this.applyPlan(result.value, previousPlan)
    const record = this.stageRecord('plan')
    record.detail = `${result.value.milestones.length} milestone(s), ${this.state.view.tasksTotal} task(s)`
    await this.docsTry('PLAN.md', () => this.docs.writePlan(result.value))
    await this.writeProgress('Scaffold')
    this.emitTodos()
    this.save()
  }

  private applyPlan(plan: BuildPlan, previousPlan: BuildPlan | null): void {
    const previousTasks = new Map<string, BuildTask>()
    for (const milestone of previousPlan?.milestones ?? []) {
      for (const task of milestone.tasks) previousTasks.set(task.id, task)
    }
    const kept = new Map<string, BuildTaskResult>()
    for (const milestone of plan.milestones) {
      for (const task of milestone.tasks) {
        const previous = previousTasks.get(task.id)
        const result = this.state.taskResults[task.id]
        if (previous === undefined || result === undefined) continue
        if (JSON.stringify(previous) !== JSON.stringify(task)) continue
        kept.set(task.id, result)
      }
    }
    const preserved = kept.size > 0 || previousPlan === null
    if (previousPlan !== null) {
      const dropped = Object.keys(this.state.taskResults).filter((id) => !kept.has(id))
      if (dropped.length > 0) {
        this.noteDecision(
          `Revised plan regenerated ${dropped.length} task(s) that no longer match; completed work on them is preserved on disk.`
        )
      }
    }
    if (!preserved) this.state.taskResults = {}
    else this.state.taskResults = Object.fromEntries(kept)
    this.state.milestoneReviews = Object.fromEntries(
      Object.entries(this.state.milestoneReviews).filter(([id]) => {
        const milestone = plan.milestones.find((item) => item.id === id)
        if (milestone === undefined) return false
        return milestone.tasks.every((task) => this.state.taskResults[task.id] === undefined || kept.has(task.id))
      })
    )
    this.state.view.milestones = plan.milestones.map((milestone) => {
      const taskResults = milestone.tasks
        .map((task) => this.state.taskResults[task.id])
        .filter((result): result is BuildTaskResult => result !== undefined)
      const allDone =
        taskResults.length === milestone.tasks.length &&
        taskResults.every((result) => result.status === 'succeeded')
      return {
        id: milestone.id,
        title: milestone.title,
        status: allDone ? ('succeeded' as BuildTaskStatus) : ('pending' as BuildTaskStatus),
        taskResults,
        review: this.state.milestoneReviews[milestone.id] ?? null,
        reviewIssues: [],
        attempts: 0
      }
    })
    this.state.view.totalMilestones = plan.milestones.length
    this.state.view.completedMilestones = this.state.view.milestones.filter(
      (milestone) => milestone.status === 'succeeded'
    ).length
    this.state.view.tasksTotal = plan.milestones.reduce(
      (total, milestone) => total + milestone.tasks.length,
      0
    )
    this.state.view.tasksDone = Object.values(this.state.taskResults).filter(
      (result) => result.status === 'succeeded'
    ).length
    if (
      this.state.view.completedMilestones < this.state.view.totalMilestones &&
      this.state.view.stages.find((stage) => stage.stage === 'implement')?.status === 'success'
    ) {
      this.resetStage('implement')
    }
    this.resetStage('verify')
    this.resetStage('finish')
  }

  private async scaffold(): Promise<void> {
    const record = this.stageRecord('scaffold')
    if (record.status === 'success') return
    await this.runStage('scaffold', async () => {
      const spec = this.state.spec
      const architecture = this.state.architecture
      if (spec === null || architecture === null) throw new Error('Scaffold needs a spec and architecture')
      const files = await this.repoMap.files(400)
      const hasManifest =
        files.includes('package.json') ||
        files.includes('requirements.txt') ||
        files.includes('pyproject.toml')
      if (hasManifest) {
        record.detail = 'Existing project detected; scaffold was skipped and files were left untouched.'
        this.noteDecision('Scaffold skipped because the target already has a project manifest.')
        return
      }

      const template = findBuildTemplate([...spec.stack, this.state.view.goal].join(' '))
      let written: string[] = []
      if (template !== null) {
        const context = {
          projectName: projectNameFromGoal(spec.goal),
          goal: this.state.view.goal
        }
        for (const file of template.files(context)) {
          const rel = safeRelative(file.path)
          if (rel === null) continue
          if (await this.writeText(rel, file.content, false)) written.push(rel)
        }
        record.model = 'template'
        record.detail = `Scaffolded ${written.length} file(s) from the ${template.name} template.`
        this.noteDecision(`Scaffold used the built-in ${template.name} template.`)
      } else {
        const result = await this.modelJson<Array<{ path: string; content: string }>>({
          stage: 'scaffold',
          label: 'Scaffold',
          role: 'strong',
          effort: this.settings.planningEffort,
          system: scaffoldSystemPrompt(),
          prompt: scaffoldPrompt({ spec, architecture, existingFiles: files }),
          validate: validateScaffold
        })
        for (const file of result.value) {
          const rel = safeRelative(file.path)
          if (rel === null) continue
          if (await this.writeText(rel, file.content, false)) written.push(rel)
        }
        record.detail = `Scaffolded ${written.length} file(s) from the architecture.`
      }
      this.state.scaffoldFiles = normalizeRelList([...this.state.scaffoldFiles, ...written])
      this.save()

      if (written.length === 0) {
        record.detail = 'Scaffold produced no new files.'
        return
      }
      const verification = await this.verifyWithRepair({
        kinds: ['install', 'build', 'typecheck'],
        label: 'Scaffold',
        relevantFiles: written
      })
      if (!verification.passed) {
        throw new Error(`The scaffold does not build.\n${verification.summary}`)
      }
      record.output = clip(verification.summary, 1_500)
      record.detail = `Scaffold verified (${verification.steps.filter((step) => step.status === 'success').length} command(s) passed).`
      await this.writeProgress('Implement milestones')
    })
  }

  private milestoneState(id: string): BuildView['milestones'][number] | null {
    return this.state.view.milestones.find((milestone) => milestone.id === id) ?? null
  }

  private refreshMilestone(id: string): void {
    const plan = this.state.plan
    const viewMilestone = this.milestoneState(id)
    const planMilestone = plan?.milestones.find((milestone) => milestone.id === id)
    if (viewMilestone === undefined || viewMilestone === null || planMilestone === undefined) return
    viewMilestone.taskResults = planMilestone.tasks
      .map((task) => this.state.taskResults[task.id])
      .filter((result): result is BuildTaskResult => result !== undefined)
    this.state.view.tasksDone = Object.values(this.state.taskResults).filter(
      (result) => result.status === 'succeeded'
    ).length
  }

  private async runOneTask(task: BuildTask, milestoneId: string): Promise<void> {
    const plan = this.state.plan
    const milestone = plan?.milestones.find((item) => item.id === milestoneId)
    if (milestone === undefined || plan === null) return
    this.assertBudget()
    const model = this.models.roleModel('implementation')
    const files = await this.repoMap.readRelevant(task.files)
    const basePrompt = buildTaskPrompt({
      task,
      milestone,
      spec: this.state.spec as BuildSpec,
      architecture: this.state.architecture as BuildArchitecture,
      fileContents: files
    })
    const existing = this.state.taskResults[task.id]
    const previousIssues =
      existing === undefined ? [] : existing.error !== null ? [existing.error] : existing.issues
    let attemptPrompt = basePrompt
    if (previousIssues.length > 0) {
      attemptPrompt += `\n\nA previous attempt failed:\n- ${previousIssues.join('\n- ')}\nChange the approach instead of repeating it.`
    }
    this.state.taskResults[task.id] = {
      taskId: task.id,
      title: task.title,
      status: 'running',
      summary: '',
      filesChanged: [],
      issues: previousIssues,
      model,
      durationMs: 0,
      tokens: existing?.tokens ?? 0,
      error: null
    }
    this.refreshMilestone(milestoneId)
    this.emitTodos()
    this.save()

    const started = this.now()
    let last: BuildTaskRunnerResult | null = null
    let error: string | null = null
    let attemptTokens = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.assertBudget()
        last = await this.deps.runTask({
          task,
          milestone: { id: milestone.id, title: milestone.title, goal: milestone.goal },
          prompt: attemptPrompt,
          files: task.files,
          model,
          effort: this.settings.implementationEffort,
          signal: this.signal()
        })
        this.state.view.stepsUsed += 1
        attemptTokens += last.tokens ?? 0
        this.addTaskTokens(`Task ${task.id}`, last.model || model, last.tokens ?? 0, last.durationMs)
        error = last.error
      } catch (caught) {
        if (isBuildAbort(caught)) throw new BuildAbortedError()
        error = caught instanceof Error ? caught.message : String(caught)
      }
      if (this.pauseRequested || this.stopRequested) throw new BuildAbortedError()
      if (error === null) break
      attemptPrompt = `${basePrompt}\n\nA previous attempt failed:\n- ${error}\nChange the approach instead of repeating it.`
    }

    const filesChanged = normalizeRelList(last?.filesChanged ?? [])
    this.state.taskResults[task.id] = {
      taskId: task.id,
      title: task.title,
      status: error === null ? 'succeeded' : 'failed',
      summary: last?.summary ?? (error === null ? 'Done.' : ''),
      filesChanged,
      issues: error === null ? [] : [error],
      model: last?.model ?? model,
      durationMs: (existing?.durationMs ?? 0) + (this.now() - started),
      tokens: (existing?.tokens ?? 0) + attemptTokens,
      error
    }
    this.refreshMilestone(milestoneId)
    this.emitTodos()
    this.save()
  }

  private async runMilestoneTasks(milestoneId: string): Promise<void> {
    const plan = this.state.plan
    const milestone = plan?.milestones.find((item) => item.id === milestoneId)
    if (milestone === undefined) return
    const unfinished = (task: BuildTask): boolean => {
      const status = this.state.taskResults[task.id]?.status
      return status !== 'succeeded' && status !== 'failed'
    }
    let pending = milestone.tasks.filter(unfinished)
    const allTaskIds = new Set(plan?.milestones.flatMap((item) => item.tasks.map((task) => task.id)) ?? [])
    const maxConcurrent = Math.max(1, Math.min(6, this.settings.subAgents))
    while (pending.length > 0) {
      this.checkFeedback()
      const ready = pending.filter((task) =>
        task.dependsOn.every(
          (dependency) =>
            !allTaskIds.has(dependency) ||
            this.state.taskResults[dependency]?.status === 'succeeded'
        )
      )
      if (ready.length === 0) {
        for (const task of pending) {
          if (this.state.taskResults[task.id]?.status === 'succeeded') continue
          this.state.taskResults[task.id] = {
            taskId: task.id,
            title: task.title,
            status: 'failed',
            summary: '',
            filesChanged: [],
            issues: ['A dependency did not finish.'],
            model: this.models.roleModel('implementation'),
            durationMs: 0,
            tokens: 0,
            error: 'A dependency did not finish.'
          }
        }
        this.refreshMilestone(milestoneId)
        break
      }
      const batch: BuildTask[] = []
      const batchFiles: string[] = []
      for (const task of ready) {
        if (batch.length >= maxConcurrent) break
        const files = task.files.map(posixRel)
        if (files.some((file) => batchFiles.some((owned) => pathsOverlap(file, owned)))) continue
        batch.push(task)
        batchFiles.push(...files)
      }
      await Promise.all(batch.map((task) => this.runOneTask(task, milestoneId)))
      pending = pending.filter(unfinished)
    }
  }

  private async reviewMilestone(milestoneId: string): Promise<void> {
    const plan = this.state.plan
    const spec = this.state.spec
    const architecture = this.state.architecture
    const milestone = plan?.milestones.find((item) => item.id === milestoneId)
    const viewMilestone = this.milestoneState(milestoneId)
    if (milestone === undefined || spec === null || architecture === null || viewMilestone === null) {
      return
    }
    for (let round = 0; round < 2; round++) {
      this.checkFeedback()
      this.assertBudget()
      const map = await this.projectSummary()
      const review = await this.modelJson<{
        passed: boolean
        issues: Array<{ problem: string; fix: string; files: string[] }>
      }>({
        stage: 'implement',
        label: `Review ${milestone.id}`,
        role: 'strong',
        effort: this.settings.reviewEffort,
        system: reviewSystemPrompt(),
        prompt: milestoneReviewPrompt({
          milestone,
          spec,
          architecture,
          taskResults: milestone.tasks
            .map((task) => this.state.taskResults[task.id])
            .filter((result): result is BuildTaskResult => result !== undefined)
            .map((result) => ({
              taskId: result.taskId,
              summary: result.summary,
              filesChanged: result.filesChanged
            })),
          repoMap: map,
          verification: this.state.verification
        }),
        validate: validateReview
      })
      viewMilestone.attempts = round + 1
      const issues = [...review.value.issues]
      if (!review.value.passed && issues.length === 0) {
        issues.push({
          problem: 'The reviewer marked this milestone as not passing.',
          fix: 'Re-check the milestone goal and close any remaining gaps.',
          files: milestone.tasks.flatMap((task) => task.files).slice(0, 6)
        })
      }
      viewMilestone.review = issues.length === 0 ? 'No issues found.' : issues
        .map((issue) => `${issue.problem} → ${issue.fix}`)
        .join('\n')
      viewMilestone.reviewIssues = issues.map(
        (issue) => `${issue.problem} (${issue.files.join(', ') || 'no files'})`
      )
      if (viewMilestone.review !== null) {
        this.state.milestoneReviews[milestone.id] = viewMilestone.review
      }
      this.save()
      if (issues.length === 0) return

      const affected = new Map<string, string[]>()
      const unowned: Array<{ problem: string; fix: string; files: string[] }> = []
      for (const issue of issues) {
        const owners = milestone.tasks.filter((task) =>
          issue.files.some(
            (file) =>
              task.files.includes(file) ||
              task.files.some((owned) => file.startsWith(`${owned}/`) || owned.startsWith(`${file}/`))
          )
        )
        if (owners.length === 0) unowned.push(issue)
        for (const owner of owners) {
          const list = affected.get(owner.id) ?? []
          list.push(`${issue.problem} → ${issue.fix}`)
          affected.set(owner.id, list)
        }
      }

      for (const [taskId, issueList] of [...affected.entries()].slice(0, 4)) {
        const task = milestone.tasks.find((item) => item.id === taskId)
        if (task === undefined) continue
        const fileContents = await this.repoMap.readRelevant(task.files)
        const prompt = `${buildTaskPrompt({
          task,
          milestone,
          spec,
          architecture,
          fileContents,
          previousIssues: issueList
        })}\n\nA self-review found these concrete problems. Fix them now.`
        try {
          const result = await this.deps.runTask({
            task,
            milestone: { id: milestone.id, title: milestone.title, goal: milestone.goal },
            prompt,
            files: task.files,
            model: this.models.roleModel('implementation'),
            effort: this.settings.implementationEffort,
            signal: this.signal()
          })
          this.state.view.stepsUsed += 1
          this.addTaskTokens(`Task ${task.id}`, result.model, result.tokens ?? 0, result.durationMs)
          const previous = this.state.taskResults[task.id]
          this.state.taskResults[task.id] = {
            taskId: task.id,
            title: task.title,
            status: result.error === null ? 'succeeded' : 'failed',
            summary: result.summary || previous?.summary || '',
            filesChanged: normalizeRelList([
              ...(previous?.filesChanged ?? []),
              ...result.filesChanged
            ]),
            issues: result.error === null ? [] : [result.error],
            model: result.model,
            durationMs: (previous?.durationMs ?? 0) + result.durationMs,
            tokens: (previous?.tokens ?? 0) + (result.tokens ?? 0),
            error: result.error
          }
        } catch (caught) {
          if (isBuildAbort(caught)) throw new BuildAbortedError()
          this.noteDecision(
            `Review fix for ${task.id} failed: ${caught instanceof Error ? caught.message : String(caught)}`
          )
        }
        this.refreshMilestone(milestone.id)
        this.save()
      }

      if (unowned.length > 0) {
        this.assertBudget()
        const issueText = unowned
          .map((issue) => `${issue.problem} → ${issue.fix} (${issue.files.join(', ')})`)
          .join('\n')
        const files = normalizeRelList(unowned.flatMap((issue) => issue.files)).slice(0, 6)
        const snippets = await this.repoMap.readRelevant(files)
        const repair = await this.modelJson<BuildRepairResult>({
          stage: 'implement',
          label: 'Review repair',
          role: 'strong',
          effort: this.settings.reviewEffort,
          system: repairSystemPrompt(),
          prompt: repairPrompt({
            failure: `A self-review found these problems:\n${issueText}`,
            repoMap: map,
            files: snippets,
            previousAttempts: [],
            attempt: round + 1
          }),
          validate: validateRepair
        })
        this.state.view.repairAttempts += 1
        const applied = await this.applyRepair(repair.value)
        for (const error of applied.errors) this.noteDecision(error)
        this.save()
      }
      this.refreshMilestone(milestone.id)
    }
  }

  private async implement(): Promise<void> {
    const record = this.stageRecord('implement')
    if (record.status === 'success') return
    await this.runStage('implement', async () => {
      const plan = this.state.plan
      if (plan === null) throw new Error('Implementation needs a plan')
      this.state.view.planApprovalRequired = false
      const implementStage = record
      implementStage.model = this.models.roleModel('implementation')
      let completed = 0
      for (const milestone of plan.milestones) {
        this.checkFeedback()
        this.assertBudget()
        const viewMilestone = this.milestoneState(milestone.id)
        if (viewMilestone === null) continue
        if (viewMilestone.status === 'succeeded') {
          completed += 1
          continue
        }
        viewMilestone.status = 'running'
        this.state.view.stage = 'implement'
        this.state.view.stageLabel = `Milestone ${completed + 1}/${plan.milestones.length}: ${milestone.title}`
        this.save()

        await this.runMilestoneTasks(milestone.id)
        this.refreshMilestone(milestone.id)
        const failedTasks = this.state.view.milestones
          .find((item) => item.id === milestone.id)
          ?.taskResults.filter((result) => result.status === 'failed')
        if (failedTasks !== undefined && failedTasks.length > 0) {
          viewMilestone.status = 'failed'
          this.save()
          throw new Error(
            `Milestone "${milestone.title}" has failed tasks: ${failedTasks
              .map((task) => task.title)
              .join(', ')}`
          )
        }

        if (this.settings.verifyEachMilestone) {
          const verification = await this.verifyWithRepair({
            kinds: ['install', 'build', 'typecheck', 'test'],
            label: `Milestone ${milestone.id}`,
            relevantFiles: milestone.tasks.flatMap((task) => task.files)
          })
          if (!verification.passed) {
            viewMilestone.status = 'failed'
            this.save()
            throw new Error(
              `Milestone "${milestone.title}" did not pass verification after ${this.settings.repairAttempts} repair attempt(s).\n${verification.summary}`
            )
          }
          viewMilestone.review = viewMilestone.review ?? null
        }

        await this.reviewMilestone(milestone.id)
        this.checkFeedback()
        viewMilestone.status = 'succeeded'
        completed += 1
        this.state.view.completedMilestones = completed
        this.state.view.stageLabel = `Milestone ${completed}/${plan.milestones.length}: ${milestone.title}`
        implementStage.detail = `${completed}/${plan.milestones.length} milestone(s), ${this.state.view.tasksDone}/${this.state.view.tasksTotal} task(s)`
        await this.writeProgress(
          completed < plan.milestones.length
            ? `Next milestone: ${plan.milestones[completed].title}`
            : 'Final verification'
        )
        this.save()
      }
      implementStage.detail = `Implemented ${this.state.view.tasksDone}/${this.state.view.tasksTotal} task(s).`
      implementStage.output = clip(
        plan.milestones
          .map((milestone) => {
            const viewMilestone = this.milestoneState(milestone.id)
            return `${milestone.title}: ${viewMilestone?.status ?? 'pending'}`
          })
          .join('\n')
      )
    })
  }

  private async verifyAll(): Promise<void> {
    const record = this.stageRecord('verify')
    if (record.status === 'success') return
    await this.runStage('verify', async () => {
      this.checkFeedback()
      const kinds: BuildVerifyKind[] = ['install', 'build', 'typecheck', 'lint', 'test']
      if (this.settings.smokeTest) kinds.push('smoke')
      const verification = await this.verifyWithRepair({
        kinds,
        label: 'Final verification',
        relevantFiles: Object.values(this.state.taskResults).flatMap(
          (result) => result.filesChanged
        )
      })
      this.state.verification = verification
      record.detail = verification.passed
        ? `All ${verification.steps.filter((step) => step.status === 'success').length} command(s) passed.`
        : `Verification failed after ${this.settings.repairAttempts} repair attempt(s).`
      record.output = clip(verification.summary, 2_500)
      if (!verification.passed) {
        throw new Error(
          `The build was not verified after ${this.settings.repairAttempts} repair attempt(s).\n${verification.summary}`
        )
      }
      await this.writeProgress('Final report')
    })
  }

  private async finish(): Promise<void> {
    const record = this.stageRecord('finish')
    if (record.status === 'success') return
    await this.runStage('finish', async () => {
      this.checkFeedback()
      const spec = this.state.spec
      const architecture = this.state.architecture
      const plan = this.state.plan
      if (spec === null || architecture === null || plan === null) {
        throw new Error('Final report needs a completed spec, architecture and plan')
      }
      let readmeWritten = false
      if (!existsSync(resolve(this.root, 'README.md'))) {
        const result = await this.modelText({
          stage: 'finish',
          label: 'README',
          role: 'cheap',
          effort: 'low',
          system: readmeSystemPrompt(),
          prompt: readmePrompt({
            goal: this.state.view.goal,
            spec,
            architecture,
            plan,
            verification: this.state.verification
          })
        })
        readmeWritten = await this.writeText('README.md', `${result.value.trim()}\n`, false)
        record.model = result.model
      } else {
        this.noteDecision('README.md already exists; the build left it untouched.')
      }
      const report = this.buildReport('success')
      this.checkFeedback()
      this.state.report = report
      const view = this.state.view
      view.status = 'success'
      view.finishedAt = this.now()
      view.stage = 'finish'
      view.stageLabel = STAGE_LABELS.finish
      view.summary = `Build complete — ${view.tasksDone}/${view.tasksTotal} task(s), ${view.tokensUsed.toLocaleString()} tokens, ${this.state.view.repairAttempts} repair(s).`
      view.error = null
      record.detail = readmeWritten
        ? 'README created, final report ready.'
        : 'Final report ready.'
      record.output = clip(report, 2_500)
      await this.writeProgress('Build complete. Send another request to extend it.')
      this.save()
      try {
        this.deps.onFinalReport?.(report)
      } catch {}
    })
  }

  private async runPipeline(): Promise<void> {
    this.checkFeedback()
    const view = this.state.view
    if (view.status === 'success' || view.status === 'stopped') return
    view.status = 'running'
    view.error = null
    this.save()

    const feedback = this.replanFeedback
    if (this.state.spec === null) {
      await this.runStage('spec', () => this.generateSpec(feedback))
    }
    if (this.state.architecture === null) {
      await this.runStage('architecture', () => this.generateArchitecture(feedback))
    }
    if (this.state.plan === null) {
      await this.runStage('plan', () => this.generatePlan(feedback))
      this.replanFeedback = []
    }
    const plan = this.state.plan
    if (plan === null) throw new Error('The build has no plan')
    const taskCount = plan.milestones.reduce((total, milestone) => total + milestone.tasks.length, 0)
    const approvalRequired = needsPlanApproval(
      this.settings,
      plan.milestones.length,
      taskCount
    )
    view.planApprovalRequired = approvalRequired && !this.state.planApproved
    if (!this.state.planApproved && approvalRequired) {
      view.status = 'awaiting-approval'
      const questions =
        this.settings.clarify && (this.state.spec?.clarifyQuestions.length ?? 0) > 0
          ? this.state.spec?.clarifyQuestions ?? []
          : []
      view.summary =
        `Plan ready: ${plan.milestones.length} milestone(s), ${taskCount} task(s). Approve to build.` +
        (questions.length > 0
          ? `\nAssumptions used (change them in chat if wrong):\n- ${questions.join('\n- ')}`
          : '')
      this.persist()
      this.emit()
      return
    }
    this.state.planApproved = true

    await this.scaffold()
    await this.implement()
    await this.verifyAll()
    await this.finish()
  }

  private buildReport(status: BuildRunStatus): string {
    const view = this.state.view
    const plan = this.state.plan
    const verification = this.state.verification
    const lines = [
      `# Build report — ${view.goal}`,
      '',
      `Status: **${status}**`,
      `Target: ${view.root}`,
      plan !== null
        ? `Plan: ${plan.milestones.length} milestone(s), ${view.tasksTotal} task(s), ${view.tasksDone} completed.`
        : 'Plan: not created.',
      `Repairs: ${view.repairAttempts}`,
      `Tokens: ${view.tokensUsed.toLocaleString()} / ${view.tokenBudget.toLocaleString()}`,
      '',
      '## Verification'
    ]
    if (verification === null) {
      lines.push('No verification command ran. Nothing in this build is verified.')
    } else {
      lines.push(verification.passed ? 'All listed commands ran and passed.' : 'Verification failed.')
      for (const step of verification.steps) {
        lines.push(
          `- \`${step.command || step.kind}\`: ${step.status}` +
            (step.status === 'failed' ? ` (exit ${step.exitCode})` : '')
        )
      }
    }
    const failedTasks = Object.values(this.state.taskResults).filter(
      (result) => result.status === 'failed'
    )
    if (failedTasks.length > 0) {
      lines.push('', '## Unfinished Tasks')
      for (const task of failedTasks) {
        lines.push(`- **${task.title}**: ${task.error ?? 'not finished'}`)
      }
    }
    const issues = Object.entries(this.state.milestoneReviews).flatMap(([id, review]) =>
      review === 'No issues found.' ? [] : [`- ${id}: ${review}`]
    )
    if (issues.length > 0) {
      lines.push('', '## Review Notes')
      lines.push(...issues)
    }
    if (view.assumptions.length > 0) {
      lines.push('', '## Assumptions')
      lines.push(...view.assumptions.map((assumption) => `- ${assumption}`))
    }
    if (this.state.decisions.length > 0) {
      lines.push('', '## Decisions')
      lines.push(...this.state.decisions.map((decision) => `- ${decision}`))
    }
    lines.push(
      '',
      '## Build Docs',
      `- SPEC: ${view.specPath}`,
      `- ARCHITECTURE: ${view.architecturePath}`,
      `- PLAN: ${view.planPath}`,
      `- PROGRESS: ${view.progressPath}`,
      ''
    )
    if (status !== 'success') {
      lines.push(
        'This build did not finish. Files written so far are kept; the final message does not claim the project works.',
        ''
      )
    }
    return lines.join('\n')
  }

  private markCurrentStageInterrupted(detail: string): void {
    const current = this.state.view.stages.find((stage) => stage.status === 'running')
    if (current !== undefined) {
      current.status = 'pending'
      current.detail = detail
      current.durationMs = Math.max(0, this.now() - current.startedAt)
    }
    for (const result of Object.values(this.state.taskResults)) {
      if (result.status === 'running') result.status = 'pending'
    }
    for (const milestone of this.state.view.milestones) {
      if (milestone.status === 'running') milestone.status = 'pending'
      for (const result of milestone.taskResults) {
        if (result.status === 'running') result.status = 'pending'
      }
    }
  }

  private finalizePaused(message?: string): void {
    const view = this.state.view
    view.status = 'paused'
    view.error = message ?? 'Build paused. Resume to continue.'
    this.markCurrentStageInterrupted('Paused')
    this.state.report = this.buildReport('paused')
    this.save()
    if (message !== undefined) this.deps.onNotice?.(message)
  }

  private finalizeStopped(): void {
    const view = this.state.view
    view.status = 'stopped'
    view.error = null
    view.finishedAt = this.now()
    this.markCurrentStageInterrupted('Stopped before completion')
    this.state.report = this.buildReport('stopped')
    this.save()
  }

  private finalizeFailed(error: unknown): void {
    const view = this.state.view
    view.status = 'failed'
    view.error = clip(error instanceof Error ? error.message : String(error), 4_000)
    view.finishedAt = this.now()
    view.summary = `Build stopped: ${view.error}`
    this.markCurrentStageInterrupted('Did not finish')
    this.state.report = this.buildReport('failed')
    this.save()
    try {
      this.deps.onFinalReport?.(this.state.report)
    } catch {}
  }

  private async replan(): Promise<void> {
    const merged = [...this.replanFeedback, ...this.state.pendingFeedback]
      .map((item) => item.trim())
      .filter((item) => item !== '')
    const feedback = [...new Set(merged)].slice(0, 5)
    this.replanFeedback = feedback
    this.state.pendingFeedback = []
    if (this.replanFeedback.length === 0) return
    this.noteDecision(`Applied user feedback: ${this.replanFeedback.join(' | ').slice(0, 500)}`)
    this.previousPlanForReplan = this.state.plan
    this.state.spec = null
    this.state.architecture = null
    this.state.plan = null
    this.state.planApproved = false
    this.state.view.planApprovalRequired = false
    this.state.view.summary = ''
    for (const stage of ['spec', 'architecture', 'plan'] as BuildStageName[]) {
      this.resetStage(stage)
    }
    this.resetStage('implement')
    this.resetStage('verify')
    this.resetStage('finish')
    this.resetStage('scaffold')
    this.state.view.status = 'running'
    this.state.view.error = null
    this.save()
  }

  async approvePlan(): Promise<void> {
    if (this.running || this.state.plan === null) return
    this.state.planApproved = true
    this.state.view.planApprovalRequired = false
    this.state.view.summary = ''
    this.state.view.status = 'running'
    this.state.view.error = null
    this.save()
    await this.start()
  }

  async revise(feedback: string): Promise<void> {
    const clean = feedback.trim().slice(0, 4_000)
    if (clean === '') return
    this.state.pendingFeedback.push(clean)
    if (this.running) return
    const resumable = this.state.view.status === 'awaiting-approval' ||
      this.state.view.status === 'paused'
    if (!resumable) return
    this.state.view.status = 'running'
    this.state.view.summary = ''
    await this.start()
  }

  /**
   * A failed run is resumable: give every task that did not succeed one fresh attempt. Their
   * previous error is kept so the retry prompt can explain what went wrong.
   */
  private prepareRetry(): void {
    const plan = this.state.plan
    if (plan === null) return
    for (const milestone of plan.milestones) {
      const stateMilestone = this.state.view.milestones.find((item) => item.id === milestone.id)
      if (stateMilestone?.status === 'succeeded') continue
      if (stateMilestone !== undefined) stateMilestone.status = 'pending'
      for (const task of milestone.tasks) {
        const result = this.state.taskResults[task.id]
        if (result !== undefined && result.status !== 'succeeded') result.status = 'pending'
      }
    }
  }

  pause(): void {
    if (!this.running) return
    this.pauseRequested = true
    this.controller?.abort()
  }

  stop(): void {
    if (!this.running) return
    this.stopRequested = true
    this.controller?.abort()
  }

  /** Resumes a paused run, or continues an approved plan. */
  async start(): Promise<void> {
    if (this.running) return
    if (this.state.view.status === 'success' || this.state.view.status === 'stopped') return
    if (this.state.view.status === 'awaiting-approval' && !this.state.planApproved) return
    if (this.state.view.status === 'failed') this.prepareRetry()
    this.running = true
    this.pauseRequested = false
    this.stopRequested = false
    this.controller = new AbortController()
    this.state.view.status = 'running'
    this.state.view.error = null
    this.state.view.finishedAt = null
    this.save()
    try {
      let done = false
      while (!done) {
        try {
          await this.runPipeline()
          done = true
        } catch (caught) {
          if (caught instanceof BuildReplanError) {
            await this.replan()
            continue
          }
          throw caught
        }
      }
    } catch (error) {
      if (this.stopRequested) this.finalizeStopped()
      else if (this.pauseRequested || isBuildAbort(error)) this.finalizePaused()
      else if (error instanceof BuildBudgetError) this.finalizePaused(error.message)
      else this.finalizeFailed(error)
    } finally {
      this.running = false
      this.controller = null
    }
  }
}
