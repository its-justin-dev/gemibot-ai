import { stat } from 'fs/promises'
import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import {
  ALL_DECLARATIONS,
  FUNCTION_CATALOG,
  FUNCTION_TOOL_MAP,
  TOOL_ICONS
} from '../../shared/constants/tool-definitions'
import { KeyboardInterrupt, errorMessage } from '../../shared/utils/exceptions'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pySlice, pyStr } from '../../shared/utils/pystr'
import { pyTime } from '../../shared/utils/pytime'
import { clip, ensureBro } from '../../shared/utils/text'
import { assessTaskComplexity, stepBudgetFor } from '../../shared/utils/task-complexity'
import type { TaskComplexity } from '../../shared/types/behavior-settings'
import { nowStrftime } from '../../shared/utils/strftime'
import { wrap } from '../../shared/utils/textwrap'
import { out, show } from '../utils/console-out'
import { readText } from '../utils/fs-text'
import { EscMonitor, type KeyPoll } from '../utils/esc-monitor'
import { checkInternet } from '../utils/net-check'
import { fitToolOutput } from '../utils/tool-output'
import type { AgentState, Checkpoint, TimelineTurn } from '../models/agent-state'
import type { Content, FunctionCall, Part } from '../models/content'
import { elapsedText, type AgentGenerate } from './agent-generate.service'
import type { AgentMemory } from './agent-memory.service'
import type { AgentPaths } from './agent-paths.service'
import type { ChooseHook } from './agent-session.service'
import type { AgentSettings } from './agent-settings.service'
import type { AgentSystem } from './agent-system.service'
import type { ConversationCompactor } from './conversation-compaction.service'
import type { ConversationJournal } from './conversation-journal.service'

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<Record<string, unknown>>

export interface AgentTurnDeps {
  state: AgentState
  paths: AgentPaths
  memory: AgentMemory
  system: AgentSystem
  settings: AgentSettings
  generate: AgentGenerate
  compactor: ConversationCompactor
  execute: ToolExecutor
  choose: ChooseHook
  keyPoll?: KeyPoll
  journal?: ConversationJournal
  effort(): string
  /** Routes a complex request to a stronger model/effort for this turn only. */
  routeTask?(level: TaskComplexity): { model: string; effort: string } | null
  restoreRoute?(): void
  /** Used by sub-agents, whose replies never pass through the window transport. */
  onAssistantReply?: (text: string, meta: string) => void
}

const DESCRIBE_KEYS = ['path', 'output_path', 'db_path', 'pattern', 'command', 'url', 'prompt']

const FINAL_CHECK_PROMPT =
  'Final check before finishing: re-read the original user request and the current todo list. ' +
  'If anything required is missing, unverified or failing, continue working with tools now. ' +
  'Otherwise reply with the final answer only.'

