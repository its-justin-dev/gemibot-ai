import { describe, expect, it } from 'vitest'

import { ConsoleBuffer } from '@shared/utils/console-buffer'
import type {
  ThinkingState,
  WindowEvent,
  WindowRequest,
  WindowSnapshot
} from '@shared/types/window'
import {
  apply,
  applyAnswer,
  applyRequest,
  assistantAt,
  createStore,
  initialState,
  reduce,
  type RendererState,
  type Store
} from '../../src/renderer/src/state/window-store'

/**
 * Stage 4c-1 parity tests for the renderer's event fold.
 *
 * v1.0's `GemibotWindowApp` has no state layer — every `configure(text=…)` lands on a widget that
 * holds its own full contents.  The two consequences that the suite pins are the ones a UI rewrite
 * is most likely to lose:
 *  - the bar widgets are *replaced*, never merged, because each write is a whole label;
 *  - chat rows are appended in arrival order, because `row.pack()` order is the visible order.
 *
 * The snapshot literals are the values `WindowRuntime.snapshot()` is separately proved to emit in
 * `window-runtime.test.ts`, so the two halves meet in the middle.
 */

const SUMMARY = {
  total_changes: 0,
  counts: { Added: 0, Modified: 0, Deleted: 0, Generated: 0, 'Document edited': 0 },
  files_read: [],
  changes: []
}

const THINKING: ThinkingState = {
  init: 'gemini-3.1-flash-lite  •  ⚖️ Medium',
  parts: ['gemini-3.1-flash-lite', '⚖️ Medium', 'fn:all']
}

function snapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    history: [
      {
        kind: 'assistant',
        text: 'welcome',
        meta: '',
        header: 'm  •  ⚖️ Medium  •  09:00:00',
        timestamp: '09:00:00'
      }
    ],
    stats: [
      { kind: 'stats', text: 'Tokens: 0 | Turns: 0' },
      { kind: 'mode', text: 'BUILD' },
      { kind: 'function-menu', text: '🚀 All Functions (Full Access)' },
      { kind: 'model-button', text: 'Gemini Test Model • ⚖️ Medium' },
      { kind: 'active-target', text: 'C:/tmp/project' },
      { kind: 'top-path', text: '\u{1F4C1} project  •  /memory/memory.md' }
    ],
    pendingChanges: SUMMARY,
    isGenerating: false,
    status: { text: '● READY', color: '#10b981' },
    funcOptions: ['🚀 All Functions (Full Access)'],
    modelOptions: [{ id: 'gemini-3.1-flash-lite', display: 'Gemini Test Model' }],
    fontScaleOptions: ['UI Scale: 13px (Normal)'],
    modeOptions: ['BUILD', 'PLAN', 'READ'],
    fontScaleLabel: 'UI Scale: 13px (Normal)',
    fontScaleSize: 13,
    widgetScale: 1,
    targetEntry: 'C:/tmp/project',
    multiAgent: { isActive: false, orchestratorModel: '', subAgents: [], activeSubAgentIdx: null, totalSubTasks: 0, completedSubTasks: 0 },
    ...overrides
  } as WindowSnapshot
}

function makeStore(overrides: Partial<WindowSnapshot> = {}): Store {
  return createStore(snapshot(overrides))
}

/** A first frame with nothing restored, so the row tests start from an empty `chat_container`. */
function emptyState(): RendererState {
  return initialState(snapshot())
}

describe('createStore() — the first frame `_build_ui` paints', () => {
  it('replays the history and the six stats writes through the same fold as the live stream', () => {
    const store = makeStore()
    expect(store.state.chat).toEqual([
      {
        id: expect.any(Number),
        type: 'assistant',
        text: 'welcome',
        meta: '',
        header: 'm  •  ⚖️ Medium  •  09:00:00',
        itemIndex: 0,
        timestamp: '09:00:00',
        associated: []
      }
    ])
    expect(store.state.bar).toEqual({
      stats: 'Tokens: 0 | Turns: 0',
      mode: 'BUILD',
      functionMenu: '🚀 All Functions (Full Access)',
      modelButton: 'Gemini Test Model • ⚖️ Medium',
      activeTarget: 'C:/tmp/project',
      topPath: '\u{1F4C1} project  •  /memory/memory.md'
    })
    expect(store.state.targetEntry).toBe('C:/tmp/project')
    expect(store.state.fontScale).toEqual({ label: 'UI Scale: 13px (Normal)', size: 13, scale: 1 })
    expect(store.catalogs.modeOptions).toEqual(['BUILD', 'PLAN', 'READ'])
    expect(store.state.revision).toBe(1)
  })

  it('keeps a restored timeline ahead of the bar writes', () => {
    const store = makeStore({
      history: [
        {
          kind: 'user',
          text: 'first ask',
          cpIdx: null,
          header: 'You  •  09:00:01',
          timestamp: '09:00:01'
        },
        { kind: 'action', event: { tool: 'read_file', status: 'Success' } },
        { kind: 'pill', text: 'Session restored', icon: '♻️' }
      ]
    })
    expect(store.state.chat.map((row) => row.type)).toEqual(['user', 'action', 'pill'])
  })

  it('starts with no thinking indicator, as `_build_ui` never shows one', () => {
    const store = makeStore({ isGenerating: false })
    expect(store.state.thinking).toBeNull()
    expect(store.state.isGenerating).toBe(false)
  })
})

