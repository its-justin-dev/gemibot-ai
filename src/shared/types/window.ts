import type { ChangesSummary } from './changes'
import type { CompactionView, ContextUsage } from './compaction'
import type { FileChangeDict } from '../models/file-change'
import type { BuildDocView, BuildModeSetting, BuildView } from './build'

export type TimelineEventPayload = Record<string, unknown>

export interface ModelOption {
  id: string
  display: string
}

export interface ModelPickerItem {
  id: string
  display: string
  category: string
  badge: string
  supports_thinking: boolean
  searchable_blob: string
}

export interface ThinkingState {
  init: string
  parts: string[]
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  preview: string
  messageCount: number
  subAgentCount: number
  parentId: string | null
}

export type WindowEvent =
  | { kind: 'console'; text: string }
  | {
      kind: 'assistant'
      text: string
      meta: string
      header: string
      timestamp: string
      dbId?: number
    }
  | { kind: 'assistant-delta'; text: string; reset?: boolean; timestamp?: string }
  | {
      kind: 'user'
      text: string
      cpIdx: number | null
      header: string
      timestamp: string
      dbId?: number
    }
  | { kind: 'pill'; text: string; icon: string }
  | { kind: 'error'; title: string; message: string; details: string; icon: string; header: string }
  | { kind: 'action'; event: TimelineEventPayload }
  | {
      kind: 'compaction-update'
      dbId: number
      event: TimelineEventPayload
      context?: ContextUsage | null
    }
  | { kind: 'compaction-divider'; beforeDbId: number; event: TimelineEventPayload }
  | { kind: 'context-usage'; usage: ContextUsage | null }
  | { kind: 'changes'; summary: ChangesSummary }
  | { kind: 'review-panel'; changes: FileChangeDict[] }
  | { kind: 'clear-chat' }
  | { kind: 'truncate-chat'; rowId: number }
  | { kind: 'stats'; text: string }
  | { kind: 'mode'; text: string }
  | { kind: 'function-menu'; text: string }
  | { kind: 'model-button'; text: string }
  | { kind: 'active-target'; text: string }
  | { kind: 'top-path'; text: string }
  | { kind: 'target-entry'; text: string }
  | { kind: 'target-error'; text: string | null }
  | { kind: 'status'; text: string; color: string }
  | { kind: 'generating'; active: boolean; thinking: ThinkingState | null }
  | { kind: 'expand-changes' }
  | { kind: 'font-scale'; label: string; size: number; scale: number }
  | {
      kind: 'model-picker'
      items: ModelPickerItem[]
      currentModel: string
      currentEffort: string
      activeDisplay: string
      supportsThinking: boolean
    }
  | { kind: 'cancel-permission' }
  | { kind: 'input'; text: string; focus: boolean }
  | { kind: 'queue-add'; text: string }
  | { kind: 'queue-process'; text?: string }
  | { kind: 'queue-delete'; index: number }
  | { kind: 'queue-edit'; index: number; text: string }
  | { kind: 'queue-sync'; items: string[] }
  | {
      kind: 'conversations'
      items: ConversationSummary[]
      activeId: string | null
    }
  | { kind: 'history-reset'; events: WindowEvent[]; hasMore: boolean }
  | { kind: 'history-prepend'; events: WindowEvent[]; hasMore: boolean }
  | { kind: 'multi-agent-start'; orchestratorModel: string; totalSubTasks: number }
  | {
      kind: 'multi-agent-sub-agent-update'
      subAgentIdx: number
      status: string
      result?: string
      error?: string
      model?: string
      compactions?: CompactionView[]
    }
  | { kind: 'multi-agent-complete'; results?: Record<string, string> }
  | { kind: 'multi-agent-stop'; subAgentIdx?: number }
  | { kind: 'build-state'; view: BuildView | null }
  | { kind: 'build-mode'; mode: BuildModeSetting }
  | { kind: 'build-docs'; docs: BuildDocView[]; open?: boolean }

export type ModelPickerPayload = Omit<Extract<WindowEvent, { kind: 'model-picker' }>, 'kind'>

export type WindowRequest =
  | { id: number; kind: 'read-line'; prompt: string }
  | { id: number; kind: 'permission'; tool: string; detail: string }
  | { id: number; kind: 'confirm-clear' }

export type WindowAnswer = string | boolean | null

export interface WindowReply {
  id: number
  answer: WindowAnswer
}

