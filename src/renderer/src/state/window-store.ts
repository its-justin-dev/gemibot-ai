import { ConsoleBuffer } from '@shared/utils/console-buffer'
import type { ChangesSummary } from '@shared/types/changes'
import type { ContextUsage } from '@shared/types/compaction'
import type { BuildDocView, BuildModeSetting, BuildView } from '@shared/types/build'
import type { FileChangeDict } from '@shared/models/file-change'
import type {
  ModelPickerPayload,
  ModelOption,
  ThinkingState,
  TimelineEventPayload,
  WindowEvent,
  WindowRequest,
  WindowSnapshot,
  MultiAgentSnapshot,
  SubAgentSnapshot,
  ConversationSummary
} from '@shared/types/window'

export type ChatItem =
  | {
      id: number
      type: 'assistant'
      text: string
      meta: string
      header: string
      itemIndex: number
      timestamp: string
      associated: TimelineEventPayload[]
      streaming?: boolean
    }
  | {
      id: number
      type: 'user'
      text: string
      cpIdx: number | null
      header: string
      timestamp: string
      dbId?: number
    }
  | { id: number; type: 'pill'; text: string; icon: string }
  | {
      id: number
      type: 'error'
      title: string
      message: string
      details: string
      icon: string
      header: string
    }
  | { id: number; type: 'action'; event: TimelineEventPayload }
  | { id: number; type: 'divider'; event: TimelineEventPayload }

export interface BarState {
  stats: string
  mode: string
  functionMenu: string
  modelButton: string
  activeTarget: string
  topPath: string
}

export interface DialogState {
  readLine: { id: number; prompt: string } | null
  permission: { id: number; tool: string; detail: string } | null
  confirmClear: { id: number } | null
}

export interface RendererState {
  chat: ChatItem[]
  currentAssistantItem: number
  bar: BarState
  status: { text: string; color: string }
  isGenerating: boolean
  thinking: ThinkingState | null
  targetEntry: string
  targetError: string | null
  input: { text: string; focus: boolean }
  changes: ChangesSummary
  changesExpanded: number
  reviewPanel: FileChangeDict[] | null
  picker: ModelPickerPayload | null
  fontScale: { label: string; size: number; scale: number }
  dialog: DialogState
  revision: number
  permissionCancelCount: number
  queue: string[]
  multiAgent: MultiAgentSnapshot
  conversations: ConversationSummary[]
  activeConversationId: string | null
  hasMoreHistory: boolean
  contextUsage: ContextUsage | null
  build: BuildView | null
  buildMode: BuildModeSetting
  buildDocs: { open: boolean; docs: BuildDocView[] }
}

export interface StaticCatalogs {
  funcOptions: string[]
  modelOptions: ModelOption[]
  fontScaleOptions: string[]
  modeOptions: string[]
}

export interface Store {
  state: RendererState
  catalogs: StaticCatalogs
  console: ConsoleBuffer
  listeners: Set<() => void>
}

let nextId = 0
let prependedId = 0

function id(): number {
  nextId += 1
  return nextId
}

function olderId(): number {
  prependedId -= 1
  return prependedId
}

