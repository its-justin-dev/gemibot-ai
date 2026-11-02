import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, getDatabase } from '../../src/main/services/database.service'
import { BuildRepository } from '../../src/main/services/build-repository.service'
import { BuildRuntimeService } from '../../src/main/services/build-runtime.service'
import type { Agent } from '../../src/main/services/agent.service'
import type {
  BuildModeSetting,
  BuildPersistedState,
  BuildRunStatus,
  BuildStageName,
  BuildTaskResult,
  BuildView
} from '../../src/shared/types/build'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-build-runtime-'))
  workspaces.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

beforeEach(() => {
  closeDatabase()
  getDatabase()
})

afterEach(() => {
  closeDatabase()
})

function seedConversation(id: string): void {
  getDatabase()
    .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, id, 1, 1)
}

function makeView(input: {
  root: string
  id?: string
  conversationId?: string | null
  status?: BuildRunStatus
  updatedAt?: number
  stageStatus?: BuildView['stages'][number]['status']
  taskStatus?: BuildTaskResult['status']
}): BuildView {
  const result: BuildTaskResult = {
    taskId: 't1',
    title: 'Build items',
    status: input.taskStatus ?? 'succeeded',
    summary: 'Items work',
    filesChanged: ['src/items.ts'],
    issues: [],
    model: 'fake',
    durationMs: 5,
    tokens: 10,
    error: null
  }
  const stages = (
    [
      ['spec', 'Spec'],
      ['architecture', 'Architecture'],
      ['plan', 'Plan'],
      ['scaffold', 'Scaffold'],
      ['implement', 'Implementation'],
      ['verify', 'Verify'],
      ['finish', 'Final report']
    ] as Array<[BuildStageName, string]>
  ).map(([stage, label]) => ({
    stage,
    label,
    status: stage === 'spec' ? (input.stageStatus ?? 'success') : ('pending' as const),
    model: '',
    startedAt: 1,
    durationMs: 2,
    detail: '',
    output: ''
  }))
  return {
    id: input.id ?? 'build-1',
    conversationId: input.conversationId ?? 'conv-a',
    root: input.root,
    goal: 'Track inventory across warehouses',
    status: input.status ?? 'paused',
    stage: 'spec',
    stageLabel: 'Spec',
    stages,
    milestones: [
      {
        id: 'm1',
        title: 'Inventory core',
        status: 'succeeded',
        taskResults: [result],
        review: null,
        reviewIssues: [],
        attempts: 1
      }
    ],
    totalMilestones: 1,
    completedMilestones: 1,
    tasksDone: 1,
    tasksTotal: 1,
    tokensUsed: 1_500,
    tokenBudget: 200_000,
    stepsUsed: 4,
    stepBudget: 300,
    repairAttempts: 0,
    maxRepairAttempts: 5,
    planApprovalRequired: false,
    assumptions: [],
    summary: '',
    error: null,
    startedAt: 1,
    updatedAt: input.updatedAt ?? 100,
    finishedAt: null,
    usage: [],
    specPath: join(input.root, '.gemibot', 'SPEC.md'),
    architecturePath: join(input.root, '.gemibot', 'ARCHITECTURE.md'),
    planPath: join(input.root, '.gemibot', 'PLAN.md'),
    progressPath: join(input.root, '.gemibot', 'PROGRESS.md')
  }
}

