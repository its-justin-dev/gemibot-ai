import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { C } from '../../src/shared/constants/colors'
import { AppConstants } from '../../src/shared/constants/app-constants'
import { EffortLevel } from '../../src/shared/models/effort-level'
import { pyFormatThousands } from '../../src/shared/utils/pyformat'
import { pyLen, pySplitlines } from '../../src/shared/utils/pystr'
import type { WindowEvent } from '../../src/shared/types/window'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { getDatabase, getDbPath } from '../../src/main/services/database.service'
import { conversationPersistence } from '../../src/main/services/conversation-persistence.service'
import { memoryRepository } from '../../src/main/services/long-term-repository.service'
import { Agent } from '../../src/main/services/agent.service'
import type { CatalogItem } from '../../src/main/services/model-catalog.service'
import { WindowRuntime, type WindowTransport } from '../../src/main/services/window-runtime.service'
import type { EngineResponse, UsageCounts } from '../../src/main/services/ai-client.service'
import type { Part } from '../../src/main/models/content'

/**
 * Stage 4b parity tests for `WindowRuntime` — the engine-facing half of `GemibotWindowApp`.
 *
 * The evidence is the event stream, v2.0's shape of v1.0's widget writes.  Every expectation is a
 * literal handed to a widget in `views/window_app.py`, with the line it comes from, frozen here as
 * an inline string (never read from `current.v1.0/`) so the suite still proves parity once v1.0 is
 * shut down.
 *
 * Multi-write methods are asserted as whole streams, not per widget: `_sync_stats()` (5314) writes
 * `stats_lbl`, `mode_var`, `func_menu`, `model_menu`, `active_target_lbl` and `top_path_lbl` in
 * that order, and that order is what the renderer replays.
 *
 * A fake transport stands in for the Electron bridge, so nothing here imports `electron`.  The
 * model is `gemini-3.1-flash-lite` (a thinking model, so the effort suffix shows), the catalog is
 * pinned to one entry and `effort_level` to MEDIUM, which makes every composed string below a
 * fixed literal.
 */

/** The internet pre-flight is a real socket probe, so that module becomes a switch. */
const network = vi.hoisted(() => ({
  online: true,
  gate: null as Promise<void> | null
}))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => {
    if (network.gate) await network.gate
    return network.online
  }
}))

const MODEL_ID = 'gemini-3.1-flash-lite'
/** What `available_models()` (3688) is pinned to return, i.e. `model_id_to_display[MODEL_ID]`. */
const MODEL_DISPLAY = 'Gemini Test Model'
/** `_format_model_button_text()` (5420) for a thinking model at MEDIUM effort. */
const BUTTON = `${MODEL_DISPLAY} • ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`
/** The 17-entry `func_display_to_code` literal `_init_display_catalogs` (3683) seeds first. */
const ALL_FUNCTIONS = '🚀 All Functions (Full Access)'

/** `ChangeTracker.get_summary()` with nothing pending, the shape the drawer and snapshot share. */
const EMPTY_SUMMARY = {
  total_changes: 0,
  counts: { Added: 0, Modified: 0, Deleted: 0, Generated: 0, 'Document edited': 0 },
  files_read: [],
  changes: []
}

/** `font_size_map` (3650) — its iteration order is the dropdown order. */
const FONT_LABELS = [
  'UI Scale: 11px (Compact)',
  'UI Scale: 12px (Small)',
  'UI Scale: 13px (Normal)',
  'UI Scale: 14px (Medium)',
  'UI Scale: 15px (Large)',
  'UI Scale: 16px (Extra Large)',
  'UI Scale: 18px (Huge)'
]

/** `show_welcome_message()` (5303). */
const WELCOME =
  'Hey bro! Welcome to **GemiBot AI**.\n\n' +
  "I'm ready with full multimodal access, terminal execution, and automatic memory logging in " +
  'the conversation database.\n\n' +
  'Ask me anything, have me write or edit code, or run direct commands!'

/** The badge `_build_ui` starts on — a different green from the one `_on_turn_finished` sets. */
const INITIAL_STATUS = { text: '● READY', color: '#10b981' } as const

const THINKING = { kind: 'status', text: '● THINKING...', color: '#f59e0b' } as const
const READY = { kind: 'status', text: '● READY', color: '#22c55e' } as const
const STOPPING = { kind: 'status', text: '● STOPPING...', color: '#ef4444' } as const

class FakeTransport implements WindowTransport {
  readonly events: WindowEvent[] = []
  readonly permissionCalls: [string, string][] = []
  readonly browseCalls: [string, string][] = []
  readonly copyCalls: string[] = []
  readonly openCalls: string[] = []
  confirmClearAnswers: boolean[] = []
  permissionAnswer: boolean | 'always' = true
  browseAnswer = ''
  openAnswer = ''
  quitCount = 0
  cancelPermissionCount = 0
  copyThrows = false

  emit(event: WindowEvent): void {
    this.events.push(event)
  }
  async readLine(): Promise<string | null> {
    return ''
  }
  async permission(tool: string, detail: string): Promise<boolean | 'always'> {
    this.permissionCalls.push([tool, detail])
    return this.permissionAnswer
  }
  cancelPermission(): void {
    this.cancelPermissionCount += 1
  }
  async confirmClear(): Promise<boolean> {
    return this.confirmClearAnswers.shift() ?? false
  }
  async browseDirectory(defaultPath: string, title: string): Promise<string> {
    this.browseCalls.push([defaultPath, title])
    return this.browseAnswer
  }
  writeClipboard(text: string): void {
    if (this.copyThrows) throw new Error('clipboard unavailable')
    this.copyCalls.push(text)
  }
  async openPath(path: string): Promise<string> {
    this.openCalls.push(path)
    return this.openAnswer
  }
  quit(): void {
    this.quitCount += 1
  }

  /** Everything written so far, then forget it. */
  take(): WindowEvent[] {
    const seen = this.events.slice()
    this.events.length = 0
    return seen
  }

  /** One widget's writes, leaving the stream alone. */
  of<K extends WindowEvent['kind']>(kind: K): Extract<WindowEvent, { kind: K }>[] {
    return this.events.filter((e): e is Extract<WindowEvent, { kind: K }> => e.kind === kind)
  }
}

let root = ''
const roots: string[] = []
let raw = ''
let mirrored: string[] = []
let detach: (() => void) | null = null
let transport: FakeTransport
let openingPush: WindowEvent[] = []

