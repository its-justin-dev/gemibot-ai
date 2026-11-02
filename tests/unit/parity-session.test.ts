import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { ToolError } from '../../src/shared/utils/exceptions'
import { AgentMemory } from '../../src/main/services/agent-memory.service'
import { AgentPaths } from '../../src/main/services/agent-paths.service'
import { AgentSession, type ChooseItem } from '../../src/main/services/agent-session.service'
import { AgentSettings } from '../../src/main/services/agent-settings.service'
import { AgentState, type UndoEntry } from '../../src/main/models/agent-state'
import {
  contentModelDumpJson,
  contentModelValidateJson,
  type Content,
  type Part
} from '../../src/main/models/content'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { toPosix } from '../../src/main/utils/fs-path'
import { fixture } from './load-fixture'
import { scrub } from './scrub'

/**
 * The session layer: paths, the undo stack, checkpoints and revert.
 * Reference data: `tests/fixtures/v1-session.json`, captured by the `# session` section
 * of `tools/parity/dump-v1-fixtures.py`, which drives the real `Agent` methods with
 * `build_system` counted and `choose` patched.  The scenarios run in the same order the
 * dumper ran them because they share one workspace and one transcript.
 *
 * File-backed save/load is gone; the SQLite conversation store owns the transcript, while the
 * undo stack and checkpoint math below stay byte-for-byte v1.0 behavior.
 */
const ref = fixture('v1-session.json')
const storageRef = ref.storage
const agentRef = ref.agent

const workspaces: string[] = []

async function workspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `gemibot-parity-${prefix}-`))
  workspaces.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true })
})

/** Collect what the engine prints, adding the newline `out()` writes to stdout. */
async function capture<T>(fn: () => T | Promise<T>): Promise<[string, T]> {
  const lines: string[] = []
  const unsubscribe = onConsoleOutput((line) => lines.push(line))
  try {
    const value = await fn()
    return [lines.map((line) => `${line}\n`).join(''), value]
  } finally {
    unsubscribe()
  }
}

/** v1.0 scrubs its own temp root; a message can quote both the workspace and its parent. */
function scrubPath(text: string, ws: string): string {
  return scrub(scrub(text, ws), dirname(ws))
}

/** The state dump `dump_state()` wrote, in the same fields and the same rel forms. */
function dumpState(ctx: Ctx): Record<string, unknown> {
  return {
    mode: ctx.state.mode,
    active_function: ctx.state.activeFunction,
    contents: ctx.state.contents.map((content) => contentModelDumpJson(content)),
    checkpoints: ctx.state.checkpoints,
    undo: ctx.state.undoStack.map(([full, oldText, crlf]) => [ctx.paths.rel(full), oldText, crlf]),
    todos: ctx.state.todos,
    timeline_history: ctx.state.timelineHistory,
    builds: ctx.builds
  }
}

interface Ctx {
  ws: string
  paths: AgentPaths
  memory: AgentMemory
  settings: AgentSettings
  session: AgentSession
  state: AgentState
  builds: number
  title: string | null
  items: ChooseItem[] | null
  /** What the picker answers with; the dumper always chose the second row. */
  answer: (items: ChooseItem[]) => string | null
}

async function context(ws: string): Promise<Ctx> {
  const memory = new AgentMemory(ws)
  const settings = new AgentSettings(ws)
  const paths = new AgentPaths(ws)
  const ctx: Ctx = {
    ws,
    paths,
    memory,
    settings,
    builds: 0,
    title: null,
    items: null,
    answer: (items) => (items.length > 1 ? items[1][0] : null),
    state: new AgentState(ws, 'gemini-3.5-flash'),
    session: null as unknown as AgentSession
  }
  ctx.session = new AgentSession({
    paths,
    memory,
    buildSystem: () => {
      ctx.builds += 1
      return '<SYSTEM-REBUILT>'
    },
    choose: (title, items) => {
      ctx.title = title
      ctx.items = items
      return ctx.answer(items)
    }
  })
  await memory.ensureMemory()
  await settings.ensureSettings({
    model: 'gemini-3.5-flash',
    activeFunction: 'all',
    mode: 'build'
  })
  return ctx
}