function makeState(view: BuildView): BuildPersistedState {
  return {
    view,
    spec: null,
    architecture: null,
    plan: null,
    taskResults: { t1: view.milestones[0]?.taskResults[0] as BuildTaskResult },
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

class FakeAgent {
  readonly state = { root: '', tokenSettings: { cheapModel: '' } }
  model = 'gemini-3.8-flash'
  client = {} as Agent['client']
  settingsDict: Record<string, string> = {}
  readonly saves: Array<Record<string, string>> = []
  reads = 0
  readonly settings = {
    readSettingsDict: async (): Promise<Record<string, string>> => {
      this.reads += 1
      return { ...this.settingsDict }
    },
    saveSettings: async (updates: Record<string, string>): Promise<void> => {
      this.saves.push({ ...updates })
      Object.assign(this.settingsDict, updates)
    }
  }
  readonly changeTracker = { recordChange: async (): Promise<void> => {} }
}

interface SetupOptions {
  root: string
  conversationId?: () => string | null
  seedSettings?: Record<string, string>
}

function setup(options: SetupOptions): {
  runtime: BuildRuntimeService
  agent: FakeAgent
  repository: BuildRepository
  states: Array<BuildView | null>
  modes: BuildModeSetting[]
  notices: string[]
  reports: Array<{ report: string; status: BuildRunStatus }>
  todos: Array<Array<Record<string, unknown>>>
} {
  const agent = new FakeAgent()
  agent.state.root = options.root
  agent.settingsDict = { ...options.seedSettings }
  const repository = new BuildRepository()
  const states: Array<BuildView | null> = []
  const modes: BuildModeSetting[] = []
  const notices: string[] = []
  const reports: Array<{ report: string; status: BuildRunStatus }> = []
  const todos: Array<Array<Record<string, unknown>>> = []
  const runtime = new BuildRuntimeService(
    {
      agent: agent as unknown as Agent,
      multiAgent: () => null,
      conversationId: options.conversationId ?? (() => 'conv-a'),
      onState: (view) => states.push(view),
      onMode: (mode) => modes.push(mode),
      onNotice: (text) => notices.push(text),
      onFinalReport: (report, status) => reports.push({ report, status }),
      onTodos: (items) => todos.push(items)
    },
    repository
  )
  return { runtime, agent, repository, states, modes, notices, reports, todos }
}

describe('BuildRuntimeService.init', () => {
  it('restores build settings from the settings store and refreshes the latest run', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    const repository = new BuildRepository()
    repository.save(makeState(makeView({ root, id: 'build-a', conversationId: 'conv-a' })))
    const h = setup({
      root,
      seedSettings: {
        build_mode: 'on',
        build_max_tokens: '31000',
        build_plan_approval: 'ask',
        build_strong_model: 'gemini-3.1-pro-preview'
      }
    })

    await h.runtime.init()

    expect(h.agent.reads).toBe(1)
    expect(h.runtime.mode).toBe('on')
    expect(h.runtime.config).toMatchObject({
      maxTokens: 31_000,
      planApproval: 'ask',
      roleModels: { strong: 'gemini-3.1-pro-preview' }
    })
    expect(h.runtime.view?.id).toBe('build-a')
    expect(h.states.at(-1)?.id).toBe('build-a')
    expect(h.runtime.hasResumable()).toBe(true)
  })

  it('uses explicit saved settings without reading the store and pauses interrupted runs', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    const repository = new BuildRepository()
    repository.save(
      makeState(makeView({ root, status: 'running', stageStatus: 'running' }))
    )
    const h = setup({ root })

    await h.runtime.init({ build_mode: 'off' })

    expect(h.agent.reads).toBe(0)
    expect(h.runtime.mode).toBe('off')
    expect(h.runtime.view).toMatchObject({
      status: 'paused',
      error: 'The app stopped while this build was running. Resume to continue.'
    })
    expect(h.runtime.view?.stages[0]).toMatchObject({
      status: 'pending',
      detail: 'Interrupted by app restart'
    })
  })

  it('switches the visible run when the conversation changes', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    seedConversation('conv-b')
    const repository = new BuildRepository()
    repository.save(makeState(makeView({ root, id: 'build-a', conversationId: 'conv-a' })))
    repository.save(
      makeState(makeView({ root, id: 'build-b', conversationId: 'conv-b', updatedAt: 200 }))
    )
    let conversation = 'conv-a'
    const h = setup({ root, conversationId: () => conversation })

    await h.runtime.init({})
    expect(h.runtime.view?.id).toBe('build-a')

    conversation = 'conv-b'
    h.runtime.refresh()
    expect(h.runtime.view?.id).toBe('build-b')
    expect(h.states.at(-1)?.id).toBe('build-b')
  })
})

describe('BuildRuntimeService.classify', () => {
  it('classifies starts, continuations, approvals and feedback without launching a build', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    const h = setup({ root })
    await h.runtime.init({ build_mode: 'auto' })

    expect(
      h.runtime.classify('Build a complete inventory app with login, reports and a dashboard')
    ).toBe('start')
    expect(h.runtime.isRunning()).toBe(false)

    const repository = new BuildRepository()
    repository.save(makeState(makeView({ root, id: 'paused-run', status: 'paused' })))
    expect(h.runtime.classify('continue')).toBe('resume')
    expect(
      h.runtime.classify('Build a complete analytics dashboard with charts and authentication')
    ).toBe('start')

    repository.save(
      makeState(makeView({ root, id: 'failed-run', status: 'failed', updatedAt: 250 }))
    )
    expect(h.runtime.classify('continue')).toBe('resume')

    repository.save(
      makeState(
        makeView({
          root,
          id: 'approval-run',
          status: 'awaiting-approval',
          updatedAt: 300
        })
      )
    )
    h.runtime.refresh()
    expect(h.runtime.isAwaitingApproval()).toBe(true)
    expect(h.runtime.classify('yes')).toBe('approve')
    expect(h.runtime.classify('Add a CSV export to the report')).toBe('revise')
    expect(h.runtime.classify('What does the plan cover?')).toBe('none')
    expect(h.reports).toEqual([])
  })

  it('stays out of the way when build mode is off or the request is a small edit', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    const h = setup({ root })
    await h.runtime.init({ build_mode: 'off' })

    expect(h.runtime.classify('Build a complete inventory app with login and reports')).toBe('none')

    await h.runtime.updateSettings({ mode: 'auto' })
    expect(h.runtime.classify('Rename the title in src/App.tsx')).toBe('none')
    expect(h.runtime.classify('Build a todo app')).toBe('none')
    expect(h.runtime.classify('/buildmode status')).toBe('none')
  })
})