async function makeRuntime(): Promise<{ runtime: WindowRuntime; agent: Agent }> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-window-'))
  roots.push(root)
  const agent = await Agent.create({
    root,
    model: MODEL_ID,
    // A non-empty placeholder keeps the SDK's missing-key warning out of the test log; the client
    // itself is replaced before any request could be made.
    apiKey: 'parity-test-placeholder',
    execute: async () => ({ ok: true }),
    choose: async () => null,
    readLine: async () => ''
  })
  // `available_models()` would fire the catalog refresh over the network, and v1.0 reads only the
  // pre-refresh cache anyway, so the picker list is pinned to one entry.
  agent.cli.availableModels = (): CatalogItem[] => [[MODEL_ID, MODEL_DISPLAY]]
  agent.effortLevel = EffortLevel.MEDIUM
  const runtime = await WindowRuntime.create(agent, transport)
  // The drawer is wired last, and `set_drawer_widget` (changes_controller.py:31) pushes its opening
  // summary into the stream; it is asserted on its own below, so the other tests start clean.
  openingPush = transport.take()
  return { runtime, agent }
}

/** The six `_sync_stats()` writes (5314) for the folder the engine is pointed at. */
function statsWrites(
  options: { root?: string; mode?: string; functionMenu?: string; turns?: number } = {}
): WindowEvent[] {
  const dir = options.root ?? root
  const mode = options.mode ?? 'BUILD'
  const functionMenu = options.functionMenu ?? ALL_FUNCTIONS
  const turns = options.turns ?? 0
  const stats = `Tokens: 0 | Turns: ${turns} | Model: ${MODEL_DISPLAY} | Effort: ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`
  return [
    { kind: 'stats', text: stats },
    { kind: 'mode', text: mode },
    { kind: 'function-menu', text: functionMenu },
    { kind: 'model-button', text: BUTTON },
    { kind: 'active-target', text: dir },
    { kind: 'top-path', text: `\u{1F4C1} ${basename(dir)}  •  memory` }
  ]
}

/** What the dependency installer writes when the workspace has no Node manifest. */
function missingPackageJsonReport(dir: string): string {
  return [
    '# Install Project Dependencies',
    '',
    'No package.json was found in the workspace.',
    '',
    `- Workspace: ${dir}`,
    '- Supported projects: npm, pnpm, yarn and bun',
    '- Fix: point the WORKSPACE card at a Node.js or TypeScript project.'
  ].join('\n')
}

/**
 * The stream tests compare ordering and payload, not the header lines.
 *
 * `header` and `thinking` are composed from a wall clock that ticks every second, so a whole-stream
 * `toEqual` cannot name them; they are asserted on their own in the block at the end of this file.
 * Everything else about a row — its kind, its text, its position in the stream — is compared
 * exactly, and the fields are listed here rather than spread-and-delete so a field added by
 * accident shows up as a failing expectation instead of passing unnoticed.
 */
function bare(events: WindowEvent[]): unknown[] {
  return events.map((event) => {
    switch (event.kind) {
      case 'assistant':
        return { kind: event.kind, text: event.text, meta: event.meta }
      case 'user':
        return { kind: event.kind, text: event.text, cpIdx: event.cpIdx }
      case 'error':
        return {
          kind: event.kind,
          title: event.title,
          message: event.message,
          details: event.details,
          icon: event.icon
        }
      case 'generating':
        return { kind: event.kind, active: event.active }
      default:
        return event
    }
  })
}

function response(parts: Part[], usage: UsageCounts | null = null): EngineResponse {
  return {
    candidates: [{ content: { role: 'model', parts } }],
    text: parts.map((p) => p.text ?? '').join(''),
    usage_metadata: usage,
    raw_response: null
  }
}

/** Replace the request with a fixed reply. */
function stubClient(agent: Agent, text: string): void {
  agent.client.generateContent = async () => response([{ text }])
}

/**
 * A reply that never lands until `release()` is called, which is how a turn is held open long
 * enough to press Stop — v1.0's `threading.Thread` is still inside `_generate_sync` there.
 */
function hangingClient(agent: Agent): () => void {
  let release: (() => void) | null = null
  agent.client.generateContent = async () =>
    await new Promise<EngineResponse>((resolve) => {
      release = () => resolve(response([{ text: 'Too late.' }]))
    })
  return () => {
    release?.()
  }
}

/** The detached `!command` worker answers on its own schedule; wait for the bubble it owes. */
async function waitFor(predicate: () => boolean, limit = 8000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > limit) throw new Error('timed out waiting for the worker')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(() => {
  // The in-memory database lives for the whole file and every runtime hydrates the newest
  // conversation, so each test starts from an empty store like a fresh profile would. The
  // cascade clears messages, stored contents and the queue with the conversation rows.
  getDatabase().prepare('DELETE FROM conversations').run()
  conversationPersistence.use(null)
  raw = ''
  mirrored = []
  network.online = true
  network.gate = null
  transport = new FakeTransport()
  openingPush = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    raw += String(chunk)
    return true
  }) as never)
  detach = onConsoleOutput((text) => mirrored.push(text))
})

afterEach(async () => {
  detach?.()
  detach = null
  mirrored.length = 0
  vi.restoreAllMocks()
  const pending = roots.splice(0)
  root = ''
  await Promise.all(
    pending.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        /* a locked temp folder is not a parity failure */
      }
    })
  )
})

describe('snapshot() — the first frame `_build_ui` paints', () => {
  it('replays the welcome card and writes the six stats widgets in v1.0 order', async () => {
    const { runtime } = await makeRuntime()
    const snap = runtime.snapshot()

    // `__init__` never loads the session, so `timeline_history` is empty and the welcome shows.
    expect(bare(snap.history)).toEqual([{ kind: 'assistant', text: WELCOME, meta: '' }])
    expect(snap.stats).toEqual(statsWrites())
    expect(snap.targetEntry).toBe(root)
    expect(snap.pendingChanges).toEqual(EMPTY_SUMMARY)
    expect(snap.isGenerating).toBe(false)
    expect(snap.status).toEqual(INITIAL_STATUS)
    expect(snap.modelOptions).toEqual([{ id: MODEL_ID, display: MODEL_DISPLAY }])
    expect(snap.fontScaleOptions).toEqual(FONT_LABELS)
    expect(snap.modeOptions).toEqual(['BUILD', 'PLAN', 'READ'])
    expect(snap.funcOptions[0]).toBe(ALL_FUNCTIONS)
    expect(snap.fontScaleLabel).toBe('UI Scale: 13px (Normal)')
    // `_build_ui` reaches `CTkFont(size=…)` and `set_widget_scaling()` before `_sync_stats()`.
    expect(snap.fontScaleSize).toBe(13)
    expect(snap.widgetScale).toBe(1)
  })

  it('never replays RAM timeline_history when the store has no conversation', async () => {
    const { runtime, agent } = await makeRuntime()
    agent.state.timelineHistory = [
      {
        prompt: 'first ask',
        replies: ['  ', 'answer one'],
        events: [{ tool: 'read_file', status: 'Success' }]
      }
    ]

    // The SQLite store is the only source of a reopened timeline; a stale RAM row cannot leak in.
    expect(bare(runtime.snapshot().history)).toEqual([
      { kind: 'assistant', text: WELCOME, meta: '' }
    ])
  })

  it('pushes the drawer its opening summary through set_drawer_widget', async () => {
    await makeRuntime()
    expect(openingPush).toEqual([{ kind: 'changes', summary: EMPTY_SUMMARY }])
  })
})