export function initialState(snapshot: WindowSnapshot): RendererState {
  return {
    chat: [],
    currentAssistantItem: -1,
    bar: { stats: '', mode: '', functionMenu: '', modelButton: '', activeTarget: '', topPath: '' },
    status: { ...snapshot.status },
    isGenerating: snapshot.isGenerating,
    thinking: null,
    targetEntry: snapshot.targetEntry,
    targetError: null,
    input: { text: '', focus: true },
    changes: snapshot.pendingChanges,
    changesExpanded: 0,
    reviewPanel: null,
    picker: null,
    fontScale: {
      label: snapshot.fontScaleLabel,
      size: snapshot.fontScaleSize,
      scale: snapshot.widgetScale
    },
    dialog: { readLine: null, permission: null, confirmClear: null },
    revision: 0,
    permissionCancelCount: 0,
    queue: [...(snapshot.queue ?? [])],
    multiAgent: {
      isActive: false,
      orchestratorModel: '',
      subAgents: [],
      activeSubAgentIdx: null,
      totalSubTasks: 0,
      completedSubTasks: 0
    },
    conversations: [...(snapshot.conversations ?? [])],
    activeConversationId: snapshot.activeConversationId ?? null,
    hasMoreHistory: snapshot.hasMoreHistory ?? false,
    contextUsage: snapshot.contextUsage ?? null,
    build: snapshot.build ?? null,
    buildMode: snapshot.buildMode ?? 'auto',
    buildDocs: { open: false, docs: [] }
  }
}

export function createStore(snapshot: WindowSnapshot): Store {
  return {
    state: replay(snapshot, initialState(snapshot)),
    catalogs: {
      funcOptions: snapshot.funcOptions,
      modelOptions: snapshot.modelOptions,
      fontScaleOptions: snapshot.fontScaleOptions,
      modeOptions: snapshot.modeOptions
    },
    console: new ConsoleBuffer(),
    listeners: new Set<() => void>()
  }
}

export function apply(store: Store, event: WindowEvent): void {
  if (event.kind === 'console') {
    store.console.write(event.text)
    return
  }
  store.state = reduce(store.state, event)
  notify(store)
}

export function applyRequest(store: Store, request: WindowRequest): void {
  store.state = reduceRequest(store.state, request)
  notify(store)
}

export function applyAnswer(store: Store, kind: WindowRequest['kind']): void {
  store.state = clearedDialog(store.state, kind)
  notify(store)
}

export function closeModelPicker(store: Store): void {
  store.state = { ...store.state, picker: null }
  notify(store)
}

export function closeReviewPanel(store: Store): void {
  store.state = { ...store.state, reviewPanel: null }
  notify(store)
}

function notify(store: Store): void {
  for (const listener of store.listeners) listener()
}

function replay(snapshot: WindowSnapshot, state: RendererState): RendererState {
  let next = state
  for (const event of snapshot.history) next = reduce(next, event)
  for (const event of snapshot.stats) next = reduce(next, event)
  return next
}

