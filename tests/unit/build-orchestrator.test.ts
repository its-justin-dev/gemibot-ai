import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

import { BuildDocsService } from '../../src/main/services/build-docs.service'
import type {
  BuildModelCall,
  BuildModelResult,
  BuildModelService,
  BuildTextCall,
  BuildUsageCounts
} from '../../src/main/services/build-model.service'
import type {
  BuildTaskRunnerInput,
  BuildTaskRunnerResult
} from '../../src/main/services/build-orchestrator.service'
import { BuildOrchestrator } from '../../src/main/services/build-orchestrator.service'
import { BuildRepoMapService } from '../../src/main/services/build-repo-map.service'
import type { BuildRepository } from '../../src/main/services/build-repository.service'
import type { BuildVerifier } from '../../src/main/services/build-verifier.service'
import type {
  BuildArchitecture,
  BuildMilestoneState,
  BuildPersistedState,
  BuildPlan,
  BuildSettings,
  BuildSpec,
  BuildStageName,
  BuildStageRecord,
  BuildTask,
  BuildTaskResult,
  BuildVerification,
  BuildView
} from '../../src/shared/types/build'
import type {
  BuildRepairResult,
  BuildReviewResult
} from '../../src/shared/utils/build-validate'
import { normalizeBuildSettings } from '../../src/shared/utils/build-settings'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-build-run-'))
  workspaces.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

const PASS: BuildVerification = {
  steps: [
    {
      kind: 'build',
      command: 'npm run build',
      status: 'success',
      exitCode: 0,
      output: 'built',
      durationMs: 1
    }
  ],
  passed: true,
  summary: 'Verification passed — 0 failed, 1 succeeded'
}

const FAIL: BuildVerification = {
  steps: [
    {
      kind: 'build',
      command: 'npm run build',
      status: 'failed',
      exitCode: 2,
      output: 'TypeError: broken in src/App.tsx',
      durationMs: 1
    }
  ],
  passed: false,
  summary: 'Verification failed — 1 failed, 0 succeeded'
}

const spec: BuildSpec = {
  goal: 'Track inventory across warehouses',
  users: ['Warehouse staff'],
  features: ['Track stock', 'Reports'],
  stack: ['React'],
  dataModel: ['Item(id, name, quantity)'],
  surfaces: ['/items'],
  outOfScope: ['Billing'],
  assumptions: ['Single tenant'],
  clarifyQuestions: ['Which database should this use?']
}

const architecture: BuildArchitecture = {
  summary: 'React client backed by a small API',
  folders: [{ path: 'src', purpose: 'Application code' }],
  modules: [
    { name: 'items', path: 'src/items', responsibility: 'Inventory UI', dependsOn: [] }
  ],
  contracts: [{ kind: 'type', name: 'Item', signature: 'Item { id: string }', notes: '' }],
  schema: ['items(id, name, quantity)'],
  conventions: ['Strict TypeScript'],
  sharedFiles: []
}

function task(id: string, files: string[], overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    files,
    acceptance: [`${id} works`],
    dependsOn: [],
    ...overrides
  }
}

function planOf(tasks: BuildTask[]): BuildPlan {
  return {
    summary: 'Ship the inventory slice',
    milestones: [
      {
        id: 'm1',
        title: 'Inventory core',
        goal: 'Track stock',
        acceptance: ['Stock is tracked'],
        tasks
      }
    ],
    verification: ['npm test'],
    risks: []
  }
}

interface Script {
  spec?: BuildSpec
  architecture?: BuildArchitecture
  plan?: BuildPlan
  review?: BuildReviewResult
  repair?: BuildRepairResult
  scaffold?: Array<{ path: string; content: string }>
  readme?: string
  usage?: BuildUsageCounts
  hangStage?: string
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

class ScriptedModels {
  readonly script: Script
  readonly jsonCalls: Array<BuildModelCall<unknown>> = []
  readonly textCalls: BuildTextCall[] = []
  hangStarted: Promise<void> | null = null
  onText: ((call: BuildTextCall) => void) | null = null
  private notifyHang: (() => void) | null = null