describe('send_message() (6098)', () => {
  it('clears the box, bubbles the prompt and drives the badge around a turn', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')

    await runtime.dispatch({ cmd: 'send', text: '  hello  ' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    const stream = transport.take()
    expect(bare(stream.slice(0, 4))).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: 'hello', cpIdx: 0 },
      THINKING,
      { kind: 'generating', active: true }
    ])
    const bubble = stream[4] as { kind: string; text: string; meta: string }
    expect(bubble.kind).toBe('assistant')
    expect(bubble.text).toBe('All good.')
    // `meta` is `f"{model} - {active_function} - {elapsed}s"`, so only the seconds vary.
    expect(bubble.meta).toMatch(new RegExp(`^${MODEL_ID} - all - \\d+\\.\\d+s$`))
    expect(bare(stream.slice(5))).toEqual([
      READY,
      { kind: 'generating', active: false },
      ...statsWrites({ turns: 1 })
    ])

    // `_start_agent_turn` (6253) mirrors the prompt itself, then `gui_show` prints the reply
    // through the original `show` with `esc_monitor=None` (6272): unpaced, in one burst.
    expect(raw).toContain(`\n${C.BOLD}${C.BLUE}> hello${C.RESET}`)
    expect(raw).toContain(`${C.GREEN}│${C.RESET} ${C.GREEN}${C.BOLD}GemiBot AI`)
    expect(mirrored.filter((line) => line.includes('│'))).toHaveLength(2)
  })

  it('reports no internet without starting a turn', async () => {
    const { runtime } = await makeRuntime()
    network.online = false

    await runtime.dispatch({ cmd: 'send', text: 'hello' })

    expect(bare(transport.events)).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: 'hello', cpIdx: 0 },
      {
        kind: 'error',
        title: 'No Internet Connection',
        message:
          'Error: No internet connection. Please check your network connection and try again.',
        details: 'Network probe failed. No active internet route or DNS resolution.',
        icon: '❌'
      },
      { kind: 'pill', text: 'Error: No internet connection', icon: '❌' }
    ])
    expect(raw).toContain(`\n${C.RED}┃ Error: No internet connection${C.RESET}`)
  })

  it('stays silent on a blank prompt and on a second send while generating', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'send', text: '   ' })
    expect(bare(transport.events)).toEqual([])

    const release = hangingClient(agent)
    await runtime.dispatch({ cmd: 'send', text: 'first' })
    expect(bare(transport.take())).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: 'first', cpIdx: 0 },
      THINKING,
      { kind: 'generating', active: true }
    ])

    await runtime.dispatch({ cmd: 'send', text: 'second' })
    expect(bare(transport.events)).toEqual([{ kind: 'queue-add', text: 'second' }])

    await runtime.dispatch({ cmd: 'stop' })
    release()
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    // `turn()` swallows its own KeyboardInterrupt (window_app.py:3029), so the worker's
    // `except KeyboardInterrupt` at 6305 never sees it: the 'Generation stopped by user.' pill is
    // unreachable in window mode.  Reproduced, not fixed.
    expect(transport.of('pill')).toEqual([])
    expect(raw).toContain(`\n  ${C.YELLOW}┃ - Interrupted by user (Esc)${C.RESET}`)
  })

  it('holds a send-now that arrived during the probe until the first turn finishes', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    let releaseProbe!: () => void
    network.gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })

    const firstSend = runtime.dispatch({ cmd: 'send', text: 'first' })
    await runtime.dispatch({ cmd: 'send', text: 'second' })
    expect(bare(transport.take())).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: 'first', cpIdx: 0 },
      { kind: 'queue-add', text: 'second' }
    ])

    await runtime.dispatch({ cmd: 'queue-send-now', index: 0 })
    expect(bare(transport.take())).toEqual([{ kind: 'queue-delete', index: 0 }])
    // Nothing may start while the first send is still inside its internet probe.
    expect(transport.of('user')).toEqual([])

    network.gate = null
    releaseProbe()
    await firstSend
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    // `first` ran first even though `second` was promoted; both turns opened in order.
    expect(transport.of('user').map((e) => e.text)).toEqual(['second'])
    expect(transport.of('status').filter((e) => e.text === '● THINKING...')).toHaveLength(2)
  })

  it('ignores the legacy multi-agent-start command instead of stranding the queue', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')

    await runtime.dispatch({
      cmd: 'multi-agent-start',
      orchestratorModel: MODEL_ID,
      totalSubTasks: 2
    })
    await runtime.dispatch({ cmd: 'send', text: 'hello' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    expect(transport.of('multi-agent-start')).toEqual([])
    expect(transport.of('user').map((e) => e.text)).toEqual(['hello'])
    expect(transport.of('status').map((e) => e.text)).toContain('● THINKING...')
  })

  it('keeps draining the queue after a queued slash command', async () => {
    const { runtime, agent } = await makeRuntime()
    let calls = 0
    let release!: () => void
    agent.client.generateContent = async () => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return response([{ text: 'All good.' }])
    }

    await runtime.dispatch({ cmd: 'send', text: 'first' })
    await runtime.dispatch({ cmd: 'send', text: '/undo' })
    await runtime.dispatch({ cmd: 'send', text: 'second' })
    await waitFor(() => calls === 1)
    await runtime.dispatch({ cmd: 'stop' })
    release()
    await waitFor(() => transport.of('user').some((e) => e.text === 'second'))
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    expect(transport.of('user').map((e) => e.text)).toContain('/undo')
    expect(transport.of('status').filter((e) => e.text === '● THINKING...')).toHaveLength(2)
  })

  it('runs the planner as sub-agents and announces the real count', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'multi-agent-enable', enabled: true })

    await runtime.dispatch({ cmd: 'send', text: 'update a.txt and also create b.txt' })
    await waitFor(() => transport.of('multi-agent-complete').length === 1, 15000)

    expect(transport.of('multi-agent-start')).toEqual([
      { kind: 'multi-agent-start', orchestratorModel: MODEL_ID, totalSubTasks: 2 }
    ])
    expect(
      transport.of('multi-agent-sub-agent-update').filter((e) => e.status === 'succeeded')
    ).toHaveLength(2)
    expect(transport.of('status').map((e) => e.text)).toContain('● MULTI-AGENT')
  })

  it('shows a plain thinking badge when the planner falls back to one agent', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'multi-agent-enable', enabled: true })

    await runtime.dispatch({ cmd: 'send', text: 'hello' })
    await waitFor(() => transport.of('multi-agent-complete').length === 1, 15000)

    expect(transport.of('multi-agent-start')).toEqual([])
    expect(transport.of('status').map((e) => e.text)).not.toContain('● MULTI-AGENT')
    expect(transport.of('status').map((e) => e.text)).toContain('● THINKING...')
  })

  it('runs a !command detached and bubbles its merged output', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'send', text: '!echo hi' })
    await waitFor(() => transport.events.some((e) => e.kind === 'assistant'))

    expect(bare(transport.take())).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: '!echo hi', cpIdx: 0 },
      { kind: 'pill', text: 'Running terminal command: echo hi', icon: '⚡' },
      { kind: 'assistant', text: 'hi', meta: '!echo hi' }
    ])
    // `_run_shell_direct` (6233) never starts a turn, so there is no badge and no stats write.
    expect(bare(transport.events)).toEqual([])
  })

  it('routes a slash line through the engine, then the stats, the entry and the pill', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'send', text: '/undo' })

    // `_handle_command` (6201): `agent.command()`, `_sync_stats()`, `target_entry`, then the pill
    // with the raw line rather than the lowered one.
    expect(bare(transport.take())).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: '/undo', cpIdx: 0 },
      ...statsWrites(),
      { kind: 'target-entry', text: root },
      { kind: 'pill', text: 'Executed command: /undo', icon: 'ℹ️' }
    ])
  })

  it('expands the drawer for /changes and nothing else', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'send', text: '/changes' })
    expect(bare(transport.events)).toEqual([
      { kind: 'input', text: '', focus: false },
      { kind: 'user', text: '/changes', cpIdx: 0 },
      { kind: 'expand-changes' }
    ])
  })

  it('quits when the engine answers exit', async () => {
    const { runtime, agent } = await makeRuntime()
    agent.command = async () => 'exit'
    await runtime.dispatch({ cmd: 'send', text: '/exit' })
    expect(transport.quitCount).toBe(1)
  })
})