/** The five transcript entries the fixture saved, parsed the way `load()` does. */
function contents(): Content[] {
  return storageRef.loaded.contents.map((text: string) => contentModelValidateJson(text))
}

/** A `Content` the way v1.0 built it in the dumper, without going through JSON. */
function rawContent(role: string, parts: Part[]): Content {
  return { role, parts }
}

function cloned<T>(value: T): T {
  return structuredClone(value) as T
}

const checkpoints = (): Record<string, unknown>[] => cloned(storageRef.loaded.checkpoints)
const timeline = (): Record<string, unknown>[] => cloned(storageRef.loaded.timeline_history)

/** The two undo rows the fixture used, with this run's absolute paths. */
function undoRows(ws: string): UndoEntry[] {
  return [
    [join(ws, 'src', 'app.py'), 'def f():\r\n    return 1\r\n', true],
    [join(ws, 'new.txt'), null, false]
  ]
}

async function writeBytes(path: string, text: string): Promise<void> {
  await writeFile(path, Buffer.from(text, 'utf-8'))
}

async function readBytes(path: string): Promise<string> {
  return (await readFile(path)).toString('utf-8')
}

describe('Agent paths', () => {
  let ctx: Ctx

  beforeAll(async () => {
    ctx = await context(await workspace('paths-'))
    await mkdir(join(ctx.ws, 'src'), { recursive: true })
    await writeBytes(join(ctx.ws, 'new.txt'), 'brand new')
  })

  it('rel() keeps a path inside the target relative', () => {
    const inputs = [join(ctx.ws, 'src', 'app.py'), join(ctx.ws, 'memory', 'memory.md'), ctx.ws]
    inputs.forEach((input, index) => {
      expect(ctx.paths.rel(input)).toBe(agentRef.rel_cases[index][1])
    })
  })

  it('rel() hands back an absolute Windows path for anything outside', () => {
    const outside = join(dirname(ctx.ws), 'gemibot-parity-outside.txt')
    const rel = ctx.paths.rel(outside)
    expect(scrub(rel, dirname(ctx.ws))).toBe(agentRef.rel_outside[0])
    expect(scrub(rel, dirname(ctx.ws))).toBe(agentRef.rel_outside[1])
    expect(rel === outside).toBe(agentRef.rel_outside_absolute)
  })

  it('rel() matches the case Windows resolve() restores', () => {
    const oddly = join(dirname(ctx.ws), basename(ctx.ws).toUpperCase(), 'src', 'app.py')
    const rel = ctx.paths.rel(oddly)
    expect({
      returns_argument: rel === oddly,
      is_absolute: /^[a-zA-Z]:[\\/]/.test(rel),
      posix_relative: toPosix(rel) === 'src/app.py'
    }).toEqual(agentRef.rel_case_mismatch)

    const ghost = join(dirname(ctx.ws), basename(ctx.ws).toUpperCase(), 'nope-dir', 'ghost.py')
    const relGhost = ctx.paths.rel(ghost)
    expect({
      returns_argument: relGhost === ghost,
      posix_relative: toPosix(relGhost) === 'nope-dir/ghost.py',
      resolved_abs: relGhost === ghost
    }).toEqual(agentRef.rel_case_ghost)
  })

  it('resolve() answers with the same paths and the same refusal', async () => {
    for (const [raw, expected, error] of agentRef.resolve_cases) {
      const input = typeof raw === 'string' ? raw.split('<WS>').join(ctx.ws) : null
      if (error === null) {
        expect(scrubPath(await ctx.paths.resolve(input), ctx.ws)).toBe(scrubPath(expected, ctx.ws))
      } else {
        const thrown = await ctx.paths.resolve(input).then(
          () => null,
          (err: unknown) => err
        )
        expect(thrown).toBeInstanceOf(ToolError)
        const message = `${(thrown as Error).name}: ${(thrown as Error).message}`
        expect(scrubPath(message, ctx.ws)).toBe(scrubPath(error, ctx.ws))
      }
    }
  })

  it('is_within_target() is case-insensitive and never throws', () => {
    expect(ctx.paths.isWithinTarget(join(ctx.ws, 'src'))).toBe(true)
    expect(ctx.paths.isWithinTarget(join(dirname(ctx.ws), 'elsewhere'))).toBe(false)
  })
})