  constructor(script: Script) {
    this.script = script
    if (script.hangStage !== undefined) {
      this.hangStarted = new Promise((resolve) => {
        this.notifyHang = resolve
      })
    }
  }

  roleModel(role: 'strong' | 'implementation' | 'cheap'): string {
    return `fake-${role}`
  }

  private async hang(signal: AbortSignal | undefined): Promise<never> {
    this.notifyHang?.()
    if (signal?.aborted === true) throw abortError()
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true })
    })
    throw abortError()
  }

  async json<T>(call: BuildModelCall<T>): Promise<BuildModelResult<T>> {
    this.jsonCalls.push(call as BuildModelCall<unknown>)
    if (this.script.hangStage === call.stage) await this.hang(call.signal)
    let value: unknown
    switch (call.stage) {
      case 'spec':
        value = this.script.spec ?? spec
        break
      case 'architecture':
        value = this.script.architecture ?? architecture
        break
      case 'plan':
        value = this.script.plan ?? planOf([task('t1', ['src/feature.ts'])])
        break
      case 'implement':
        value = this.script.review ?? { passed: true, issues: [] }
        break
      case 'verify':
        if (this.script.repair === undefined) throw new Error('No repair was scripted')
        value = this.script.repair
        break
      case 'scaffold':
        value = this.script.scaffold ?? [{ path: 'src/main.ts', content: 'export {}\n' }]
        break
      default:
        throw new Error(`Unexpected JSON stage ${call.stage}`)
    }
    return {
      value: value as T,
      model: `fake-${call.role}`,
      usage: this.script.usage ?? { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      durationMs: 2,
      attempts: 1
    }
  }

  async text(call: BuildTextCall): Promise<BuildModelResult<string>> {
    this.textCalls.push(call)
    this.onText?.(call)
    return {
      value: this.script.readme ?? '# Inventory app\n\nBuilt and verified.\n',
      model: 'fake-cheap',
      usage: this.script.usage ?? { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      durationMs: 1,
      attempts: 1
    }
  }
}

class ScriptedVerifier {
  readonly results: BuildVerification[]
  readonly calls: Array<{ kinds: string[]; install?: boolean }> = []
  private index = 0

  constructor(results: BuildVerification[] = []) {
    this.results = results
  }

  invalidate(): void {}

  async verify(options: { kinds: string[]; install?: boolean }): Promise<BuildVerification> {
    this.calls.push(options)
    const result = this.results[Math.min(this.index, this.results.length - 1)]
    this.index += 1
    return result ?? PASS
  }
}

interface HarnessOptions {
  script: Script
  settings?: Partial<BuildSettings>
  verifier?: ScriptedVerifier
  existing?: BuildPersistedState
  root?: string
  runner?: (
    input: BuildTaskRunnerInput,
    root: string,
    call: number
  ) => Promise<BuildTaskRunnerResult>
}

interface Harness {
  root: string
  orchestrator: BuildOrchestrator
  models: ScriptedModels
  verifier: ScriptedVerifier
  runnerCalls: BuildTaskRunnerInput[]
  notices: string[]
  reports: string[]
  savedStates: BuildPersistedState[]
  todos: Array<Array<Record<string, unknown>>>
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const root = options.root ?? (await workspace())
  const models = new ScriptedModels(options.script)
  const verifier = options.verifier ?? new ScriptedVerifier()
  const runnerCalls: BuildTaskRunnerInput[] = []
  const notices: string[] = []
  const reports: string[] = []
  const savedStates: BuildPersistedState[] = []
  const todos: Array<Array<Record<string, unknown>>> = []
  const settings = normalizeBuildSettings({
    planApproval: 'auto',
    verifyEachMilestone: false,
    ...options.settings
  })
  const orchestrator = new BuildOrchestrator({
    root,
    conversationId: 'conv-1',
    goal: 'Build an inventory tracker',
    settings,
    models: models as unknown as BuildModelService,
    runTask: async (input) => {
      runnerCalls.push(input)
      if (options.runner !== undefined) {
        return await options.runner(input, root, runnerCalls.length)
      }
      const rel = input.task.files[0]
      const full = join(root, rel)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, 'export const implemented = true\n', 'utf8')
      return {
        summary: `Implemented ${input.task.title}`,
        filesChanged: [rel],
        error: null,
        model: 'fake-implementation',
        durationMs: 3,
        tokens: 15
      }
    },
    verifier: verifier as unknown as BuildVerifier,
    docs: new BuildDocsService(root),
    repoMap: new BuildRepoMapService(root),
    repository: {
      save: (state) => {
        savedStates.push(JSON.parse(JSON.stringify(state)) as BuildPersistedState)
      }
    } as Pick<BuildRepository, 'save'>,
    onNotice: (text) => notices.push(text),
    onFinalReport: (report) => reports.push(report),
    onTodos: (items) => todos.push(items),
    existing: options.existing ?? null,
    id: () => 'build-test',
    now: () => 1_000
  })
  return { root, orchestrator, models, verifier, runnerCalls, notices, reports, savedStates, todos }
}