describe('the eight quick-action cards', () => {
  it('pills an empty todo list and bubbles a filled one', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'todos' })
    expect(bare(transport.events)).toEqual([
      { kind: 'pill', text: 'Tasks: No active todos.', icon: 'ℹ️' }
    ])

    transport.events.length = 0
    agent.state.todos = [
      { content: 'write the port', status: 'completed' },
      { content: 'test it', status: 'in_progress' },
      { content: 'ship' }
    ]
    await runtime.dispatch({ cmd: 'action', name: 'todos' })
    expect(bare(transport.events)).toEqual([
      {
        kind: 'assistant',
        text:
          'Active Tasks:\n' +
          '  [✓] write the port (completed)\n' +
          '  [→] test it (in_progress)\n' +
          '  [•] ship (pending)',
        meta: '/todos'
      }
    ])
  })

  it('reports usage through the thousands separator', async () => {
    const { runtime, agent } = await makeRuntime()
    agent.state.tokensIn = 1234
    agent.state.tokensOut = 567890

    await runtime.dispatch({ cmd: 'action', name: 'usage' })

    const context = agent.contextUsage()
    const compaction = agent.compactionConfig()
    const windowNote =
      context.limitTokens !== context.budgetTokens
        ? ` (model window ${pyFormatThousands(context.limitTokens)})`
        : ''
    expect(bare(transport.events)).toEqual([
      {
        kind: 'assistant',
        text:
          '# Session Token Usage\n\n' +
          '## Session\n' +
          '- Input tokens: 1,234\n' +
          '- Output tokens: 567,890\n' +
          '- Total tokens: 569,124\n' +
          `- Current model: ${MODEL_ID}\n` +
          `- Reasoning effort: ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}\n` +
          '\n' +
          '## Context window\n' +
          `- Request budget: ${pyFormatThousands(context.budgetTokens)} tokens${windowNote}\n` +
          `- Used: ${pyFormatThousands(context.usedTokens)} tokens (${context.percent}% of budget)\n` +
          (compaction.enabled
            ? `- Auto-compaction: at ${compaction.thresholdPercent}% → target ` +
              `${compaction.targetPercent}% (keeps ${compaction.recentMessages} recent turns)`
            : '- Auto-compaction: off (manual only)'),
        meta: '/usage'
      }
    ])
  })

  it('reports a workspace that is not a Node project', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'pip' })
    expect(bare(transport.events)).toEqual([
      { kind: 'assistant', text: missingPackageJsonReport(root), meta: '/libraries' },
      { kind: 'pill', text: 'No package.json found in the workspace.', icon: '⚠️' }
    ])
  })

  it('reports a package.json it cannot parse', async () => {
    const { runtime } = await makeRuntime()
    await writeFile(join(root, 'package.json'), '{"name":')
    await runtime.dispatch({ cmd: 'action', name: 'pip' })
    const [error, pill] = bare(transport.events) as Array<Record<string, unknown>>
    expect(error).toEqual({
      kind: 'error',
      title: 'Dependency installation failed',
      message: expect.stringContaining('package.json is not valid JSON:'),
      details: '',
      icon: '❌'
    })
    expect(pill).toEqual({
      kind: 'pill',
      text: expect.stringContaining('Dependency installation failed:'),
      icon: '❌'
    })
  })

  it('reports the memory journal in organized markdown', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'memory' })
    const [event] = transport.events as Array<{ text: string; meta: string }>
    const text = await agent.memory.readMemoryContent()
    const storage = await agent.memory.storageInfo()
    expect(event.meta).toBe('/memory')
    expect(event.text).toBe(
      [
        '# Memory History',
        '',
        '## Storage',
        `- Database: ${getDbPath()}`,
        `- Document key: ${storage.key}`,
        '- Backend: SQLite conversation database',
        `- Journal size: ${pyFormatThousands(pyLen(text))} chars across ` +
          `${pyFormatThousands(pySplitlines(text).length)} lines`,
        '',
        '## Journal',
        '- Logged Interactions: 0',
        '- No interactions logged yet. Each completed turn is appended automatically.'
      ].join('\n')
    )
  })

  it('lists the saved settings in organized sections', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'settings' })
    const [event] = transport.events as Array<{ text: string; meta: string }>
    const settings = await agent.settings.readSettingsDict()
    const storage = agent.settings.storageInfo()
    expect(event.meta).toBe('/settings')
    expect(event.text).toContain('# Settings & Preferences\n')
    expect(event.text).toContain('## Storage')
    expect(event.text).toContain(`- Database: ${getDbPath()}\n`)
    expect(event.text).toContain(`- Scope: ${storage.scope}\n`)
    expect(event.text).toContain('- Backend: SQLite conversation database\n')
    expect(event.text).toContain(`- Saved keys: ${Object.keys(settings).length}\n`)
    expect(event.text).toContain(
      '## Behavior\n' +
        '- Response style: balanced\n' +
        '- Deep mode: on\n' +
        '- Max steps: 40\n' +
        // This runtime was created without the window flags, so live streaming reports off.
        '- Streaming: off\n'
    )
    expect(event.text).toContain('## Workspace')
    expect(event.text).toContain(
      `- Target directory: ${settings['target_directory'] || '(not set)'}\n`
    )
    expect(event.text).toContain(`- Function suite: ${settings['function_suite']}\n`)
    expect(event.text).toContain(`- Mode: ${settings['mode']}\n`)
    expect(event.text).toContain('## Model & effort')
    expect(event.text).toContain(`- Model: ${settings['model']}\n`)
    expect(event.text).toContain(`- Effort level: ${settings['effort_level']}\n`)
    expect(event.text).toContain('## Interface')
    expect(event.text).toContain(`- UI scale: ${settings['ui_scale_label']}\n`)
    expect(event.text).toContain(`- Theme: ${settings['theme']}\n`)
    expect(event.text).toContain(`- Window geometry: ${settings['window_geometry']}`)
    expect(event.text).not.toContain('**')
    expect(event.text).not.toContain('`')
  })

  it('pills an undo with nothing to undo and a revert with no checkpoints', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'undo' })
    await runtime.dispatch({ cmd: 'action', name: 'revert' })
    expect(bare(transport.events)).toEqual([
      { kind: 'pill', text: 'Undo: Nothing to undo.', icon: 'ℹ️' },
      { kind: 'pill', text: 'Revert: No checkpoints available.', icon: 'ℹ️' }
    ])
  })

  it('cancels a clear from the card and writes nothing else', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'action', name: 'clear' })
    expect(bare(transport.events)).toEqual([
      { kind: 'pill', text: 'Clear cancelled by user.', icon: 'ℹ️' }
    ])
  })

  it('clears chat, stats and the SQLite memory document once the dialog says yes', async () => {
    const { runtime, agent } = await makeRuntime()
    await agent.memory.io().write('old memory')
    const key = (await agent.memory.storageInfo()).key
    transport.confirmClearAnswers = [true]
    await runtime.dispatch({ cmd: 'action', name: 'clear' })
    expect(bare(transport.events)).toEqual([
      { kind: 'clear-chat' },
      ...statsWrites(),
      { kind: 'pill', text: 'Active chat and conversation memory cleared.', icon: '\u{1F9F9}' }
    ])
    expect(memoryRepository.get(key)).toBe(AppConstants.MEMORY_HEADER)
    expect(await agent.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)
  })

  it('saves the next turn in a fresh conversation after a clear', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'send', text: 'before' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    const archived = runtime.snapshot().activeConversationId
    transport.take()
    transport.confirmClearAnswers = [true]
    await runtime.dispatch({ cmd: 'action', name: 'clear' })
    transport.take()
    await runtime.dispatch({ cmd: 'send', text: 'after' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    expect(transport.of('error')).toEqual([])
    const active = runtime.snapshot().activeConversationId
    expect(active).not.toBeNull()
    const saved = (
      getDatabase().prepare('SELECT DISTINCT conversation_id AS id FROM messages').all() as Array<{
        id: string
      }>
    ).map((row) => row.id)
    expect(saved.sort()).toEqual([archived, active].sort())
  })

  it('warns instead of claiming success when SQLite rejects the memory reset', async () => {
    const { runtime, agent } = await makeRuntime()
    await agent.memory.io().write('old memory')
    const key = (await agent.memory.storageInfo()).key
    vi.spyOn(memoryRepository, 'write').mockImplementation(() => {
      throw new Error('database is locked')
    })
    transport.confirmClearAnswers = [true]
    await runtime.dispatch({ cmd: 'action', name: 'clear' })
    expect(bare(transport.events)).toEqual([
      { kind: 'clear-chat' },
      ...statsWrites(),
      {
        kind: 'pill',
        text: 'Active chat cleared, but app memory could not be saved to the database.',
        icon: '⚠️'
      }
    ])
    // The live session reads the cleared header, but the database still has the old row.
    expect(await agent.readMemoryContent()).toBe(AppConstants.MEMORY_HEADER)
    expect(memoryRepository.get(key)).toBe('old memory')
  })
})