export function reduce(state: RendererState, event: WindowEvent): RendererState {
  switch (event.kind) {
    case 'assistant-delta': {
      if (event.reset === true) {
        const at = lastStreamingAssistant(state.chat)
        if (at < 0) return state
        return {
          ...state,
          chat: state.chat.filter((_, index) => index !== at),
          currentAssistantItem: -1,
          revision: state.revision + 1
        }
      }
      if (event.text === '') return state
      const at = lastStreamingAssistant(state.chat)
      if (at >= 0) {
        const row = state.chat[at]
        if (row.type !== 'assistant') return state
        return {
          ...state,
          chat: state.chat.map((item, index) =>
            index === at ? { ...row, text: row.text + event.text } : item
          ),
          revision: state.revision + 1
        }
      }
      const itemIndex = state.chat.filter((row) => row.type !== 'pill').length
      const next = chat(state, {
        id: id(),
        type: 'assistant',
        text: event.text,
        meta: '',
        header: '',
        itemIndex,
        timestamp: event.timestamp ?? '',
        associated: [],
        streaming: true
      })
      return { ...next, currentAssistantItem: itemIndex }
    }
    case 'assistant': {
      const at = lastStreamingAssistant(state.chat)
      if (at >= 0) {
        const row = state.chat[at]
        if (row.type !== 'assistant') return state
        return {
          ...state,
          chat: state.chat.map((item, index) =>
            index === at
              ? {
                  ...row,
                  text: event.text,
                  meta: event.meta,
                  header: event.header,
                  timestamp: event.timestamp,
                  streaming: false
                }
              : item
          ),
          currentAssistantItem: row.itemIndex,
          revision: state.revision + 1
        }
      }
      const itemIndex = state.chat.filter((row) => row.type !== 'pill').length
      const next = chat(state, {
        id: id(),
        type: 'assistant',
        text: event.text,
        meta: event.meta,
        header: event.header,
        itemIndex,
        timestamp: event.timestamp,
        associated: []
      })
      return { ...next, currentAssistantItem: itemIndex }
    }
    case 'user': {
      const next = chat(state, {
        id: id(),
        type: 'user',
        text: event.text,
        cpIdx: event.cpIdx,
        header: event.header,
        timestamp: event.timestamp,
        dbId: event.dbId
      })
      return { ...next, currentAssistantItem: -1 }
    }
    case 'action': {
      const key = subAgentKeyOf(event.event)
      if (key !== null) {
        let existingId: number | null = null
        for (let index = state.chat.length - 1; index >= 0; index--) {
          const row = state.chat[index]
          if (row.type === 'action' && subAgentKeyOf(row.event) === key) {
            existingId = row.id
            break
          }
        }
        if (existingId !== null) {
          return {
            ...state,
            chat: state.chat.map((row) => {
              if (row.type === 'action' && row.id === existingId)
                return { ...row, event: event.event }
              if (row.type !== 'assistant') return row
              let changed = false
              const associated = row.associated.map((item) => {
                if (subAgentKeyOf(item) !== key) return item
                changed = true
                return event.event
              })
              return changed ? { ...row, associated } : row
            }),
            revision: state.revision + 1
          }
        }
      }
      const target = assistantAt(state, state.currentAssistantItem)
      const withEvent =
        target === null
          ? state.chat
          : state.chat.map((row) =>
              row === target ? { ...row, associated: [...row.associated, event.event] } : row
            )
      return {
        ...state,
        chat: [...withEvent, { id: id(), type: 'action', event: event.event }],
        revision: state.revision + 1
      }
    }
    case 'compaction-update': {
      const key = compactionIdOf(event.event)
      let replaced = false
      const chat = state.chat.map((row) => {
        if (row.type !== 'action') return row
        if (key === null || compactionIdOf(row.event) !== key) return row
        replaced = true
        return { ...row, event: event.event }
      })
      return {
        ...state,
        chat: replaced ? chat : [...chat, { id: id(), type: 'action', event: event.event }],
        contextUsage: event.context === undefined ? state.contextUsage : event.context,
        revision: state.revision + 1
      }
    }
    case 'compaction-divider': {
      const at = state.chat.findIndex(
        (row) => row.type === 'user' && row.dbId === event.beforeDbId
      )
      const insertAt = at < 0 ? state.chat.length : at
      return {
        ...state,
        chat: [
          ...state.chat.slice(0, insertAt),
          { id: id(), type: 'divider', event: event.event },
          ...state.chat.slice(insertAt)
        ],
        revision: state.revision + 1
      }
    }
    case 'context-usage':
      return { ...state, contextUsage: event.usage }
    case 'build-state':
      return { ...state, build: event.view, revision: state.revision + 1 }
    case 'build-mode':
      return { ...state, buildMode: event.mode }
    case 'build-docs':
      return {
        ...state,
        buildDocs: {
          open: event.open !== false && event.docs.length > 0,
          docs: event.docs
        },
        revision: state.revision + 1
      }
    case 'pill':
      return chat(state, { id: id(), type: 'pill', text: event.text, icon: event.icon })
    case 'error':
      return chat(state, {
        id: id(),
        type: 'error',
        title: event.title,
        message: event.message,
        details: event.details,
        icon: event.icon,
        header: event.header
      })
    case 'clear-chat':
      // v1.0 leaves `current_assistant_index` pointing past the emptied list; the bounds check
      // already returns nothing for it, so keep that index untouched (pinned by window-store).
      return {
        ...state,
        chat: [],
        queue: [],
        hasMoreHistory: false,
        revision: state.revision + 1
      }
    case 'truncate-chat': {
      // Position-based instead of id-based, because older pages are prepended with negative ids
      // that do not follow the live append order.
      const at = state.chat.findIndex((row) => row.id === event.rowId)
      if (at < 0) return { ...state, revision: state.revision + 1 }
      return {
        ...state,
        chat: state.chat.filter((row, index) => row.type === 'pill' || index < at),
        revision: state.revision + 1
      }
    }
    case 'stats':
      return { ...state, bar: { ...state.bar, stats: event.text } }
    case 'mode':
      return { ...state, bar: { ...state.bar, mode: event.text } }
    case 'function-menu':
      return { ...state, bar: { ...state.bar, functionMenu: event.text } }
    case 'model-button':
      return { ...state, bar: { ...state.bar, modelButton: event.text } }
    case 'active-target':
      return { ...state, bar: { ...state.bar, activeTarget: event.text } }
    case 'top-path':
      return { ...state, bar: { ...state.bar, topPath: event.text } }
    case 'status':
      return { ...state, status: { text: event.text, color: event.color } }
    case 'generating':
      return {
        ...state,
        isGenerating: event.active,
        thinking: event.thinking,
        revision: state.revision + 1
      }
    case 'target-entry':
      return { ...state, targetEntry: event.text }
    case 'target-error':
      return { ...state, targetError: event.text }
    case 'input':
      return { ...state, input: { text: event.text, focus: event.focus } }
    case 'changes':
      return { ...state, changes: event.summary }
    case 'expand-changes':
      return { ...state, changesExpanded: state.changesExpanded + 1 }
    case 'review-panel':
      return { ...state, reviewPanel: event.changes }
    case 'font-scale':
      return { ...state, fontScale: { label: event.label, size: event.size, scale: event.scale } }
    case 'model-picker':
      return {
        ...state,
        picker: {
          items: event.items,
          currentModel: event.currentModel,
          currentEffort: event.currentEffort,
          activeDisplay: event.activeDisplay,
          supportsThinking: event.supportsThinking
        }
      }
    case 'cancel-permission':
      return {
        ...state,
        permissionCancelCount: state.permissionCancelCount + 1,
        dialog: { ...state.dialog, permission: null }
      }
    case 'console':
      return state
    case 'multi-agent-start':
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          isActive: true,
          orchestratorModel: (event as WindowEvent & { kind: 'multi-agent-start'; orchestratorModel: string }).orchestratorModel,
          totalSubTasks: (event as WindowEvent & { kind: 'multi-agent-start'; totalSubTasks: number }).totalSubTasks,
          completedSubTasks: 0,
          activeSubAgentIdx: null
        },
        revision: state.revision + 1
      }
    case 'multi-agent-sub-agent-update':
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          subAgents: state.multiAgent.subAgents.map((sa) =>
            sa.id === (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; subAgentIdx: number }).subAgentIdx
              ? {
                  ...sa,
                  status: (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; status: string }).status,
                  model: (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; model?: string }).model ?? sa.model,
                  result: (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; result?: string }).result ?? sa.result,
                  error: (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; error?: string }).error ?? sa.error,
                  compactions:
                    (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; compactions?: SubAgentSnapshot['compactions'] })
                      .compactions ?? sa.compactions
                }
              : sa
          ) as SubAgentSnapshot[],
          completedSubTasks:
            (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; status: string }).status === 'succeeded' ||
            (event as WindowEvent & { kind: 'multi-agent-sub-agent-update'; status: string }).status === 'failed'
              ? state.multiAgent.completedSubTasks + 1
              : state.multiAgent.completedSubTasks
        },
        revision: state.revision + 1
      }
    case 'multi-agent-complete':
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          isActive: false,
          activeSubAgentIdx: null
        },
        revision: state.revision + 1
      }
    case 'multi-agent-stop':
      return state
    case 'queue-add':
      return {
        ...state,
        queue: [...state.queue, event.text],
        revision: state.revision + 1
      }
    case 'queue-delete':
      return {
        ...state,
        queue: state.queue.filter((_, i) => i !== event.index),
        revision: state.revision + 1
      }
    case 'queue-edit':
      return {
        ...state,
        queue: state.queue.map((t, i) => i === event.index ? event.text : t),
        revision: state.revision + 1
      }
    case 'queue-process':
      return {
        ...state,
        queue: state.queue.slice(1),
        revision: state.revision + 1
      }
    case 'queue-sync':
      return {
        ...state,
        queue: [...event.items],
        revision: state.revision + 1
      }
    case 'conversations':
      return {
        ...state,
        conversations: [...event.items],
        activeConversationId: event.activeId,
        revision: state.revision + 1
      }
    case 'history-reset': {
      let next: RendererState = { ...state, chat: [], currentAssistantItem: -1 }
      for (const item of event.events) next = reduce(next, item)
      return { ...next, hasMoreHistory: event.hasMore, revision: state.revision + 1 }
    }
    case 'history-prepend': {
      let prepared: RendererState = { ...state, chat: [], currentAssistantItem: -1 }
      for (const item of event.events) prepared = reduce(prepared, item)
      const olderRows = prepared.chat.map((row) => ({ ...row, id: olderId() }))
      const added = olderRows.filter((row) => row.type !== 'pill').length
      return {
        ...state,
        chat: [...olderRows, ...state.chat],
        currentAssistantItem:
          state.currentAssistantItem < 0 ? -1 : state.currentAssistantItem + added,
        hasMoreHistory: event.hasMore,
        revision: state.revision + 1
      }
    }
    default:
      return state
  }
}