const STAGES: Array<[BuildStageName, string]> = [
  ['spec', 'Spec'],
  ['architecture', 'Architecture'],
  ['plan', 'Plan'],
  ['scaffold', 'Scaffold'],
  ['implement', 'Implementation'],
  ['verify', 'Verify'],
  ['finish', 'Final report']
]

function stageRecords(): BuildStageRecord[] {
  return STAGES.map(([stage, label]) => ({
    stage,
    label,
    status: 'pending',
    model: '',
    startedAt: 0,
    durationMs: 0,
    detail: '',
    output: ''
  }))
}

function taskResult(id: string, files: string[]): BuildTaskResult {
  return {
    taskId: id,
    title: `Task ${id}`,
    status: 'succeeded',
    summary: `old result for ${id}`,
    filesChanged: files,
    issues: [],
    model: 'old-model',
    durationMs: 10,
    tokens: 100,
    error: null
  }
}

function pausedState(input: {
  root: string
  plan: BuildPlan
  results: Record<string, BuildTaskResult>
}): BuildPersistedState {
  const taskList = input.plan.milestones.flatMap((milestone) => milestone.tasks)
  const done = Object.values(input.results).filter((result) => result.status === 'succeeded').length
  const milestones: BuildMilestoneState[] = input.plan.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    status:
      milestone.tasks.every((entry) => input.results[entry.id]?.status === 'succeeded')
        ? 'succeeded'
        : 'pending',
    taskResults: milestone.tasks
      .map((entry) => input.results[entry.id])
      .filter((entry): entry is BuildTaskResult => entry !== undefined),
    review: null,
    reviewIssues: [],
    attempts: 0
  }))
  const view: BuildView = {
    id: 'build-existing',
    conversationId: 'conv-1',
    root: input.root,
    goal: 'Build an inventory tracker',
    status: 'paused',
    stage: 'plan',
    stageLabel: 'Plan',
    stages: stageRecords().map((stage) =>
      ['spec', 'architecture', 'plan'].includes(stage.stage)
        ? { ...stage, status: 'success' as const }
        : stage
    ),
    milestones,
    totalMilestones: input.plan.milestones.length,
    completedMilestones: milestones.filter((milestone) => milestone.status === 'succeeded')
      .length,
    tasksDone: done,
    tasksTotal: taskList.length,
    tokensUsed: 100,
    tokenBudget: 200_000,
    stepsUsed: 3,
    stepBudget: 300,
    repairAttempts: 0,
    maxRepairAttempts: 5,
    planApprovalRequired: false,
    assumptions: spec.assumptions,
    summary: '',
    error: 'Build paused. Resume to continue.',
    startedAt: 500,
    updatedAt: 900,
    finishedAt: null,
    usage: [],
    specPath: join(input.root, '.gemibot', 'SPEC.md'),
    architecturePath: join(input.root, '.gemibot', 'ARCHITECTURE.md'),
    planPath: join(input.root, '.gemibot', 'PLAN.md'),
    progressPath: join(input.root, '.gemibot', 'PROGRESS.md')
  }
  return {
    view,
    spec,
    architecture,
    plan: input.plan,
    taskResults: input.results,
    milestoneReviews: {},
    decisions: [],
    verification: null,
    report: null,
    scaffoldFiles: [],
    pendingFeedback: [],
    planApproved: true,
    budgetWarned: {}
  }
}