describe('conversation recovery', () => {
  /** The newest `conversations` push, the one the sidebar renders. */
  const lastConversations = (): Extract<WindowEvent, { kind: 'conversations' }> | undefined =>
    transport.of('conversations').slice(-1)[0]

  it('starts a new conversation when the active row is gone', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'Still here.')
    await runtime.dispatch({ cmd: 'send', text: 'first' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    const ghost = runtime.snapshot().activeConversationId
    expect(ghost).not.toBeNull()
    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run(ghost)
    transport.take()

    await runtime.dispatch({ cmd: 'send', text: 'second' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    expect(transport.of('error')).toEqual([])
    const active = runtime.snapshot().activeConversationId
    expect(active).not.toBeNull()
    expect(active).not.toBe(ghost)
    const saved = getDatabase()
      .prepare('SELECT DISTINCT conversation_id AS id FROM messages')
      .all() as Array<{ id: string }>
    expect(saved).toEqual([{ id: active }])
  })

  it('does not adopt a conversation row that no longer exists', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'Still here.')
    await runtime.dispatch({ cmd: 'send', text: 'first' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    const ghost = runtime.snapshot().activeConversationId
    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run(ghost)
    transport.take()

    await runtime.dispatch({ cmd: 'conversation-open', id: ghost as string })

    expect(runtime.snapshot().activeConversationId).toBeNull()
    expect(lastConversations()?.activeId ?? null).toBeNull()
    expect(transport.of('history-reset')).toHaveLength(1)

    await runtime.dispatch({ cmd: 'send', text: 'after' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    expect(transport.of('error')).toEqual([])
    expect(runtime.snapshot().activeConversationId).not.toBe(ghost)
  })

  it('deletes the last conversation and tells the sidebar it is empty', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'Bye.')
    await runtime.dispatch({ cmd: 'send', text: 'only' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    const id = runtime.snapshot().activeConversationId as string
    transport.take()

    await expect(runtime.dispatch({ cmd: 'conversation-delete', id })).resolves.toBeUndefined()

    const snapshot = runtime.snapshot()
    expect(snapshot.activeConversationId).toBeNull()
    expect(snapshot.conversations).toEqual([])
    expect(getDatabase().prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 0 })
    expect(transport.of('error')).toEqual([])
  })
})

describe('target widgets', () => {
  it('resets the target and discards the message v1.0 throws away', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'target-clear' })
    // `_on_target_clear` (5388) drops `set_target_directory()`'s second return value.
    expect(bare(transport.events)).toEqual([
      { kind: 'target-entry', text: root },
      { kind: 'target-error', text: null },
      ...statsWrites(),
      { kind: 'pill', text: 'Target reset to application default folder.', icon: '↩️' }
    ])
  })

  it('keeps a rejected target as an error label and a warning pill', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'target-apply', path: join(root, 'no-such-folder') })
    const [label, pill] = transport.events as Array<{ kind: string; text: string }>
    // `_on_target_apply` (5355) shows `target_err_lbl` with the engine message, then pills it.
    expect(label.kind).toBe('target-error')
    expect(typeof label.text).toBe('string')
    expect(pill).toEqual({ kind: 'pill', text: `Target error: ${label.text}`, icon: '⚠️' })
    expect(transport.events.some((e) => e.kind === 'stats')).toBe(false)
  })

  it('applies a browsed directory through the entry it just filled', async () => {
    const { runtime } = await makeRuntime()
    const other = await mkdtemp(join(tmpdir(), 'gemibot-window-target-'))
    roots.push(other)
    transport.browseAnswer = other

    await runtime.dispatch({ cmd: 'target-browse' })

    // `askdirectory` is called with `initialdir=str(agent.root)` and that title (5375), and the one
    // entry write it makes is the path the apply step then reads back.
    expect(transport.browseCalls).toEqual([[root, 'Select Target Project Directory']])
    expect(bare(transport.events)).toEqual([
      { kind: 'target-entry', text: other },
      { kind: 'target-error', text: null },
      ...statsWrites({ root: other }),
      { kind: 'pill', text: `Target set to: ${other}`, icon: '\u{1F4C1}' }
    ])
  })
})

