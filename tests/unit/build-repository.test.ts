import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDatabase, getDatabase } from '../../src/main/services/database.service'
import {
  BuildRepository
} from '../../src/main/services/build-repository.service'
import type {
  BuildPersistedState,
  BuildStageName,
  BuildView
} from '../../src/shared/types/build'

function makeView(overrides: Partial<BuildView> = {}): BuildView {
  return {
    id: 'build-1',
    conversationId: null,
    root: 'C:/tmp/inventory',
    goal: 'Build an inventory app',
    status: 'paused',
    stage: 'spec',
    stageLabel: 'Spec',
    stages: (
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
    tokenBudget: 200_000,
    stepsUsed: 0,
    stepBudget: 300,
    repairAttempts: 0,
    maxRepairAttempts: 5,
    planApprovalRequired: false,
    assumptions: [],
    summary: '',
    error: null,
    startedAt: 1_000,
    updatedAt: 1_000,
    finishedAt: null,
    usage: [],
    specPath: 'C:/tmp/inventory/.gemibot/SPEC.md',
    architecturePath: 'C:/tmp/inventory/.gemibot/ARCHITECTURE.md',
    planPath: 'C:/tmp/inventory/.gemibot/PLAN.md',
    progressPath: 'C:/tmp/inventory/.gemibot/PROGRESS.md',
    ...overrides
  }
}

function makeState(view: BuildView): BuildPersistedState {
  return {
    view,
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

function seedConversation(id: string): void {
  getDatabase()
    .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, id, 1, 1)
}

function setUpdatedAt(id: string, updatedAt: number): void {
  getDatabase().prepare('UPDATE build_runs SET updated_at = ? WHERE id = ?').run(updatedAt, id)
}

function insertRawRow(input: {
  id: string
  conversationId?: string | null
  root: string
  status: string
  stateJson: string
  updatedAt: number
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO build_runs (
        id, conversation_id, root, goal, status, stage, state_json,
        tokens_used, steps_used, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.conversationId ?? null,
      input.root,
      'goal',
      input.status,
      'spec',
      input.stateJson,
      0,
      0,
      1,
      input.updatedAt
    )
}

beforeEach(() => {
  closeDatabase()
  getDatabase()
})

afterEach(() => {
  closeDatabase()
})

describe('build_runs schema', () => {
  it('creates the table and lookup indexes at schema v11', () => {
    const db = getDatabase()
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'build_runs'")
      .get() as { name: string } | undefined
    expect(table?.name).toBe('build_runs')
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'build_runs'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_build_runs_conversation', 'idx_build_runs_root'])
    )
  })
})

describe('BuildRepository persistence', () => {
  it('saves, loads and updates a run by id', () => {
    const repository = new BuildRepository()
    const state = makeState(makeView())
    state.view.goal = 'Track inventory across warehouses'
    state.view.tokensUsed = 1_234
    state.view.stepsUsed = 7
    state.decisions = ['Use SQLite']
    repository.save(state)

    const loaded = repository.load('build-1')
    expect(loaded).not.toBeNull()
    expect(loaded).toMatchObject({
      id: 'build-1',
      root: 'C:/tmp/inventory',
      goal: 'Track inventory across warehouses',
      status: 'paused',
      tokensUsed: 1_234,
      stepsUsed: 7,
      createdAt: 1_000
    })
    expect(loaded?.state.decisions).toEqual(['Use SQLite'])

    state.view.status = 'success'
    state.view.tokensUsed = 2_000
    repository.save(state)
    const updated = repository.load('build-1')
    expect(updated?.status).toBe('success')
    expect(updated?.tokensUsed).toBe(2_000)
    const count = getDatabase()
      .prepare('SELECT COUNT(*) AS count FROM build_runs')
      .get() as { count: number }
    expect(count.count).toBe(1)
  })

  it('stores conversation links and finds the latest run for a conversation or root', () => {
    seedConversation('conv-1')
    const repository = new BuildRepository()
    const first = makeState(makeView({ id: 'build-a', conversationId: 'conv-1', goal: 'first' }))
    const second = makeState(makeView({ id: 'build-b', conversationId: 'conv-1', goal: 'second' }))
    repository.save(first)
    repository.save(second)
    setUpdatedAt('build-a', 100)
    setUpdatedAt('build-b', 200)

    expect(repository.latestForConversation('conv-1')?.id).toBe('build-b')
    expect(repository.latestForConversation('missing')).toBeNull()
    expect(repository.latestForRoot('C:/tmp/inventory')?.id).toBe('build-b')

    const otherRoot = makeState(makeView({ id: 'build-c', root: 'C:/tmp/other', goal: 'other' }))
    repository.save(otherRoot)
    setUpdatedAt('build-c', 300)
    expect(repository.latestForRoot('C:/tmp/inventory')?.id).toBe('build-b')
    expect(repository.latestForRoot('C:/tmp/other')?.id).toBe('build-c')
  })

  it('returns only resumable states, newest first, including null conversations', () => {
    seedConversation('conv-1')
    const repository = new BuildRepository()
    repository.save(
      makeState(makeView({ id: 'paused', conversationId: 'conv-1', status: 'paused' }))
    )
    repository.save(
      makeState(makeView({ id: 'awaiting', conversationId: null, status: 'awaiting-approval' }))
    )
    repository.save(
      makeState(makeView({ id: 'success', conversationId: 'conv-1', status: 'success' }))
    )
    repository.save(
      makeState(makeView({ id: 'running', conversationId: 'conv-1', status: 'running' }))
    )
    setUpdatedAt('paused', 100)
    setUpdatedAt('awaiting', 200)
    setUpdatedAt('success', 300)
    setUpdatedAt('running', 400)

    expect(repository.latestResumable('C:/tmp/inventory', 'conv-1')?.id).toBe('running')
    expect(repository.latestResumable('C:/tmp/inventory', null)?.id).toBe('awaiting')
    expect(repository.latestResumable('C:/tmp/unknown', 'conv-1')).toBeNull()
  })

  it('lists recent runs with a bound and skips unreadable state', () => {
    const repository = new BuildRepository()
    for (let index = 0; index < 4; index++) {
      repository.save(
        makeState(makeView({ id: `build-${index}`, goal: `goal ${index}`, status: 'success' }))
      )
      setUpdatedAt(`build-${index}`, 100 + index)
    }
    insertRawRow({
      id: 'corrupt',
      root: 'C:/tmp/inventory',
      status: 'paused',
      stateJson: '{"view":{"id":""}}',
      updatedAt: 50
    })
    const recent = repository.recent('C:/tmp/inventory', 2)
    expect(recent.map((row) => row.id)).toEqual(['build-3', 'build-2'])
    expect(repository.load('corrupt')).toBeNull()
  })

  it('ignores oversized state payloads instead of writing them', () => {
    const repository = new BuildRepository()
    const state = makeState(makeView({ id: 'huge' }))
    state.decisions = ['x'.repeat(4_100_000)]
    repository.save(state)
    expect(repository.load('huge')).toBeNull()
  })
})

describe('BuildRepository.markInterrupted', () => {
  it('settles live runs as paused with an explicit restart message', () => {
    const repository = new BuildRepository()
    const state = makeState(makeView({ id: 'live', status: 'running' }))
    state.view.stages[0].status = 'running'
    state.view.stages[0].startedAt = 900
    state.view.stages[1].status = 'success'
    repository.save(state)

    expect(repository.markInterrupted()).toBe(1)
    const loaded = repository.load('live')
    expect(loaded?.status).toBe('paused')
    expect(loaded?.state.view.status).toBe('paused')
    expect(loaded?.state.view.error).toContain('The app stopped while this build was running')
    expect(loaded?.state.view.stages[0]).toMatchObject({
      status: 'pending',
      detail: 'Interrupted by app restart'
    })
    expect(loaded?.state.view.stages[1].status).toBe('success')
    expect(repository.markInterrupted()).toBe(0)
  })
})