describe('BuildRuntimeService settings and controls', () => {
  it('applies, clamps and persists settings through applySetting', async () => {
    const h = setup({ root: await workspace(), seedSettings: { build_mode: 'auto' } })
    await h.runtime.init()

    expect(await h.runtime.applySetting('tokens', '250000')).toBe(
      'Build setting tokens updated.'
    )
    expect(h.runtime.config.maxTokens).toBe(250_000)
    expect(h.agent.saves.at(-1)).toMatchObject({ build_max_tokens: '250000' })

    await h.runtime.applySetting('autowrite', 'off')
    await h.runtime.applySetting('approval', 'ask')
    await h.runtime.applySetting('strong_model', '  gemini-3.1-pro-preview  ')
    expect(h.runtime.config).toMatchObject({
      autoApproveEdits: false,
      planApproval: 'ask',
      roleModels: { strong: 'gemini-3.1-pro-preview' }
    })

    expect(await h.runtime.applySetting('mode', 'on')).toBe('Build mode set to on.')
    expect(h.runtime.mode).toBe('on')
    expect(h.modes).toEqual(expect.arrayContaining(['auto', 'on']))

    await h.runtime.applySetting('tokens', '1')
    expect(h.runtime.config.maxTokens).toBe(10_000)
    const saves = h.agent.saves.length

    await expect(h.runtime.applySetting('tokens', 'lots')).rejects.toThrow(
      'tokens expects a number'
    )
    await expect(h.runtime.applySetting('autowrite', 'maybe')).rejects.toThrow(
      'autowrite expects on or off'
    )
    await expect(h.runtime.applySetting('nope', '1')).rejects.toThrow(
      'Unknown build setting "nope"'
    )
    expect(h.agent.saves).toHaveLength(saves)
  })

  it('stops a persisted resumable run and reports it to the UI', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    const repository = new BuildRepository()
    repository.save(makeState(makeView({ root, id: 'paused-run', status: 'paused' })))
    const h = setup({ root })
    await h.runtime.init({})
    expect(h.runtime.hasResumable()).toBe(true)

    h.runtime.stop()

    const row = repository.load('paused-run')
    expect(row?.status).toBe('stopped')
    expect(row?.state.view.finishedAt).toBeTypeOf('number')
    expect(row?.state.view.error).toBeNull()
    expect(h.runtime.view?.status).toBe('stopped')
    expect(h.runtime.hasResumable()).toBe(false)
    expect(h.states.at(-1)?.status).toBe('stopped')

    h.runtime.stop()
  })

  it('reads docs, todos and summary lines from the stored run', async () => {
    const root = await workspace()
    seedConversation('conv-a')
    await mkdir(join(root, '.gemibot'), { recursive: true })
    await writeFile(join(root, '.gemibot', 'SPEC.md'), '# Spec\n\nInventory.\n', 'utf8')
    await writeFile(join(root, '.gemibot', 'PLAN.md'), '# Plan\n\nOne milestone.\n', 'utf8')
    const repository = new BuildRepository()
    repository.save(makeState(makeView({ root, id: 'build-a', conversationId: 'conv-a' })))
    const h = setup({ root })
    await h.runtime.init({ build_mode: 'auto', build_max_tokens: '150000' })

    const docs = await h.runtime.docs()
    expect(docs.docs.map((doc) => doc.name)).toEqual(['SPEC', 'PLAN'])
    expect(h.runtime.todos()).toEqual([
      { content: 'Inventory core: Build items', status: 'completed', taskId: 't1' }
    ])
    const lines = h.runtime.summaryLines().join('\n')
    expect(lines).toContain('Build mode: auto')
    expect(lines).toContain('150,000 tokens')
    expect(lines).toContain('Last build: paused')
    expect(lines).toContain('1/1 milestone(s)')
  })
})