describe('the menus and pickers', () => {
  it('switches the mode through the segmented button', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'mode-change', value: 'PLAN' })

    expect(agent.state.mode).toBe('plan')
    expect(agent.state.activeFunction).toBe('plan')
    expect(bare(transport.events)).toEqual([
      ...statsWrites({ mode: 'PLAN', functionMenu: '📐 Plan Mode (Analysis & Plan)' }),
      { kind: 'pill', text: 'Mode switched to PLAN (Suite: plan)', icon: 'ℹ️' }
    ])
    const settings = await agent.settings.readSettingsDict()
    expect(settings['mode']).toBe('plan')
    expect(settings['function_suite']).toBe('plan')
  })

  it('runs the dependency installer when the function menu picks it', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'function-change', display: '📦 Project Dependencies Installer' })

    // The installer suite is a pill, not a switch: the active suite stays where it was.
    expect(agent.state.activeFunction).toBe('all')
    expect(bare(transport.events)).toEqual([
      { kind: 'assistant', text: missingPackageJsonReport(root), meta: '/libraries' },
      { kind: 'pill', text: 'No package.json found in the workspace.', icon: '⚠️' },
      ...statsWrites()
    ])
  })

  it('activates a suite and falls the mode back to build', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'function-change', display: '🎙️ Voice Transcriber & Audio' })

    expect(agent.state.mode).toBe('build')
    expect(agent.state.activeFunction).toBe('voice_analyzer')
    expect(bare(transport.events)).toEqual([
      ...statsWrites({ functionMenu: '🎙️ Voice Transcriber & Audio' }),
      {
        kind: 'pill',
        text: 'Suite activated: 🎙️ Voice Transcriber & Audio [voice_analyzer]',
        icon: 'ℹ️'
      }
    ])
  })

  it('writes the model button three times for a top-bar change', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'model-change', display: MODEL_DISPLAY })

    // `_on_model_change_display` (5439) compares `model_menu.get()` — an id — against the display
    // name it was handed, so `set()` runs; `_sync_effort_display()` and `_sync_stats()` then write
    // the same widget twice more through the same formatter.
    expect(bare(transport.events)).toEqual([
      { kind: 'model-button', text: BUTTON },
      { kind: 'model-button', text: BUTTON },
      ...statsWrites(),
      { kind: 'pill', text: `AI Model changed: ${MODEL_DISPLAY} (${MODEL_ID})`, icon: 'ℹ️' }
    ])
    expect(transport.of('model-button')).toHaveLength(3)
    expect(agent.state.pinned).toBe(true)
  })

  it('picks a model from the modal and falls back to the id when the catalog misses', async () => {
    const { runtime } = await makeRuntime()
    const display = 'Gemini 3.5 Flash Lite [Fast - 20-25s]'
    const chosen = 'gemini-3.5-flash-lite'
    await runtime.dispatch({ cmd: 'model-selected', modelId: chosen, display })

    // The picker's own display name is used once; `_sync_effort_display()` and `_sync_stats()` then
    // resolve `model_id_to_display` for an id the pinned catalog never held, i.e. the id itself.
    const idButton = `${chosen} • ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`
    const idStats = `Tokens: 0 | Turns: 0 | Model: ${chosen} | Effort: ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`
    expect(bare(transport.events)).toEqual([
      {
        kind: 'model-button',
        text: `${display} • ${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`
      },
      { kind: 'model-button', text: idButton },
      { kind: 'stats', text: idStats },
      { kind: 'mode', text: 'BUILD' },
      { kind: 'function-menu', text: ALL_FUNCTIONS },
      { kind: 'model-button', text: idButton },
      { kind: 'active-target', text: root },
      { kind: 'top-path', text: `\u{1F4C1} ${basename(root)}  •  memory` },
      { kind: 'pill', text: `AI Model changed: ${display} (${chosen})`, icon: 'ℹ️' }
    ])
  })

  it('re-formats the button for an effort change and pills the cost hint', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'effort-selected', value: 'high' })

    // `_on_effort_selected_from_modal` (5502) writes only the button, never `_sync_stats()`.
    expect(bare(transport.events)).toEqual([
      { kind: 'model-button', text: `${MODEL_DISPLAY} • 🧠 High` },
      { kind: 'pill', text: 'Reasoning Effort set to: 🧠 High (Deep (~8k tokens))', icon: 'ℹ️' }
    ])
    expect(agent.effortLevel).toBe(EffortLevel.HIGH)
    // 5504 saves `effort_level.value`, i.e. the lowercase enum value, not the `.name`;
    // `EffortLevel.from_string` reads either spelling back.
    const settings = await agent.settings.readSettingsDict()
    expect(settings['effort_level']).toBe('high')
  })

  it('re-scales the fonts and saves both scale settings', async () => {
    const { runtime, agent } = await makeRuntime()
    await runtime.dispatch({ cmd: 'font-scale', label: 'UI Scale: 16px (Extra Large)' })

    expect(bare(transport.events)).toEqual([
      { kind: 'font-scale', label: 'UI Scale: 16px (Extra Large)', size: 16, scale: 1.22 },
      { kind: 'pill', text: 'Applied UI font scale: 16px (122%)', icon: '\u{1F524}' }
    ])
    const settings = await agent.settings.readSettingsDict()
    expect(settings['ui_scale']).toBe('16px')
    expect(settings['ui_scale_label']).toBe('UI Scale: 16px (Extra Large)')
    // The next first frame carries the saved label and its tuple.
    const snap = runtime.snapshot()
    expect(snap.fontScaleLabel).toBe('UI Scale: 16px (Extra Large)')
    expect(snap.fontScaleSize).toBe(16)
    expect(snap.widgetScale).toBe(1.22)
  })

  it('refills the box and cuts the timeline for an edit outside the checkpoint range', async () => {
    const { runtime } = await makeRuntime()
    // No checkpoint at index 0 yet, so `_on_edit_user_message` (5669) stops at the rollback guard
    // but still runs the recreate sweep, which is not inside the `cp_idx` check (5693-5701).
    await runtime.dispatch({ cmd: 'edit-user', text: 'edited ask', cpIdx: 0, rowId: 7 })
    expect(bare(transport.events)).toEqual([
      { kind: 'input', text: 'edited ask', focus: true },
      { kind: 'truncate-chat', rowId: 7 }
    ])
  })

  it('rolls the engine back and pills the prompt number for an edited ask', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'ok')
    await runtime.dispatch({ cmd: 'send', text: 'first' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    expect(agent.checkpoints).toHaveLength(1)
    transport.events.length = 0

    await runtime.dispatch({ cmd: 'edit-user', text: 'edited ask', cpIdx: 0, rowId: 3 })
    expect(bare(transport.events)).toEqual([
      { kind: 'input', text: 'edited ask', focus: true },
      { kind: 'pill', text: 'Rolled back to prompt #1 for edit.', icon: '↩️' },
      ...statsWrites({ turns: 0 }),
      { kind: 'truncate-chat', rowId: 3 }
    ])
    expect(agent.checkpoints).toHaveLength(0)
  })

  it('cuts a restored row without rolling anything back', async () => {
    const { runtime, agent } = await makeRuntime()
    // `_restore_session_timeline` (5225) calls `add_user_message(prompt)` with no `cp_idx`, so a
    // restored row's Edit button has nothing to roll back and still truncates.
    expect(
      await runtime.dispatch({ cmd: 'edit-user', text: 'ask', cpIdx: null, rowId: 2 })
    ).toBeUndefined()
    expect(bare(transport.events)).toEqual([
      { kind: 'input', text: 'ask', focus: true },
      { kind: 'truncate-chat', rowId: 2 }
    ])
    expect(agent.checkpoints).toHaveLength(0)
  })
})