const LOOP_STOP_AFTER = 3

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export class AgentTurn {
  constructor(private readonly deps: AgentTurnDeps) {}

  describe(_name: string, args: Record<string, unknown>): string {
    for (const key of DESCRIBE_KEYS) {
      if (key in args) return pySlice(pyStr(args[key]).replaceAll('\n', ' '), 0, 95)
    }
    return ''
  }

  async expandMentions(text: string): Promise<string> {
    const blocks: string[] = []
    for (const match of text.matchAll(/(?<!\S)@(\S+)/g)) {
      const token = match[1]
      try {
        const full = await this.deps.paths.resolve(token)
        if (await isFile(full)) {
          const { text: body } = await readText(full)
          blocks.push(`<file path="${token}">\n${clip(body, 20000)}\n</file>`)
        }
      } catch {}
    }
    if (blocks.length === 0) return text
    out(`  ${C.GRAY}- Attached ${blocks.length} file(s)${C.RESET}`)
    return `${text}\n\nReferenced files:\n${blocks.join('\n')}`
  }

  cancel(): void {
    this.deps.state.cancelRequested = true
    if (this.deps.state.escMonitor) this.deps.state.escMonitor.interrupted = true
    this.deps.generate.cancel()
  }

  private notifyAssistant(text: string, meta: string): void {
    if (typeof this.deps.onAssistantReply !== 'function') return
    try {
      this.deps.onAssistantReply(text, meta)
    } catch {}
  }

  /** A turn-level timeline row (mode, final check, loop stop) that is not a tool call. */
  private emitEvent(
    tool: string,
    args: Record<string, unknown>,
    output: string,
    status: 'Success' | 'Failed'
  ): void {
    const state = this.deps.state
    const event = {
      type: 'action',
      tool,
      args,
      output,
      is_error: status === 'Failed',
      status,
      timestamp: nowStrftime('%H:%M:%S'),
      file_changes: []
    }
    state.turnTimelineEvents.push(event)
    state.journal?.recordEvent(event)
    if (typeof state.onTimelineEvent === 'function') {
      try {
        state.onTimelineEvent(event)
      } catch {
        /* a renderer/transport failure must not abort the turn */
      }
    }
  }

  /** Drops a partially streamed reply that will never become a saved assistant row. */
  private resetStream(): void {
    const state = this.deps.state
    if (!state.streamingAllowed || !state.behaviorSettings.streamResponses) return
    const notify = state.onAssistantDelta
    if (typeof notify !== 'function') return
    try {
      notify({ text: '', reset: true })
    } catch {
      /* a renderer/transport failure must not abort the turn */
    }
  }

  async turn(userText: string, options?: { compactionPrepared?: boolean }): Promise<void> {
    const state = this.deps.state
    state.lastTurnSucceeded = false
    state.lastTurnError = null
    state.lastTurnCancelled = false

    if (!(await checkInternet())) {
      const msg =
        'Error: No internet connection. Please check your network connection and try again.'
      state.lastTurnError = msg
      out(`\n${C.RED}┃ Error: No internet connection${C.RESET}`)
      if (typeof state.onError === 'function') {
        try {
          state.onError(msg, 'Error: No internet connection (probe failed)')
        } catch {}
      } else {
        await show('Gemibot', msg, C.RED, 'Network Error')
      }
      return
    }

    state.cancelRequested = false
    state.toolTurnSerial += 1
    const mark = state.contents.length
    const undoMark = state.undoStack.length
    state.turnToolLogs = []
    state.turnFileChanges = []
    state.turnTimelineEvents = []

    const behavior = state.behaviorSettings
    let stepLimit = AppConstants.MAX_STEPS
    let modeReasons: string[] = []
    if (state.advancedAgent) {
      const assessment = assessTaskComplexity(userText)
      state.taskComplexity = assessment.level
      state.deepActive = behavior.deepMode && assessment.level === 'complex'
      stepLimit = stepBudgetFor(assessment.level, behavior.maxSteps, state.deepActive)
      modeReasons = assessment.reasons
    } else {
      state.taskComplexity = null
      state.deepActive = false
    }
    let route: { model: string; effort: string } | null = null
    if (state.deepActive && typeof this.deps.routeTask === 'function') {
      try {
        route = this.deps.routeTask('complex')
      } catch {
        route = null
      }
    }

    await this.deps.memory.ensureMemory()
    const memoryBeforeText = await this.deps.memory.readMemoryContent()
    state.system = await this.deps.system.buildSystem(state, userText)
    // Opened after memory is read and rendered into the prompt, so the journal block itself
    // never enters the context, but the banner below and everything after it gets captured.
    await this.deps.journal?.begin(
      { model: state.model, effort: this.deps.effort(), mode: state.mode },
      userText
    )
    out(
      `\n  ${C.GRAY}- ${C.MAGENTA}-' memory_read${C.RESET} ` +
        `${C.DIM}conversation database (${pyFormatThousands(memoryBeforeText.length)} chars loaded)${C.RESET}`
    )

    const checkpoint: Checkpoint = {
      prompt: userText,
      time: nowStrftime('%H:%M:%S'),
      contents_len: mark,
      undo_len: undoMark,
      todos: state.todos.map((t) => ({ ...t })),
      memory_len: memoryBeforeText.length
    }
    state.checkpoints.push(checkpoint)

    const expanded = await this.expandMentions(userText)
    const framedMessage =
      `Active Function Suite: ${state.activeFunction} | Active Mode: ${state.mode}\n` +
      `User Request:\n${expanded}`
    if (options?.compactionPrepared === true) this.deps.compactor.resumePreparedTurn()
    else await this.deps.compactor.prepareBeforeTurn(framedMessage)
    state.pushContent({ role: 'user', parts: [{ text: framedMessage }] })
    if (state.advancedAgent && state.taskComplexity !== null && state.taskComplexity !== 'simple') {
      this.emitEvent(
        'agent_mode',
        {
          level: state.taskComplexity,
          deep: state.deepActive,
          steps: stepLimit,
          ...(route !== null ? { model: route.model, effort: route.effort } : {}),
          reasons: modeReasons.slice(0, 3)
        },
        state.deepActive
          ? 'Deep mode: planned the work, routed to a stronger model and will verify before finishing.'
          : 'Standard mode: working directly and verifying what changed.',
        'Success'
      )
    }
    const turnStart = pyTime()
    const collectedReplies: string[] = []

    const mon = new EscMonitor(this.deps.keyPoll)
    mon.resume()

    try {
      state.escMonitor = mon
      // The ladder remembers dead models for one turn only, so a rate limit that clears between
      // messages gets another chance at the next one.
      this.deps.generate.beginTurn()
      try {
        let brokeOut = false
        let finalCheckDone = false
        let loopStopMessage: string | null = null
        const failureCounts = new Map<string, number>()
        for (let step = 0; step < stepLimit; step++) {
          if (mon.check() || state.cancelRequested) throw new KeyboardInterrupt()
          const response = await this.deps.generate.generate()
          if (mon.check() || state.cancelRequested) throw new KeyboardInterrupt()
          this.deps.generate.countUsage(response)
          const candidate = response.candidates.length > 0 ? response.candidates[0] : null
          const parts = candidate?.content?.parts || []
          if (parts.length === 0) {
            const emptyMsg = 'Bro, I got an empty reply. Try again?'
            this.deps.journal?.record('GemiBot AI', emptyMsg)
            this.notifyAssistant(emptyMsg, '')
            await show('GemiBot AI', emptyMsg, C.GREEN)
            collectedReplies.push(emptyMsg)
            brokeOut = true
            break
          }
          state.pushContent(candidate?.content as Content)
          const thoughts = parts
            .filter((p) => p.thought && p.text)
            .map((p) => p.text as string)
            .join('\n\n')
            .trim()
          if (thoughts) this.deps.journal?.record('Model Thinking', thoughts)
          const text = parts
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text as string)
            .join('')
            .trim()
          const calls = parts
            .filter((p) => p.function_call)
            .map((p) => p.function_call as FunctionCall)
          const unfinishedTodos = state.todos.some((todo) => {
            const status = String(todo['status'] ?? '').toLowerCase()
            return status !== '' && status !== 'completed' && status !== 'cancelled'
          })
          // A stale list from an older task must not add a check to an unrelated simple answer.
          const touchedTodos = state.turnToolLogs.some((log) => log.tool === 'todo_write')
          const shouldFinalCheck =
            calls.length === 0 &&
            text !== '' &&
            !finalCheckDone &&
            state.advancedAgent &&
            (state.deepActive || (unfinishedTodos && touchedTodos)) &&
            (state.todos.length > 0 || state.turnToolLogs.length > 0)
          if (shouldFinalCheck) {
            // The premature finish text stays in the model history but is never shown as the
            // answer; the final answer is whatever the model says after the check.
            finalCheckDone = true
            this.resetStream()
            state.pushContent({ role: 'user', parts: [{ text: FINAL_CHECK_PROMPT }] })
            this.emitEvent(
              'final_check',
              { todos: state.todos.length, tools: state.turnToolLogs.length },
              'Compared the original request and the todo list with the work done before finishing.',
              'Success'
            )
            continue
          }
          if (text) {
            const elapsed = `${elapsedText(pyTime() - turnStart)}s`
            const meta = `${state.model} - ${state.activeFunction} - ${elapsed}`
            const displayed = calls.length === 0 ? ensureBro(userText, text) : text
            collectedReplies.push(displayed)
            this.deps.journal?.record(`GemiBot AI (${elapsed})`, displayed)
            this.notifyAssistant(displayed, meta)
            await show('GemiBot AI', displayed, C.GREEN, meta, mon)
          }
          if (calls.length === 0) {
            brokeOut = true
            break
          }
          const results: Part[] = []
          for (const call of calls) {
            if (mon.check() || state.cancelRequested) throw new KeyboardInterrupt()
            const args = { ...(call.args || {}) }
            const icon = TOOL_ICONS[call.name ?? ''] || '-'
            const desc = this.describe(call.name ?? '', args)
            out(`  ${C.GRAY}- ${C.CYAN}${icon} ${call.name}${C.RESET} ${C.DIM}${desc}${C.RESET}`)
            const result = await this.deps.execute(call.name ?? '', args)
            if ('error' in result) {
              const errorText = pyStr(result.error)
              out(`  ${C.GRAY}- ${C.RED}- ${pySlice(errorText, 0, 200)}${C.RESET}`)
              if (typeof state.onToolError === 'function') {
                try {
                  state.onToolError(call.name ?? '', errorText)
                } catch {}
              }
              const fingerprint = `${call.name ?? ''}\u0000${clip(errorText, 300)}`
              const repeats = (failureCounts.get(fingerprint) ?? 0) + 1
              failureCounts.set(fingerprint, repeats)
              if (repeats >= LOOP_STOP_AFTER && loopStopMessage === null) {
                loopStopMessage =
                  `I stopped instead of repeating the same failing call: ${call.name} returned ` +
                  `the same error ${repeats} times in this turn. Last error: ${clip(errorText, 400)}`
                this.emitEvent(
                  'loop_stop',
                  { tool: call.name ?? '', repeats, error: clip(errorText, 1000) },
                  loopStopMessage,
                  'Failed'
                )
              }
            }
            const response = { ...result }
            const settings = state.tokenSettings ?? null
            if (settings !== null && typeof response.output === 'string') {
              response.output = fitToolOutput(
                call.name ?? '',
                response.output,
                settings.maxToolOutputChars
              )
            }
            results.push({
              function_response: { id: call.id ?? null, name: call.name ?? null, response }
            })
          }
          state.pushContent({ role: 'user', parts: results })
          if (loopStopMessage !== null) {
            collectedReplies.push(loopStopMessage)
            this.deps.journal?.record('GemiBot AI', loopStopMessage)
            this.notifyAssistant(loopStopMessage, `${state.model} - ${state.activeFunction}`)
            await show('GemiBot AI', loopStopMessage, C.YELLOW)
            brokeOut = true
            break
          }
        }
        const hitStepLimit = !brokeOut
        if (hitStepLimit) {
          if (state.advancedAgent) {
            out(
              `\n  ${C.YELLOW}-' Reached the step limit (${stepLimit} steps). ` +
                `Tell me to continue, bro.${C.RESET}`
            )
            this.emitEvent(
              'step_limit',
              { steps: stepLimit },
              `Stopped at the ${stepLimit}-step limit.`,
              'Failed'
            )
          } else {
            out(`\n  ${C.YELLOW}-' Reached the step limit. Tell me to continue, bro.${C.RESET}`)
          }
        }

        // Closing the journal before the v1 interaction log keeps that block below the
        // conversation block instead of being absorbed into part 4.
        await this.deps.journal?.end(brokeOut ? undefined : 'Reached the step limit.')
        await this.deps.memory.logInteraction({
          mode: state.mode,
          activeFunction: state.activeFunction,
          model: state.model,
          userPrompt: userText,
          aiResponses: collectedReplies,
          turnToolLogs: state.turnToolLogs,
          turnFileChanges: state.turnFileChanges
        })
        state.system = await this.deps.system.buildSystem(state, userText)
        out(
          `\n  ${C.GRAY}- ${C.MAGENTA}- memory_log${C.RESET} ` +
            `${C.DIM}Logged prompt, full response, ${state.turnToolLogs.length} tool output(s), ` +
            `and ${state.turnFileChanges.length} file change(s) to the conversation database${C.RESET}`
        )
        const row: TimelineTurn = {
          prompt: userText,
          timestamp: nowStrftime('%H:%M:%S'),
          replies: collectedReplies,
          events: state.turnTimelineEvents.map((e) => ({ ...e })),
          file_changes: state.turnFileChanges.map((c) => ({ ...c }))
        }
        state.timelineHistory.push(row)
        state.lastTurnSucceeded = loopStopMessage === null && !hitStepLimit
        if (loopStopMessage !== null) state.lastTurnError = loopStopMessage
        else if (hitStepLimit) state.lastTurnError = `Reached the ${stepLimit}-step limit.`
      } finally {
        mon.pause()
      }
    } catch (e) {
      this.resetStream()
      state.truncateContents(mark)
      if (
        state.undoStack.length === undoMark &&
        state.checkpoints.length > 0 &&
        state.checkpoints[state.checkpoints.length - 1] === checkpoint
      )
        state.checkpoints.pop()

      if (e instanceof KeyboardInterrupt) {
        state.lastTurnCancelled = true
        state.lastTurnError = 'Interrupted by user'
        out(`\n  ${C.YELLOW}┃ - Interrupted by user (Esc)${C.RESET}`)
        await this.deps.journal?.end('Interrupted by user (Esc).')
      } else {
        const err = errorMessage(e)
        state.lastTurnError = err
        let msg: string
        if (AppConstants.isNetworkError(err)) {
          msg = 'Error: No internet connection. Please check your network connection and try again.'
        } else if (err.includes('429')) {
          msg =
            `Quota or rate limit reached for ${state.model}. Wait a bit, or pick another ` +
            'model with /model. Pro models usually need a billing-enabled key.'
        } else if (err.includes('404')) {
          msg = `${state.model} is not available for your key. Pick another model with /model.`
        } else if (err.includes('503') || err.includes('UNAVAILABLE')) {
          msg = `${state.model} is busy right now. Try again in a minute, or pick another model with /model.`
        } else {
          msg = `[${state.model}] ${err}`
        }
        out(`\n${C.RED}┃ ${C.BOLD}System Error${C.RESET}`)
        const wrapped = wrap(msg, AppConstants.WIDTH)
        for (const line of wrapped.length > 0 ? wrapped : [msg]) {
          out(`${C.RED}┃${C.RESET} ${line}`)
        }
        if (typeof state.onError === 'function') {
          try {
            state.onError(msg, err)
          } catch {}
        }
      }
    } finally {
      state.escMonitor = null
      // The GUI tees its own error cards into the journal while `onError` is still wired.
      await this.deps.journal?.end()
      if (typeof this.deps.restoreRoute === 'function') {
        try {
          this.deps.restoreRoute()
        } catch {}
      }
    }
  }

  async pickFunction(): Promise<void> {
    const state = this.deps.state
    const chosen = await this.deps.choose(
      'Select Gemibot Function Suite or Mode',
      FUNCTION_CATALOG,
      { current: state.activeFunction, page: 15 }
    )
    if (!chosen) {
      out(`  ${C.DIM}Cancelled. Active function suite: ${state.activeFunction}${C.RESET}`)
      return
    }

    if (chosen === 'pip_installer') {
      await this.installPipPackages()
      return
    }

    if (chosen === 'build' || chosen === 'plan' || chosen === 'read') {
      state.mode = chosen
      state.activeFunction = chosen === 'build' ? 'all' : chosen
    } else {
      state.mode = 'build'
      state.activeFunction = chosen
    }

    state.system = await this.deps.system.buildSystem(state)
    await this.deps.settings.saveSettings({
      function_suite: state.activeFunction,
      mode: state.mode
    })
    const toolsEnabled = FUNCTION_TOOL_MAP[state.activeFunction] ?? ALL_DECLARATIONS
    const toolNames = toolsEnabled.map((d) => d.name).join(', ')
    out(
      `\n  ${C.BG_FUNC} FUNCTION ${C.RESET} ${C.GREEN}${C.BOLD}${chosen}${C.RESET} ` +
        `${C.GRAY}(mode: ${state.mode.toUpperCase()})${C.RESET}`
    )
    out(`  ${C.DIM}Enabled Tools (${toolsEnabled.length}): ${toolNames}${C.RESET}`)
  }

  async installPipPackages(): Promise<void> {
    out(`\n  ${C.GRAY}- ${C.CYAN}${C.BOLD}Gemibot .venv Pip Manager${C.RESET}`)
    out(`  ${C.GRAY}- Python Interpreter: ${process.execPath}`)
    out(`  ${C.GRAY}- Packages: ${AppConstants.REQUIRED_PIP_PACKAGES.join(', ')}`)
  }
}