describe('reduce() — one event, one widget write', () => {
  it('appends each chat row with the header the main process composed', () => {
    let state = emptyState()
    state = reduce(state, {
      kind: 'assistant',
      text: 'reply',
      meta: 'gemini-3.1-flash-lite - all - 0.1s',
      header: 'H1',
      timestamp: '09:00:00'
    })
    state = reduce(state, {
      kind: 'user',
      text: 'ask',
      cpIdx: 3,
      header: 'H2',
      timestamp: '09:00:01'
    })
    state = reduce(state, { kind: 'pill', text: 'p', icon: 'ℹ️' })
    state = reduce(state, {
      kind: 'error',
      title: 't',
      message: 'm',
      details: 'd',
      icon: '❌',
      header: 'H3'
    })
    const rows = state.chat
    expect(rows.map((row) => row.type)).toEqual(['assistant', 'user', 'pill', 'error'])
    // `cpIdx` is stored but never rendered: 5591 shows only `You  •  {time}`.
    expect(rows[1]).toMatchObject({ cpIdx: 3, header: 'H2' })
    expect(rows[3]).toMatchObject({ header: 'H3' })
    // Ids rise with arrival order, which is v1.0's implicit child index.
    expect(rows[0].id).toBeLessThan(rows[3].id)
  })

  it('replaces a bar widget rather than merging it', () => {
    let state = makeStore().state
    state = reduce(state, { kind: 'stats', text: 'Tokens: 12 | Turns: 1' })
    expect(state.bar.stats).toBe('Tokens: 12 | Turns: 1')
    expect(state.bar.mode).toBe('BUILD')
  })

  it('treats a hidden target error as null, not an empty string', () => {
    let state = makeStore().state
    state = reduce(state, { kind: 'target-error', text: 'Path not found' })
    expect(state.targetError).toBe('Path not found')
    state = reduce(state, { kind: 'target-error', text: null })
    expect(state.targetError).toBeNull()
  })

  it('folds the generating flag and its thinking material together', () => {
    let state = makeStore().state
    state = reduce(state, { kind: 'generating', active: true, thinking: THINKING })
    expect(state).toMatchObject({ isGenerating: true, thinking: THINKING })
    state = reduce(state, { kind: 'generating', active: false, thinking: null })
    expect(state).toMatchObject({ isGenerating: false, thinking: null })
  })

  it('expands the drawer without ever collapsing it', () => {
    let state = makeStore().state
    expect(state.changesExpanded).toBe(0)
    state = reduce(state, { kind: 'expand-changes' })
    expect(state.changesExpanded).toBe(1)
    state = reduce(state, { kind: 'changes', summary: { ...SUMMARY, total_changes: 2 } })
    expect(state).toMatchObject({ changesExpanded: 1, changes: { total_changes: 2 } })
    // `/changes` again re-expands a drawer the user toggled shut, so the count has to keep moving.
    state = reduce(state, { kind: 'expand-changes' })
    expect(state.changesExpanded).toBe(2)
  })

  it('empties the timeline and history state on clear and leaves the bar alone', () => {
    let state = makeStore().state
    state = { ...state, hasMoreHistory: true }
    const before = state.revision
    state = reduce(state, { kind: 'clear-chat' })
    expect(state.chat).toEqual([])
    expect(state.hasMoreHistory).toBe(false)
    expect(state.bar.stats).toBe('Tokens: 0 | Turns: 0')
    expect(state.revision).toBe(before + 1)
  })

  it('drops the edited row and everything after it, but keeps the pills', () => {
    let state = emptyState()
    const ids: number[] = []
    const push = (event: WindowEvent): void => {
      state = reduce(state, event)
      ids.push((state.chat[state.chat.length - 1] as { id: number }).id)
    }
    push({ kind: 'user', text: 'keep me', cpIdx: 0, header: 'h', timestamp: '09:00:00' })
    push({ kind: 'pill', text: 'a pill', icon: 'ℹ️' })
    push({ kind: 'assistant', text: 'reply', meta: '', header: 'h', timestamp: '09:00:01' })
    push({ kind: 'user', text: 'edit this one', cpIdx: 1, header: 'h', timestamp: '09:00:02' })
    push({ kind: 'action', event: { tool: 'read_file', status: 'Success' } })

    // v1.0 destroys `chat_history_items[item_index:]` (5693-5701); the pill is not in that list,
    // so it survives even though it was packed before the cut rows.
    state = reduce(state, { kind: 'truncate-chat', rowId: ids[3] })
    expect(state.chat.map((row) => row.type)).toEqual(['user', 'pill', 'assistant'])
    expect(state.chat[0]).toMatchObject({ text: 'keep me' })
    // The last row is gone, so a cut at a row that no longer exists is silent.
    const after = state.chat.length
    state = reduce(state, { kind: 'truncate-chat', rowId: ids[4] })
    expect(state.chat).toHaveLength(after)
  })

  it('closes a permission dialog without answering it', () => {
    let state = makeStore().state
    state = reduce(state, { kind: 'cancel-permission' })
    state = reduce(state, { kind: 'cancel-permission' })
    // A counter, because two Stop presses in a row must both be visible to the dialog effect.
    expect(state.permissionCancelCount).toBe(2)
  })

  it('stores the font scale triple rather than a CSS length', () => {
    let state = makeStore().state
    state = reduce(state, {
      kind: 'font-scale',
      label: 'UI Scale: 16px (Extra Large)',
      size: 16,
      scale: 1.25
    })
    expect(state.fontScale).toEqual({
      label: 'UI Scale: 16px (Extra Large)',
      size: 16,
      scale: 1.25
    })
  })

  it('folds every remaining widget write', () => {
    let state = makeStore().state
    state = reduce(state, { kind: 'input', text: 'draft', focus: true })
    state = reduce(state, { kind: 'target-entry', text: 'C:/other' })
    state = reduce(state, { kind: 'status', text: '● THINKING...', color: '#f59e0b' })
    state = reduce(state, { kind: 'review-panel', changes: [] })
    expect(state.input).toEqual({ text: 'draft', focus: true })
    expect(state.targetEntry).toBe('C:/other')
    expect(state.status).toEqual({ text: '● THINKING...', color: '#f59e0b' })
    expect(state.reviewPanel).toEqual([])
  })

  it('has a case for every event kind the contract can send', () => {
    const kinds: WindowEvent['kind'][] = [
      'console',
      'assistant',
      'user',
      'pill',
      'error',
      'action',
      'changes',
      'review-panel',
      'clear-chat',
      'truncate-chat',
      'stats',
      'mode',
      'function-menu',
      'model-button',
      'active-target',
      'top-path',
      'target-entry',
      'target-error',
      'status',
      'generating',
      'expand-changes',
      'font-scale',
      'cancel-permission',
      'input'
    ]
    // `sample()` switches over the whole union with no default, so a kind added to the contract
    // fails to compile until `reduce()` grows its case too.  This asserts the fold runs for each.
    let state = makeStore().state
    for (const kind of kinds) {
      const before = state
      state = reduce(state, sample(kind))
      expect(state).not.toBeNull()
      // `console` is the one documented no-op; every other write returns a new object.
      if (kind === 'console') expect(state).toBe(before)
      else expect(state).not.toBe(before)
    }
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})

describe('apply() — the single entry point the IPC bridge calls', () => {
  it('routes mirror bytes to the console buffer and wakes nothing', () => {
    const store = makeStore()
    const woken: number[] = []
    store.listeners.add(() => woken.push(store.state.revision))

    apply(store, { kind: 'console', text: '\r\x1b[Kframe one\n' })
    expect(store.state.chat).toHaveLength(1)
    expect(woken).toEqual([])
    expect(store.console.text()).toContain('frame one')

    apply(store, { kind: 'pill', text: 'p', icon: 'ℹ️' })
    expect(woken).toEqual([store.state.revision])
  })

  it('advances the cursor model the same way the terminal would', () => {
    const store = makeStore()
    store.console = new ConsoleBuffer()
    apply(store, { kind: 'console', text: 'abcdefgh' })
    apply(store, { kind: 'console', text: '\rxy' })
    expect(store.console.text()).toBe('xycdefgh')
  })

  it('opens and closes a modal through the round-trip helpers', () => {
    const store = makeStore()
    const request: WindowRequest = {
      id: 7,
      kind: 'permission',
      tool: 'write_file',
      detail: 'a.txt'
    }
    applyRequest(store, request)
    expect(store.state.dialog.permission).toEqual({ id: 7, tool: 'write_file', detail: 'a.txt' })

    applyAnswer(store, 'permission')
    expect(store.state.dialog.permission).toBeNull()

    applyRequest(store, { id: 8, kind: 'read-line', prompt: 'Overwrite? [y/N]: ' })
    expect(store.state.dialog.readLine).toEqual({ id: 8, prompt: 'Overwrite? [y/N]: ' })
    applyAnswer(store, 'read-line')

    applyRequest(store, { id: 9, kind: 'confirm-clear' })
    expect(store.state.dialog.confirmClear).toEqual({ id: 9 })
    applyAnswer(store, 'confirm-clear')
    expect(store.state.dialog).toEqual({ readLine: null, permission: null, confirmClear: null })
  })
})

describe('chat_history_items — the index v1.0 associates and copies through', () => {
  const USER = { kind: 'user', text: 'ask', cpIdx: 0, header: 'You', timestamp: '' } as WindowEvent
  const REPLY = {
    kind: 'assistant',
    text: 'sure',
    meta: '',
    header: 'm',
    timestamp: ''
  } as WindowEvent
  const ACTION = (tool: string): WindowEvent => ({ kind: 'action', event: { tool } })

  it('attaches each action to the reply it followed', () => {
    let state = emptyState()
    state = reduce(state, REPLY)
    state = reduce(state, ACTION('read_file'))
    state = reduce(state, ACTION('run_command'))

    // `toMatchObject` reaches the union member's fields without a narrowing assertion hiding a
    // wrong row type.
    expect(state.chat[0]).toMatchObject({
      type: 'assistant',
      associated: [{ tool: 'read_file' }, { tool: 'run_command' }]
    })
  })

  it('drops the association when a new user row arrives, as 5628 does', () => {
    let state = emptyState()
    state = reduce(state, REPLY)
    state = reduce(state, USER)
    state = reduce(state, ACTION('read_file'))

    expect(state.chat[0]).toMatchObject({ associated: [] })
    expect(state.chat[2]).toMatchObject({ type: 'action' })
  })

  it('updates one sub-agent row in place instead of appending every status', () => {
    const status = (value: string): WindowEvent => ({
      kind: 'action',
      event: { type: 'sub-agent', subAgentIdx: 1, runId: 'run-a', status: value, model: 'm1' }
    })
    let state = emptyState()
    state = reduce(state, REPLY)
    state = reduce(state, status('running'))
    state = reduce(state, status('switching'))
    state = reduce(state, status('succeeded'))

    expect(state.chat.filter((row) => row.type === 'action')).toHaveLength(1)
    expect(state.chat[1]).toMatchObject({ event: { status: 'succeeded' } })
    expect(state.chat[0]).toMatchObject({ associated: [{ status: 'succeeded' }] })
  })

  it('keeps a later run’s sub-agent at the same index as its own row', () => {
    const start = (runId: string): WindowEvent => ({
      kind: 'action',
      event: { type: 'sub-agent', subAgentIdx: 1, runId, status: 'running', model: 'm1' }
    })
    let state = emptyState()
    state = reduce(state, start('run-a'))
    state = reduce(state, start('run-b'))

    expect(state.chat.filter((row) => row.type === 'action')).toHaveLength(2)
  })

  it('keeps pills out of the history index, because add_system_pill never appends one', () => {
    let state = emptyState()
    state = reduce(state, { kind: 'pill', text: 'hi', icon: 'ℹ️' })
    state = reduce(state, REPLY)

    // The pill is visible at row 0, but the assistant record is `chat_history_items[0]`.
    expect(state.chat.map((row) => row.type)).toEqual(['pill', 'assistant'])
    expect(state.chat[1]).toMatchObject({ itemIndex: 0 })
    expect(assistantAt(state, 0)).toBe(state.chat[1])
  })

  it('answers a stale index with nothing to copy, as the 4647 bounds check does', () => {
    let state = emptyState()
    state = reduce(state, REPLY)
    state = reduce(state, { kind: 'clear-chat' })

    // `_action_clear` empties the list and leaves `current_assistant_index` pointing past it.
    expect(state.currentAssistantItem).toBe(0)
    expect(assistantAt(state, 0)).toBeNull()
  })

  it('refuses a history index that lands on a non-assistant row', () => {
    let state = emptyState()
    state = reduce(state, {
      kind: 'error',
      title: 't',
      message: 'm',
      details: '',
      icon: '⚠️',
      header: 'h'
    })

    expect(assistantAt(state, 0)).toBeNull()
  })
})

describe('reduce() — streamed assistant deltas', () => {
  it('grows one row from the deltas, then replaces it with the saved reply', () => {
    let state = emptyState()
    state = reduce(state, { kind: 'assistant-delta', text: 'Hel', timestamp: '09:00:00' })
    state = reduce(state, { kind: 'assistant-delta', text: 'lo' })

    expect(state.chat).toHaveLength(1)
    expect(state.chat[0]).toMatchObject({
      type: 'assistant',
      text: 'Hello',
      streaming: true,
      timestamp: '09:00:00'
    })
    const id = state.chat[0].id

    state = reduce(state, {
      kind: 'assistant',
      text: 'Hello there.',
      meta: 'm',
      header: 'h',
      timestamp: '09:00:01'
    })

    // The provider row becomes the persisted one, so the ids never renumber mid-stream.
    expect(state.chat).toHaveLength(1)
    expect(state.chat[0]).toMatchObject({
      id,
      type: 'assistant',
      text: 'Hello there.',
      meta: 'm',
      header: 'h',
      streaming: false
    })
  })

  it('drops only the partial row on reset and keeps earlier history', () => {
    let state = emptyState()
    state = reduce(state, { kind: 'user', text: 'ask', cpIdx: 0, header: 'h', timestamp: '09:00:00' })
    state = reduce(state, { kind: 'assistant-delta', text: 'partial' })
    state = reduce(state, { kind: 'assistant-delta', text: '', reset: true })

    expect(state.chat.map((row) => row.type)).toEqual(['user'])
    expect(state.currentAssistantItem).toBe(-1)

    state = reduce(state, {
      kind: 'assistant',
      text: 'final',
      meta: '',
      header: '',
      timestamp: '09:00:01'
    })
    expect(state.chat.map((row) => row.type)).toEqual(['user', 'assistant'])
  })

  it('ignores an empty delta that is not a reset', () => {
    const state = emptyState()
    expect(reduce(state, { kind: 'assistant-delta', text: '' })).toBe(state)
  })
})

/** One event of each kind, enough to reach the case; the values are not asserted. */
function sample(kind: WindowEvent['kind']): WindowEvent {
  switch (kind) {
    case 'console':
      return { kind, text: '' }
    case 'assistant':
      return { kind, text: 'a', meta: '', header: 'h', timestamp: '00:00:00' }
    case 'assistant-delta':
      return { kind, text: 'd', timestamp: '00:00:00' }
    case 'user':
      return { kind, text: 'u', cpIdx: null, header: 'h', timestamp: '00:00:00' }
    case 'pill':
      return { kind, text: 'p', icon: 'ℹ️' }
    case 'error':
      return { kind, title: 't', message: 'm', details: 'd', icon: '❌', header: 'h' }
    case 'queue-add':
      return { kind, text: 'test' }
    case 'queue-process':
      return { kind }
    case 'action':
      return { kind, event: { tool: 'read_file' } }
    case 'changes':
      return { kind, summary: SUMMARY }
    case 'review-panel':
      return { kind, changes: [] }
    case 'clear-chat':
      return { kind }
    case 'truncate-chat':
      return { kind, rowId: 1 }
    case 'stats':
    case 'mode':
    case 'function-menu':
    case 'model-button':
    case 'active-target':
    case 'top-path':
    case 'target-entry':
      return { kind, text: 'x' } as WindowEvent
    case 'target-error':
      return { kind, text: 'x' }
    case 'status':
      return { kind, text: '● READY', color: '#22c55e' }
    case 'generating':
      return { kind, active: true, thinking: THINKING }
    case 'expand-changes':
      return { kind }
    case 'font-scale':
      return { kind, label: 'UI Scale: 13px (Normal)', size: 13, scale: 1 }
    case 'model-picker':
      return {
        kind,
        items: [],
        currentModel: 'm',
        currentEffort: 'HIGH',
        activeDisplay: 'm',
        supportsThinking: true
      }
    case 'cancel-permission':
      return { kind }
    case 'input':
      return { kind, text: 'x', focus: false }
    case 'queue-delete':
      return { kind, index: 0 }
    case 'queue-edit':
      return { kind, index: 0, text: 'edited' }
    case 'multi-agent-start':
      return { kind, orchestratorModel: 'm', totalSubTasks: 2 }
    case 'multi-agent-sub-agent-update':
      return { kind, subAgentIdx: 0, status: 'running', model: 'm' }
    case 'multi-agent-complete':
      return { kind }
    case 'multi-agent-stop':
      return { kind }
  }
  return { kind } as WindowEvent
}
