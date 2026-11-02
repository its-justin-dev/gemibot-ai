import type { ToolLogEntry, TurnFileChange } from '../../shared/utils/memory-entry'
import type { TokenSettings } from '../../shared/types/token-settings'
import {
  DEFAULT_BEHAVIOR_SETTINGS,
  type BehaviorSettings,
  type TaskComplexity
} from '../../shared/types/behavior-settings'
import type { EffortLevel } from '../../shared/models/effort-level'
import type { Content } from './content'

export interface AssistantDelta {
  text: string
  reset?: boolean
}

export type UndoEntry = [
  fullPath: string,
  oldText: string | null,
  crlf: boolean,
  oldBytes?: Buffer
]

export type TimelineEvent = Record<string, unknown>

export type TimelineTurn = Record<string, unknown>

export type Todo = Record<string, unknown>

export type Checkpoint = Record<string, unknown>

export interface EscMonitor {
  interrupted: boolean
  check(): boolean
  pause(): void
  resume(): void
}

export type PermissionAnswer = boolean | string | null | undefined

export type PermissionCallback = (
  tool: string,
  detail: string
) => PermissionAnswer | Promise<PermissionAnswer>

/** The app's live record of the turn in progress, kept by `ConversationJournal`. */
export interface ConversationRecorder {
  record(label: string, body: string): void
  recordEvent(event: TimelineEvent): void
}

export class AgentState {
  readonly appRoot: string
  root: string
  model: string
  pinned: boolean
  autoYes: boolean
  mode: string
  activeFunction: string
  contents: Content[]
  always: Set<string>
  undoStack: UndoEntry[]
  checkpoints: Checkpoint[]
  todos: Todo[]
  system: string | null
  tokensIn: number
  tokensOut: number
  escMonitor: EscMonitor | null
  turnToolLogs: ToolLogEntry[]
  turnFileChanges: TurnFileChange[]
  turnTimelineEvents: TimelineEvent[]
  timelineHistory: TimelineTurn[]
  /** The model that actually answered last, which differs from `model` after a ladder fallback. */
  lastRoutedModel: string | null
  /** Digest of the older entries the current request left out, injected into the system prompt. */
  requestDigest: string | null
  /** The persisted summary of everything before this index in `contents`. */
  historySummary: string | null
  /** First content index sent in full; earlier entries are represented by `historySummary`. */
  compactionSplitIndex: number
  lastPromptTokensEstimate: number
  /** The SQLite conversation these requests belong to, for the token usage log. */
  conversationId: string | null
  /** `main` or `sub-agent N`; identifies the sender in the token usage log. */
  usageSender: string
  /** Characters of the memory feed inside `system`, so logging can split the prompt cost. */
  memoryPromptChars: number
  /** Live token-efficiency switches; null keeps the v1 request shape. */
  tokenSettings: TokenSettings | null
  /** Prompt depth, deep mode, step budget and streaming preference. */
  behaviorSettings: BehaviorSettings
  /** How the current request was classified; null outside a turn or before routing. */
  taskComplexity: TaskComplexity | null
  /** True when deep mode is active for the request in flight. */
  deepActive: boolean
  /** The user's model while an automatic deep route is active; null otherwise. */
  routedFromModel: string | null
  /** Per-agent effort for sub-agents and Build stages; null follows the model picker. */
  effortOverride: EffortLevel | null
  /** Enables complexity routing and the final verification pass (window runtime). */
  advancedAgent: boolean
  /** Build sub-agents may write project files without a prompt, but never run commands. */
  autoApproveEdits: boolean
  /** Streaming is only offered when the surface can render live deltas. */
  streamingAllowed: boolean
  /** Bumped once per turn so tool caches and loop counters never leak across prompts. */
  toolTurnSerial: number
  /** False when the most recent turn ended in an error or a user stop. */
  lastTurnSucceeded: boolean
  /** Why the most recent turn stopped, when it did. */
  lastTurnError: string | null
  lastTurnCancelled: boolean
  onTimelineEvent: ((event: TimelineEvent) => void) | null
  onAssistantDelta: ((delta: AssistantDelta) => void) | null
  onError: ((userMsg: string, rawError: string) => void) | null
  onToolError: ((tool: string, error: string) => void) | null
  onPermission: PermissionCallback | null
  /** Mirrors every content the engine adds to the model history into the conversation store. */
  onContentAdded: ((content: Content) => void) | null
  /** Mirrors a rollback: contents at or after `length` were dropped. */
  onContentsTruncated: ((length: number, compactionReset: boolean) => void) | null
  cancelRequested: boolean
  journal: ConversationRecorder | null

  constructor(root: string, model: string, autoYes = false, pinned = false) {
    this.appRoot = root
    this.root = root
    this.model = model
    this.pinned = pinned
    this.autoYes = autoYes
    this.mode = 'build'
    this.activeFunction = 'all'
    this.contents = []
    this.always = new Set<string>()
    this.undoStack = []
    this.checkpoints = []
    this.todos = []
    this.system = null
    this.tokensIn = 0
    this.tokensOut = 0
    this.escMonitor = null
    this.turnToolLogs = []
    this.turnFileChanges = []
    this.turnTimelineEvents = []
    this.timelineHistory = []
    this.lastRoutedModel = null
    this.requestDigest = null
    this.historySummary = null
    this.compactionSplitIndex = 0
    this.lastPromptTokensEstimate = 0
    this.conversationId = null
    this.usageSender = 'main'
    this.memoryPromptChars = 0
    this.tokenSettings = null
    this.behaviorSettings = { ...DEFAULT_BEHAVIOR_SETTINGS }
    this.taskComplexity = null
    this.deepActive = false
    this.routedFromModel = null
    this.effortOverride = null
    this.advancedAgent = false
    this.autoApproveEdits = false
    this.streamingAllowed = false
    this.toolTurnSerial = 0
    this.lastTurnSucceeded = false
    this.lastTurnError = null
    this.lastTurnCancelled = false
    this.onTimelineEvent = null
    this.onAssistantDelta = null
    this.onError = null
    this.onToolError = null
    this.onPermission = null
    this.onContentAdded = null
    this.onContentsTruncated = null
    this.cancelRequested = false
    this.journal = null
  }

  /** Adds a content and mirrors it to the conversation store; the only place history grows. */
  pushContent(content: Content): void {
    this.contents.push(content)
    if (typeof this.onContentAdded === 'function') {
      try {
        this.onContentAdded(content)
      } catch {}
    }
  }

  truncateContents(length: number): void {
    if (length >= this.contents.length) return
    this.contents.splice(length)
    // A split at or below the new length still has all of its kept entries; one above it points
    // into deleted history, so the summary can no longer describe what is being sent.
    const compactionReset =
      this.compactionSplitIndex > 0 && length < this.compactionSplitIndex
    if (compactionReset) {
      this.historySummary = null
      this.compactionSplitIndex = 0
    }
    this.requestDigest = null
    if (typeof this.onContentsTruncated === 'function') {
      try {
        this.onContentsTruncated(length, compactionReset)
      } catch {}
    }
  }
}