describe('permission, stop and the review panel', () => {
  it('answers the engine permission hook from the dialog', async () => {
    const { agent } = await makeRuntime()
    expect(await agent.state.onPermission?.('write_file', 'demo.txt')).toBe(true)
    expect(transport.permissionCalls).toEqual([['write_file', 'demo.txt']])

    transport.permissionAnswer = 'always'
    expect(await agent.state.onPermission?.('run_command', 'ls')).toBe('always')

    transport.permissionAnswer = false
    expect(await agent.state.onPermission?.('delete_file', 'x')).toBe(false)
  })

  it('stops a turn, closing the dialog it is waiting on', async () => {
    const { runtime, agent } = await makeRuntime()
    const release = hangingClient(agent)
    await runtime.dispatch({ cmd: 'send', text: 'hello' })
    transport.events.length = 0

    await runtime.dispatch({ cmd: 'stop' })
    expect(bare(transport.events)).toEqual([STOPPING])
    expect(transport.cancelPermissionCount).toBe(1)

    release()
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    // `_on_turn_finished` still runs from the `finally`, and the interrupted turn popped its
    // checkpoint, so the badge block closes the stream with `Turns: 0`.
    expect(bare(transport.take().filter((e) => e.kind !== 'action'))).toEqual([
      STOPPING,
      READY,
      { kind: 'generating', active: false },
      ...statsWrites({ turns: 0 })
    ])
  })

  it('ignores a stop while nothing is generating', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'stop' })
    expect(bare(transport.events)).toEqual([])
    expect(transport.cancelPermissionCount).toBe(0)
  })

  it('sends no review panel when nothing is pending', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'review-open' })
    // `open_review_panel()` returns before building the panel when the list is empty.
    expect(bare(transport.events)).toEqual([])
  })

  it('re-reads the tracker on panel close and finds no diff for a ghost path', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'review-panel-close' })
    // `_on_review_panel_close` (6193) goes to the tracker itself rather than the controller, and
    // `_on_panel_closed` starts `False` (review_controller.py:32), so this first destroy runs it.
    expect(bare(transport.events)).toEqual([{ kind: 'changes', summary: EMPTY_SUMMARY }])
    transport.take()
    // The guard then holds: a second destroy is silent until a panel is opened again (97-105).
    await runtime.dispatch({ cmd: 'review-panel-close' })
    expect(bare(transport.events)).toEqual([])
    expect(await runtime.getFileDiff('ghost.txt')).toBeNull()
  })

  it('reports an empty accept and reject through a pill and the mirror', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'accept-all' })
    await runtime.dispatch({ cmd: 'reject-all' })
    expect(transport.of('pill')).toEqual([
      { kind: 'pill', text: 'No pending changes to accept', icon: '✗' },
      { kind: 'pill', text: 'No pending changes to reject', icon: '✗' }
    ])
    expect(raw).toContain(`\n${C.YELLOW}No pending changes to accept.${C.RESET}`)
    expect(raw).toContain(`\n${C.YELLOW}No pending changes to reject.${C.RESET}`)
  })

  it('fails a per-file change that never happened', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'accept-file', path: 'ghost.txt' })
    await runtime.dispatch({ cmd: 'reject-file', path: 'ghost.txt' })
    expect(bare(transport.events)).toEqual([
      { kind: 'pill', text: 'Failed to accept change: ghost.txt', icon: '✗' },
      { kind: 'pill', text: 'Failed to restore: ghost.txt', icon: '✗' }
    ])
    expect(raw).toContain(
      `\n${C.RED}Failed to accept file ghost.txt: operation returned False${C.RESET}`
    )
    expect(raw).toContain(
      `\n${C.RED}Failed to reject file ghost.txt: operation returned False${C.RESET}`
    )
  })
})