export type WindowAction =
  | 'todos'
  | 'settings'
  | 'undo'
  | 'revert'
  | 'memory'
  | 'pip'
  | 'usage'
  | 'token'
  | 'clear'

export type WindowCommand =
  | { cmd: 'send'; text: string }
  | { cmd: 'action'; name: WindowAction }
  | { cmd: 'compact' }
  | { cmd: 'stop' }
  | { cmd: 'accept-all' }
  | { cmd: 'reject-all' }
  | { cmd: 'accept-file'; path: string }
  | { cmd: 'reject-file'; path: string }
  | { cmd: 'review-open' }
  | { cmd: 'review-panel-close' }
  | { cmd: 'target-apply'; path: string }
  | { cmd: 'target-browse' }
  | { cmd: 'target-clear' }
  | { cmd: 'mode-change'; value: string }
  | { cmd: 'function-change'; display: string }
  | { cmd: 'model-change'; display: string }
  | { cmd: 'model-picker' }
  | { cmd: 'model-selected'; modelId: string; display: string }
  | { cmd: 'effort-selected'; value: string }
  | { cmd: 'font-scale'; label: string }
  | { cmd: 'edit-user'; text: string; cpIdx: number | null; rowId: number; dbId?: number }
  | { cmd: 'copy'; text: string }
  | { cmd: 'copy-path'; rel: string }
  | { cmd: 'open-file'; rel: string }
  | { cmd: 'export-timeline'; path: string; content: string }
  | { cmd: 'queue-add'; text: string }
  | { cmd: 'queue-process'; text?: string }
  | { cmd: 'queue-delete'; index: number }
  | { cmd: 'queue-edit'; index: number; text: string }
  | { cmd: 'queue-send-now'; index: number }
  | { cmd: 'multi-agent-start'; orchestratorModel: string; totalSubTasks: number }
  | { cmd: 'multi-agent-sub-agent-update'; subAgentIdx: number; status: string; result?: string; error?: string; model?: string }
  | { cmd: 'multi-agent-complete'; results?: Record<string, string> }
  | { cmd: 'multi-agent-stop'; subAgentIdx?: number }
  | { cmd: 'multi-agent-enable'; enabled: boolean }
  | { cmd: 'multi-agent-max'; max: number }
  | { cmd: 'build-mode'; mode: BuildModeSetting }
  | { cmd: 'build-pause' }
  | { cmd: 'build-resume' }
  | { cmd: 'build-stop' }
  | { cmd: 'build-approve' }
  | { cmd: 'build-revise'; text: string }
  | { cmd: 'build-docs' }
  | { cmd: 'build-docs-close' }
  | { cmd: 'build-setting'; key: string; value: string }
  | { cmd: 'conversation-new' }
  | { cmd: 'conversation-open'; id: string }
  | { cmd: 'conversation-rename'; id: string; title: string }
  | { cmd: 'conversation-delete'; id: string }
  | { cmd: 'conversation-export'; id: string; format: 'md' | 'json' }
  | { cmd: 'load-older' }
  | { cmd: 'open-data-folder' }

export interface TimelineSaveTarget {
  path: string
  project: string
  model: string
}

export interface WindowSnapshot {
  history: WindowEvent[]
  stats: WindowEvent[]
  pendingChanges: ChangesSummary
  isGenerating: boolean
  status: { text: string; color: string }
  funcOptions: string[]
  modelOptions: ModelOption[]
  fontScaleOptions: string[]
  modeOptions: string[]
  fontScaleLabel: string
  fontScaleSize: number
  widgetScale: number
  targetEntry: string
  multiAgent: MultiAgentSnapshot
  conversations?: ConversationSummary[]
  activeConversationId?: string | null
  hasMoreHistory?: boolean
  queue?: string[]
  contextUsage?: ContextUsage | null
  build?: BuildView | null
  buildMode?: BuildModeSetting
}

export interface MultiAgentSnapshot {
  isActive: boolean
  orchestratorModel: string
  subAgents: SubAgentSnapshot[]
  activeSubAgentIdx: number | null
  totalSubTasks: number
  completedSubTasks: number
}

export interface SubAgentSnapshot {
  id: number
  task: string
  model: string
  effort: string
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'switching'
  result: string | null
  error: string | null
  fileChanges: FileChangeDict[]
  modelSwitches: ModelSwitchEvent[]
  compactions?: CompactionView[]
}

export interface ModelSwitchEvent {
  fromModel: string
  toModel: string
  reason: string
  timestamp: string
}