describe('Agent session', () => {
  let ctx: Ctx

  beforeAll(async () => {
    ctx = await context(await workspace('agent-'))
    await mkdir(join(ctx.ws, 'src'), { recursive: true })
    await writeBytes(join(ctx.ws, 'new.txt'), 'brand new')
    await writeBytes(join(ctx.ws, 'src', 'app.py'), 'def f():\r\n    return 2\r\n')
    ctx.state.mode = 'plan'
    ctx.state.activeFunction = 'code'
    ctx.state.contents = contents()
    ctx.state.checkpoints = checkpoints()
    ctx.state.undoStack = undoRows(ctx.ws)
    ctx.state.todos = cloned(storageRef.loaded.todos)
    ctx.state.timelineHistory = timeline()
  })

  it('rebuilds checkpoints from framed prompts, skipping legacy notes and empty parts', async () => {
    const memoryLen = AppConstants.MEMORY_HEADER.length
    ctx.state.contents = [
      rawContent('user', [
        {
          text:
            'prefix noise\nUser Request:\nreal question\n\n' +
            'Note (Required to do last): Log this interaction in /memory/memory.md.'
        }
      ]),
      rawContent('user', [{ text: 'plain prompt\n\nReferenced files:\nsrc/app.py' }]),
      rawContent('model', [{ text: 'a reply' }]),
      rawContent('user', []),
      rawContent('user', [{ text: '' }]),
      rawContent('user', [{ function_response: { name: 'f', response: {} } }]),
      rawContent('user', [{ text: 'last prompt' }])
    ]
    ctx.state.undoStack = [[join(ctx.ws, 'src', 'app.py'), 'old', false]]
    const expected = (agentRef.rebuilt as Array<Record<string, unknown>>).map((cp) => ({
      ...cp,
      memory_len: memoryLen
    }))
    expect(await ctx.session.rebuildCheckpointsFromContents(ctx.state)).toEqual(expected)
  })

  it('undoes the newest change first', async () => {
    ctx.state.contents = []
    ctx.state.checkpoints = []
    ctx.state.undoStack = [
      [join(ctx.ws, 'src', 'app.py'), 'def f():\r\n    return 1\r\n', true],
      [join(ctx.ws, 'made', 'new.txt'), null, false]
    ]

    const [removed] = await capture(() => ctx.session.undo(ctx.state))
    expect(removed).toBe(agentRef.undo_1_print)
    expect(await readBytes(join(ctx.ws, 'src', 'app.py'))).toBe(agentRef.undo_1_file)

    const [restored] = await capture(() => ctx.session.undo(ctx.state))
    expect(restored).toBe(agentRef.undo_2_print)
    expect(existsSync(join(ctx.ws, 'made', 'new.txt'))).toBe(agentRef.undo_2_exists)
    // Deleting a file never recreates the folder it would have lived in.
    expect(existsSync(join(ctx.ws, 'made'))).toBe(agentRef.undo_2_dir_exists)

    const [empty] = await capture(() => ctx.session.undo(ctx.state))
    expect(empty).toBe(agentRef.undo_empty_print)
  })

  it('restores a file into a directory that no longer exists', async () => {
    ctx.state.undoStack = [[join(ctx.ws, 'deep', 'nest', 'f.md'), '# heading\n', false]]
    const [printed] = await capture(() => ctx.session.popAndRestoreFile(ctx.state))
    expect(printed).toBe(agentRef.restore_new_dir_print)
    expect(await readBytes(join(ctx.ws, 'deep', 'nest', 'f.md'))).toBe(
      agentRef.restore_new_dir_bytes
    )
  })

  it('reverts session, files and memory to before the chosen prompt', async () => {
    const memoryText = await ctx.memory.readMemoryContent()
    ctx.state.contents = [
      rawContent('user', [{ text: 'one' }]),
      rawContent('model', [{ text: 'two' }])
    ]
    ctx.state.checkpoints = [
      {
        prompt: 'first prompt',
        time: '09:00:00',
        contents_len: 0,
        undo_len: 0,
        todos: [{ content: 'a', status: 'pending' }],
        memory_len: memoryText.length
      },
      {
        prompt:
          'second prompt with a very long line that should be cut at exactly fifty two characters for the preview',
        time: '09:01:00',
        contents_len: 1,
        undo_len: 1,
        todos: [],
        memory_len: memoryText.length
      },
      {
        prompt: 'third',
        time: '09:02:00',
        contents_len: 2,
        undo_len: 2,
        todos: [],
        memory_len: null
      }
    ]
    ctx.state.todos = [{ content: 'live', status: 'pending' }]
    ctx.state.undoStack = [
      [join(ctx.ws, 'src', 'app.py'), 'first\n', false],
      [join(ctx.ws, 'deep', 'nest', 'f.md'), '# older\n', false],
      [join(ctx.ws, 'made', 'gone.txt'), 'created\n', false]
    ]
    await mkdir(join(ctx.ws, 'made'), { recursive: true })
    await writeBytes(join(ctx.ws, 'made', 'gone.txt'), 'created\n')
    await ctx.memory.io().append('APPENDED ENTRY\n')

    const expected = agentRef.revert
    const [printed] = await capture(() => ctx.session.revert(ctx.state))
    expect(ctx.title).toBe(expected.title)
    expect(ctx.items).toEqual(expected.items)
    expect(printed).toBe(
      String(expected.print).replace(
        'Rolled back /memory/memory.md',
        'Rolled back conversation memory'
      )
    )
    const expectedState = cloned(expected.state) as {
      checkpoints: Array<{ memory_len: number | null }>
    }
    for (const cp of expectedState.checkpoints) {
      if (cp.memory_len !== null) cp.memory_len = memoryText.length
    }
    expect(dumpState(ctx)).toEqual(expectedState)
    expect(await ctx.memory.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)
    expect(await readBytes(join(ctx.ws, 'src', 'app.py'))).toBe(expected.files['src/app.py'])
    expect(await readBytes(join(ctx.ws, 'deep', 'nest', 'f.md'))).toBe(
      expected.files['deep/nest/f.md']
    )
    expect(existsSync(join(ctx.ws, 'made', 'gone.txt'))).toBe(
      expected.files['made/gone.txt_exists']
    )
  })

  it('cancels quietly when the picker answers nothing', async () => {
    ctx.answer = () => null
    const [printed] = await capture(() => ctx.session.revert(ctx.state))
    expect(printed).toBe(agentRef.revert_declined_print)
  })

  it('has nothing to revert to on a fresh transcript', async () => {
    const empty = await context(ctx.ws)
    const [printed] = await capture(() => empty.session.revert(empty.state))
    expect(printed).toBe(agentRef.revert_empty_print)
  })

  it('rolls back to a checkpoint without asking', async () => {
    const other = await context(ctx.ws)
    other.state.contents = [
      rawContent('user', [{ text: 'one' }]),
      rawContent('model', [{ text: 'two' }])
    ]
    other.state.checkpoints = ctx.state.checkpoints
    other.state.undoStack = [[join(ctx.ws, 'src', 'app.py'), 'rollback\n', false]]
    other.state.todos = [{ content: 'live', status: 'pending' }]

    const [printed, ok] = await capture(() => other.session.rollbackToCheckpoint(other.state, 0))
    expect(ok).toBe(agentRef.rollback.returned)
    expect(printed).toBe(agentRef.rollback.print)
    expect(dumpState(other)).toEqual(agentRef.rollback.state)
    expect(await readBytes(join(ctx.ws, 'src', 'app.py'))).toBe(agentRef.rollback.app_py)

    const [after9, bad] = await capture(() => other.session.rollbackToCheckpoint(other.state, 9))
    expect([bad, after9, dumpState(other)]).toEqual(agentRef.rollback_out_of_range)

    const [afterNegative, negative] = await capture(() =>
      other.session.rollbackToCheckpoint(other.state, -1)
    )
    expect([negative, afterNegative]).toEqual(agentRef.rollback_negative)
  })

})