function failedState(input: {
  root: string
  plan: BuildPlan
  results: Record<string, BuildTaskResult>
}): BuildPersistedState {
  const state = pausedState(input)
  state.view.status = 'failed'
  state.view.error = 'Milestone "Inventory core" has failed tasks: Task t1'
  const implement = state.view.stages.find((stage) => stage.stage === 'implement')
  if (implement !== undefined) implement.status = 'failed'
  for (const milestone of state.view.milestones) {
    if (milestone.status !== 'succeeded') milestone.status = 'failed'
  }
  return state
}

describe('BuildOrchestrator', () => {
  it('runs a small plan end to end without approval and writes docs, README and the report', async () => {
    const h = await harness({
      script: {
        plan: planOf([task('t1', ['src/feature.ts'])]),
        readme: '# Inventory app\n\nRun `npm run dev`.\n'
      }
    })
    await h.orchestrator.start()

    const view = h.orchestrator.view
    expect(view.status).toBe('success')
    expect(view.error).toBeNull()
    expect(view.planApprovalRequired).toBe(false)
    expect(view.completedMilestones).toBe(1)
    expect(view.tasksDone).toBe(1)
    expect(view.tasksTotal).toBe(1)
    expect(view.stages.every((stage) => stage.status === 'success')).toBe(true)
    expect(view.tokensUsed).toBe(4 * 60 + 40 + 15)
    expect(view.stepsUsed).toBe(8)
    expect(view.repairAttempts).toBe(0)
    expect(h.runnerCalls).toHaveLength(1)
    expect(h.runnerCalls[0].effort).toBe('medium')
    expect(h.runnerCalls[0].model).toBe('fake-implementation')
    expect(h.verifier.calls).toHaveLength(2)
    expect(h.verifier.calls[0].kinds).toEqual(['install', 'build', 'typecheck'])
    expect(h.verifier.calls[1].kinds).toEqual([
      'install',
      'build',
      'typecheck',
      'lint',
      'test',
      'smoke'
    ])
    expect(h.models.jsonCalls.map((call) => call.stage)).toEqual([
      'spec',
      'architecture',
      'plan',
      'implement'
    ])
    expect(h.models.textCalls).toHaveLength(1)
    expect(h.models.textCalls[0]).toMatchObject({ stage: 'finish', role: 'cheap', effort: 'low' })

    const docs = new BuildDocsService(h.root)
    expect((await docs.readAll()).docs.map((doc) => doc.name)).toEqual([
      'SPEC',
      'ARCHITECTURE',
      'PLAN',
      'PROGRESS'
    ])
    expect(await docs.read('PROGRESS')).toContain('Build complete')
    expect(await readFile(join(h.root, 'README.md'), 'utf8')).toContain('# Inventory app')
    expect(await readFile(join(h.root, 'src/feature.ts'), 'utf8')).toContain('implemented')
    expect(await readFile(join(h.root, '.env.example'), 'utf8')).toContain('VITE_API_URL')

    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toContain('# Build report')
    expect(h.reports[0]).toContain('Status: **success**')
    expect(h.reports[0]).toContain('All listed commands ran and passed.')
    expect(h.todos.length).toBeGreaterThan(0)
    expect(h.savedStates.some((state) => state.view.status === 'success')).toBe(true)
    expect(h.savedStates.every((state) => state.view.id === 'build-test')).toBe(true)
    expect(h.notices).toEqual([])
  })

  it('waits for plan approval in ask mode and includes batched clarifying questions', async () => {
    const h = await harness({
      script: { plan: planOf([task('t1', ['src/feature.ts'])]) },
      settings: { planApproval: 'ask', clarify: true }
    })
    await h.orchestrator.start()

    let view = h.orchestrator.view
    expect(view.status).toBe('awaiting-approval')
    expect(view.planApprovalRequired).toBe(true)
    expect(view.summary).toContain('Approve to build')
    expect(view.summary).toContain('Which database should this use?')
    expect(h.runnerCalls).toHaveLength(0)
    expect(view.stages.map((stage) => stage.status)).toEqual([
      'success',
      'success',
      'success',
      'pending',
      'pending',
      'pending',
      'pending'
    ])

    await h.orchestrator.approvePlan()
    view = h.orchestrator.view
    expect(view.status).toBe('success')
    expect(view.planApprovalRequired).toBe(false)
    expect(h.runnerCalls).toHaveLength(1)
  })

  it('pauses at the token budget after warning at 80 percent', async () => {
    const h = await harness({
      script: {
        plan: planOf([task('t1', ['src/feature.ts'])]),
        usage: { inputTokens: 2_500, outputTokens: 1_500, totalTokens: 4_000 }
      },
      settings: { maxTokens: 10_000 }
    })
    await h.orchestrator.start()

    const view = h.orchestrator.view
    expect(view.status).toBe('paused')
    expect(view.error).toContain('Token budget reached (12,000 / 10,000)')
    expect(view.tokensUsed).toBe(12_000)
    expect(view.stages[0].status).toBe('success')
    expect(view.stages[1].status).toBe('success')
    expect(view.stages[2].status).toBe('failed')
    expect(h.notices.some((notice) => notice.includes('80% of its token budget'))).toBe(true)
    expect(h.notices.some((notice) => notice.includes('Token budget reached'))).toBe(true)
    expect(h.reports).toEqual([])
    expect(h.savedStates.some((state) => state.view.status === 'paused')).toBe(true)
    expect(h.savedStates.at(-1)?.report).toContain('This build did not finish')
  })

  it('repairs a failed verification with a real file edit and then passes', async () => {
    const verifier = new ScriptedVerifier([PASS, FAIL, PASS])
    const h = await harness({
      script: {
        plan: planOf([task('t1', ['src/feature.ts'])]),
        repair: {
          diagnosis: 'Update the placeholder text',
          edits: [
            {
              path: 'src/App.tsx',
              search: 'Scaffold ready.',
              replace: 'Scaffold verified.'
            }
          ],
          creates: [],
          deletes: []
        }
      },
      verifier
    })
    await h.orchestrator.start()

    const view = h.orchestrator.view
    expect(view.status).toBe('success')
    expect(view.repairAttempts).toBe(1)
    expect(verifier.calls).toHaveLength(3)
    expect(h.models.jsonCalls.map((call) => call.stage)).toEqual([
      'spec',
      'architecture',
      'plan',
      'implement',
      'verify'
    ])
    const app = await readFile(join(h.root, 'src/App.tsx'), 'utf8')
    expect(app).toContain('Scaffold verified.')
    expect(app).not.toContain('Scaffold ready.')
    expect(view.stages.find((stage) => stage.stage === 'verify')?.status).toBe('success')
  })

  it('retries a failed task once with the real error in the prompt', async () => {
    const h = await harness({
      script: { plan: planOf([task('t1', ['src/feature.ts'])]) },
      runner: async (input, root, call) => {
        if (call === 1) {
          return {
            summary: '',
            filesChanged: [],
            error: 'boom: missing export',
            model: 'fake-implementation',
            durationMs: 1,
            tokens: 5
          }
        }
        const full = join(root, input.task.files[0])
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, 'export const fixed = true\n', 'utf8')
        return {
          summary: 'Fixed the export',
          filesChanged: [input.task.files[0]],
          error: null,
          model: 'fake-implementation',
          durationMs: 2,
          tokens: 10
        }
      }
    })
    await h.orchestrator.start()

    expect(h.orchestrator.view.status).toBe('success')
    expect(h.runnerCalls).toHaveLength(2)
    expect(h.runnerCalls[1].prompt).toContain('A previous attempt failed')
    expect(h.runnerCalls[1].prompt).toContain('boom: missing export')
    expect(h.runnerCalls[1].prompt).toContain('Change the approach instead of repeating it.')
    expect(h.orchestrator.persisted.taskResults.t1).toMatchObject({
      status: 'succeeded',
      summary: 'Fixed the export',
      tokens: 15
    })
  })

  it('stops after a task keeps failing and reports the unfinished milestone honestly', async () => {
    const h = await harness({
      script: {
        plan: planOf([
          task('t1', ['src/feature.ts']),
          task('t2', ['src/other.ts'], { dependsOn: ['t1'] })
        ])
      },
      runner: async () => ({
        summary: '',
        filesChanged: [],
        error: 'compiler exploded',
        model: 'fake-implementation',
        durationMs: 1,
        tokens: 5
      })
    })
    await h.orchestrator.start()

    const view = h.orchestrator.view
    expect(view.status).toBe('failed')
    expect(view.error).toContain('has failed tasks: Task t1')
    expect(h.runnerCalls).toHaveLength(2)
    expect(h.orchestrator.persisted.taskResults.t1).toMatchObject({
      status: 'failed',
      error: 'compiler exploded'
    })
    expect(h.orchestrator.persisted.taskResults.t2).toMatchObject({
      status: 'failed',
      error: 'A dependency did not finish.'
    })
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toContain('Status: **failed**')
    expect(h.reports[0]).toContain('## Unfinished Tasks')
    expect(h.reports[0]).toContain('compiler exploded')
    expect(h.reports[0]).toContain('A dependency did not finish.')
    expect(h.reports[0]).toContain('This build did not finish.')
  })

  it('replans on feedback and only reruns tasks whose definition changed', async () => {
    const root = await workspace()
    await writeFile(join(root, 'package.json'), '{"scripts":{"build":"tsc"}}\n')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/feature.ts'), 'export const old = true\n')
    const unchanged = task('t1', ['src/feature.ts'])
    const originalPlan = planOf([unchanged])
    const newPlan = planOf([unchanged, task('t2', ['src/export.ts'])])
    const existing = pausedState({
      root,
      plan: originalPlan,
      results: { t1: taskResult('t1', ['src/feature.ts']) }
    })
    const h = await harness({
      script: { plan: newPlan },
      root,
      existing
    })

    await h.orchestrator.revise('Add an export CSV feature')

    const view = h.orchestrator.view
    expect(view.status).toBe('success')
    expect(h.runnerCalls.map((call) => call.task.id)).toEqual(['t2'])
    expect(h.orchestrator.persisted.taskResults.t1).toEqual(existing.taskResults.t1)
    expect(h.orchestrator.persisted.taskResults.t2).toMatchObject({ status: 'succeeded' })
    expect(h.orchestrator.persisted.decisions.join('\n')).toContain(
      'Applied user feedback: Add an export CSV feature'
    )
    expect(
      h.models.jsonCalls.find((call) => call.stage === 'plan')?.prompt
    ).toContain('Add an export CSV feature')
    expect(view.tasksTotal).toBe(2)
    expect(view.tasksDone).toBe(2)
    expect(view.completedMilestones).toBe(1)
    expect(h.verifier.calls).toHaveLength(1)
  })

  it('pauses in-flight work and can resume from the persisted checkpoint', async () => {
    const h = await harness({
      script: { hangStage: 'spec' }
    })
    const running = h.orchestrator.start()
    await h.models.hangStarted
    h.orchestrator.pause()
    await running

    const view = h.orchestrator.view
    expect(view.status).toBe('paused')
    expect(view.error).toBe('Build paused. Resume to continue.')
    expect(view.stages[0]).toMatchObject({ status: 'pending', detail: 'Paused' })
    expect(h.savedStates.at(-1)?.view.status).toBe('paused')
  })

  it('stops in-flight work with a terminal stopped state and report', async () => {
    const h = await harness({
      script: { hangStage: 'spec' }
    })
    const running = h.orchestrator.start()
    await h.models.hangStarted
    h.orchestrator.stop()
    await running

    const view = h.orchestrator.view
    expect(view.status).toBe('stopped')
    expect(view.error).toBeNull()
    expect(view.finishedAt).not.toBeNull()
    expect(view.stages[0]).toMatchObject({ status: 'pending', detail: 'Stopped before completion' })
    expect(h.savedStates.at(-1)?.report).toContain('Status: **stopped**')
    expect(h.reports).toEqual([])
  })

  it('resumes a failed run and retries every task that did not succeed', async () => {
    const root = await workspace()
    const plan = planOf([task('t1', ['src/feature.ts'])])
    const failed: BuildTaskResult = {
      ...taskResult('t1', ['src/feature.ts']),
      status: 'failed',
      summary: '',
      issues: ['boom: missing export'],
      error: 'boom: missing export',
      tokens: 5
    }
    const existing = failedState({ root, plan, results: { t1: failed } })
    const h = await harness({ script: { plan }, root, existing })
    await h.orchestrator.start()

    const view = h.orchestrator.view
    expect(view.status).toBe('success')
    expect(h.runnerCalls).toHaveLength(1)
    expect(h.runnerCalls[0].prompt).toContain('boom: missing export')
    expect(h.orchestrator.persisted.taskResults.t1).toMatchObject({
      status: 'succeeded',
      tokens: 20
    })
    expect(view.tasksDone).toBe(1)
  })

  it('treats a review that did not pass as work to fix even when it lists no issues', async () => {
    const h = await harness({
      script: {
        plan: planOf([task('t1', ['src/feature.ts'])]),
        review: { passed: false, issues: [] }
      }
    })
    await h.orchestrator.start()

    expect(h.orchestrator.view.status).toBe('success')
    expect(h.runnerCalls).toHaveLength(3)
    expect(h.orchestrator.view.milestones[0].review).toContain('not passing')
  })

  it('runs tasks whose files overlap one at a time', async () => {
    let active = 0
    let maxActive = 0
    const h = await harness({
      script: {
        plan: planOf([task('t1', ['src/lib']), task('t2', ['src/lib/util.ts'])])
      },
      runner: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        active -= 1
        return {
          summary: 'done',
          filesChanged: [],
          error: null,
          model: 'fake-implementation',
          durationMs: 1,
          tokens: 1
        }
      }
    })
    await h.orchestrator.start()

    expect(h.orchestrator.view.status).toBe('success')
    expect(h.runnerCalls).toHaveLength(2)
    expect(maxActive).toBe(1)
  })

  it('replans when feedback arrives while the final report is being written', async () => {
    const h = await harness({
      script: { plan: planOf([task('t1', ['src/feature.ts'])]) }
    })
    let sent = false
    h.models.onText = () => {
      if (sent) return
      sent = true
      void h.orchestrator.revise('Add a CSV export page')
    }
    await h.orchestrator.start()

    expect(h.orchestrator.view.status).toBe('success')
    expect(h.orchestrator.persisted.decisions.join('\n')).toContain(
      'Applied user feedback: Add a CSV export page'
    )
    expect(h.models.jsonCalls.filter((call) => call.stage === 'plan')).toHaveLength(2)
  })
})