function chat(state: RendererState, item: ChatItem): RendererState {
  return { ...state, chat: [...state.chat, item], revision: state.revision + 1 }
}

function lastStreamingAssistant(rows: ChatItem[]): number {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row.type === 'assistant' && row.streaming === true) return index
  }
  return -1
}

export function assistantAt(
  state: RendererState,
  index: number
): Extract<ChatItem, { type: 'assistant' }> | null {
  if (index < 0) return null
  const items = state.chat.filter((row) => row.type !== 'pill')
  if (index >= items.length) return null
  const item = items[index]
  return item.type === 'assistant' ? item : null
}

/** The per-run key that ties a sub-agent's status events to one timeline row. */
export function subAgentKeyOf(event: TimelineEventPayload): string | null {
  if (event.type !== 'sub-agent') return null
  const idx = event.subAgentIdx
  if (typeof idx !== 'number' || !Number.isFinite(idx)) return null
  const run = typeof event.runId === 'string' ? event.runId : ''
  return `${run}|${idx}`
}

/** The stable id that ties a live compaction row to the record it replaces. */
export function compactionIdOf(event: TimelineEventPayload): string | null {
  const args = event.args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const value = (args as Record<string, unknown>).compaction_id
  return typeof value === 'string' && value !== '' ? value : null
}

export function reduceRequest(state: RendererState, request: WindowRequest): RendererState {
  const dialog: DialogState = { ...state.dialog }
  if (request.kind === 'read-line') dialog.readLine = { id: request.id, prompt: request.prompt }
  else if (request.kind === 'permission')
    dialog.permission = { id: request.id, tool: request.tool, detail: request.detail }
  else dialog.confirmClear = { id: request.id }
  return { ...state, dialog, revision: state.revision + 1 }
}

export function clearedDialog(state: RendererState, kind: WindowRequest['kind']): RendererState {
  const dialog: DialogState = { ...state.dialog }
  if (kind === 'read-line') dialog.readLine = null
  else if (kind === 'permission') dialog.permission = null
  else dialog.confirmClear = null
  return { ...state, dialog }
}