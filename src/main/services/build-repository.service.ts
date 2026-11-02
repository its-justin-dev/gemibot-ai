import type { BuildPersistedState, BuildRunStatus } from '../../shared/types/build'
import { getDatabase } from './database.service'

const MAX_STATE_CHARS = 4_000_000
const RESUMABLE: BuildRunStatus[] = ['running', 'paused', 'awaiting-approval', 'failed']

export interface BuildRunRow {
  id: string
  conversationId: string | null
  root: string
  goal: string
  status: BuildRunStatus
  stage: string
  state: BuildPersistedState
  tokensUsed: number
  stepsUsed: number
  createdAt: number
  updatedAt: number
}

interface RawRow {
  id: string
  conversation_id: string | null
  root: string
  goal: string
  status: string
  stage: string
  state_json: string
  tokens_used: number
  steps_used: number
  created_at: number
  updated_at: number
}

function parseState(raw: string): BuildPersistedState | null {
  if (raw === '' || raw.length > MAX_STATE_CHARS) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const view = record['view']
    if (view === null || typeof view !== 'object' || Array.isArray(view)) return null
    const id = (view as Record<string, unknown>)['id']
    if (typeof id !== 'string' || id === '') return null
    return parsed as BuildPersistedState
  } catch {
    return null
  }
}

function rowFrom(raw: RawRow): BuildRunRow | null {
  const state = parseState(raw.state_json)
  if (state === null) return null
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    root: raw.root,
    goal: raw.goal,
    status: raw.status as BuildRunStatus,
    stage: raw.stage,
    state,
    tokensUsed: raw.tokens_used,
    stepsUsed: raw.steps_used,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  }
}

export class BuildRepository {
  save(state: BuildPersistedState): void {
    const view = state.view
    const now = Date.now()
    const payload = JSON.stringify(state)
    if (payload.length > MAX_STATE_CHARS) return
    try {
      getDatabase()
        .prepare(
          `INSERT INTO build_runs (
            id, conversation_id, root, goal, status, stage, state_json,
            tokens_used, steps_used, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            root = excluded.root,
            goal = excluded.goal,
            status = excluded.status,
            stage = excluded.stage,
            state_json = excluded.state_json,
            tokens_used = excluded.tokens_used,
            steps_used = excluded.steps_used,
            updated_at = excluded.updated_at`
        )
        .run(
          view.id,
          view.conversationId,
          view.root,
          view.goal.slice(0, 4_000),
          view.status,
          view.stage,
          payload,
          Math.max(0, Math.round(view.tokensUsed)),
          Math.max(0, Math.round(view.stepsUsed)),
          view.startedAt,
          now
        )
    } catch {
      /* a build must keep running even if its history row cannot be written */
    }
  }

  load(id: string): BuildRunRow | null {
    try {
      const row = getDatabase().prepare('SELECT * FROM build_runs WHERE id = ?').get(id) as
        | RawRow
        | undefined
      return row === undefined ? null : rowFrom(row)
    } catch {
      return null
    }
  }

  latestForConversation(conversationId: string): BuildRunRow | null {
    try {
      const row = getDatabase()
        .prepare(
          'SELECT * FROM build_runs WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1'
        )
        .get(conversationId) as RawRow | undefined
      return row === undefined ? null : rowFrom(row)
    } catch {
      return null
    }
  }

  latestForRoot(root: string): BuildRunRow | null {
    try {
      const row = getDatabase()
        .prepare('SELECT * FROM build_runs WHERE root = ? ORDER BY updated_at DESC LIMIT 1')
        .get(root) as RawRow | undefined
      return row === undefined ? null : rowFrom(row)
    } catch {
      return null
    }
  }

  /** The newest paused/awaiting/failed run that "continue" should resume. */
  latestResumable(root: string, conversationId: string | null): BuildRunRow | null {
    const placeholders = RESUMABLE.map(() => '?').join(', ')
    try {
      const rows = getDatabase()
        .prepare(
          `SELECT * FROM build_runs
           WHERE root = ? AND (conversation_id = ? OR conversation_id IS NULL)
             AND status IN (${placeholders})
           ORDER BY updated_at DESC LIMIT 5`
        )
        .all(root, conversationId, ...RESUMABLE) as RawRow[]
      for (const row of rows) {
        const parsed = rowFrom(row)
        if (parsed !== null) return parsed
      }
      return null
    } catch {
      return null
    }
  }

  recent(root: string, limit = 5): BuildRunRow[] {
    try {
      const rows = getDatabase()
        .prepare('SELECT * FROM build_runs WHERE root = ? ORDER BY updated_at DESC LIMIT ?')
        .all(root, Math.max(1, limit)) as RawRow[]
      return rows.map(rowFrom).filter((row): row is BuildRunRow => row !== null)
    } catch {
      return []
    }
  }

  /** A process cannot still be building after it restarted, so settle live rows as paused. */
  markInterrupted(): number {
    try {
      const rows = getDatabase()
        .prepare("SELECT * FROM build_runs WHERE status = 'running'")
        .all() as RawRow[]
      let count = 0
      const update = getDatabase().prepare(
        'UPDATE build_runs SET status = ?, state_json = ?, updated_at = ? WHERE id = ?'
      )
      for (const row of rows) {
        const parsed = rowFrom(row)
        if (parsed === null) continue
        const state = parsed.state
        state.view.status = 'paused'
        state.view.error = 'The app stopped while this build was running. Resume to continue.'
        state.view.updatedAt = Date.now()
        state.view.stages = state.view.stages.map((stage) =>
          stage.status === 'running'
            ? { ...stage, status: 'pending' as const, detail: 'Interrupted by app restart' }
            : stage
        )
        update.run('paused', JSON.stringify(state), Date.now(), row.id)
        count += 1
      }
      return count
    } catch {
      return 0
    }
  }
}

export const buildRepository = new BuildRepository()