/**
 * The four header strings v1.0 composes off the agent at paint time.
 *
 * Each is split on the `"  •  "` separator instead of being compared to a computed literal: the
 * wall-clock tag is the part that moves, and matching it rather than recomputing it keeps a test
 * from failing when the second ticks over between the emit and the assert.  What is pinned is the
 * number of parts, their order and their content — which is the whole parity claim of 5043-5052,
 * 5605, 5737-5745, 5771-5779 and 6001.
 */
describe('the headers `_sync_stats` cannot reach (5043, 5605, 5737, 5771, 6001)', () => {
  /** `meta_str = "  •  ".join(meta_parts)` (5052), and the same join at 5745 / 5779. */
  const BUL = '  \u2022  '
  /** `datetime.now().strftime("%H:%M:%S")`. */
  const TAG = /^\d{2}:\d{2}:\d{2}$/
  const EFFORT = `${EffortLevel.MEDIUM.icon} ${EffortLevel.MEDIUM.displayName}`

  function parts(header: string): string[] {
    return header.split(BUL)
  }

  it('gives the welcome card the model, the effort and the time — no meta', async () => {
    const { runtime } = await makeRuntime()
    const [welcome] = runtime.snapshot().history as Extract<WindowEvent, { kind: 'assistant' }>[]
    expect(welcome.meta).toBe('')
    // `meta_parts.append(meta)` is inside `if meta:` (5050), so an empty meta adds no part.
    expect(parts(welcome.header)).toEqual([MODEL_ID, EFFORT, expect.stringMatching(TAG)])
  })

  it('appends the turn meta last, after the time tag', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'send', text: 'hello' })
    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))

    const bubble = transport.of('assistant')[0]
    const [model, effort, tag, meta] = parts(bubble.header)
    expect(model).toBe(MODEL_ID)
    expect(effort).toBe(EFFORT)
    expect(tag).toMatch(TAG)
    // 5051 puts `meta` after the tag, so the two-space bullet order is model/effort/time/meta.
    expect(meta).toBe(bubble.meta)
  })

  it('drops the effort part for a model that has no thinking config', async () => {
    const { runtime, agent } = await makeRuntime()
    // `supports_thinking('gemma…')` is False (effort-mapper.service.ts:33), the rung at 5045.
    agent.model = 'gemma-3-27b-it'
    const [card] = runtime.snapshot().history as Extract<WindowEvent, { kind: 'assistant' }>[]
    expect(parts(card.header)).toEqual([agent.model, expect.stringMatching(TAG)])
  })

  it('labels a user row with "You" and the time only', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'send', text: 'hello' })

    const [row] = transport.of('user')
    expect(parts(row.header)).toEqual(['You', expect.stringMatching(TAG)])
  })

  it('labels an error card with the raw model id and no effort', async () => {
    const { runtime } = await makeRuntime()
    network.online = false
    await runtime.dispatch({ cmd: 'send', text: 'hello' })

    // 6001 is `f"{self.agent.model}  •  {time}"`: no effort rung and no display-name mapping,
    // which is why an error row reads `gemini-3.1-flash-lite` where the button reads the catalog
    // display name.  Reproduced, not fixed.
    const [card] = transport.of('error')
    expect(parts(card.header)).toEqual([MODEL_ID, expect.stringMatching(TAG)])
  })

  it('carries the thinking indicator parts the renderer brackets at 250 ms', async () => {
    const { runtime, agent } = await makeRuntime()
    stubClient(agent, 'All good.')
    await runtime.dispatch({ cmd: 'send', text: 'hello' })

    const [active] = transport.of('generating')
    expect(active.active).toBe(true)
    // 5739-5745 build the init label; 5771-5777 rebuild it with `fn:{active_function}`.
    expect(active.thinking).toEqual({
      init: [MODEL_ID, EFFORT].join(BUL),
      parts: [MODEL_ID, EFFORT, 'fn:all']
    })

    await waitFor(() => transport.events.some((e) => e.kind === 'status' && e.text === '● READY'))
    // The elapsed field 5778 appends is the renderer's, and the hidden widget sends nothing.
    expect(transport.of('generating')[1]).toMatchObject({ active: false, thinking: null })
  })
})

describe('the clipboard (4600)', () => {
  it('answers a copy with the pill, as _copy_to_clipboard does', async () => {
    const { runtime } = await makeRuntime()
    await runtime.dispatch({ cmd: 'copy', text: 'hello world' })

    expect(transport.copyCalls).toEqual(['hello world'])
    expect(transport.of('pill')).toEqual([
      { kind: 'pill', text: 'Copied to clipboard!', icon: '📋' }
    ])
  })

  it('reports a clipboard failure as a pill rather than throwing', async () => {
    const { runtime } = await makeRuntime()
    transport.copyThrows = true
    await runtime.dispatch({ cmd: 'copy', text: 'nope' })

    // 4606 is `f"Copy failed: {e}"` — the bare exception text, so the widget keeps Tk's wording and
    // Electron's message.
    expect(transport.of('pill')).toEqual([
      { kind: 'pill', text: 'Copy failed: clipboard unavailable', icon: '⚠️' }
    ])
  })
})
