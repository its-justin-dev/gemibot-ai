import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { HELP } from '../../shared/constants/help'
import { EffortLevel } from '../../shared/models/effort-level'
import { FUNCTION_CATALOG } from '../../shared/constants/tool-definitions'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pyLjust, pyLen, pySplitlines, pyStrip } from '../../shared/utils/pystr'
import {
  MAX_BEHAVIOR_STEPS,
  MIN_BEHAVIOR_STEPS,
  RESPONSE_STYLES,
  stepsValue
} from '../../shared/utils/behavior-settings'
import { TOKEN_COMMAND_USAGE } from '../../shared/utils/token-settings'
import type { ChooseItem } from './agent-session.service'
import type { CatalogClient, CatalogItem } from './model-catalog.service'
import { out } from '../utils/console-out'
import type { Agent } from './agent.service'
import { tokenUsageRepository } from './token-usage.service'
import { getDbPath } from './database.service'

const NUM_MAP = new Map<string, string>([
  ['1', 'model'],
  ['2', 'function'],
  ['3', 'build'],
  ['4', 'plan'],
  ['5', 'read'],
  ['6', 'todos'],
  ['7', 'undo'],
  ['8', 'revert'],
  ['9', 'memory'],
  ['10', 'pip'],
  ['11', 'clear'],
  ['12', 'usage'],
  ['13', 'help'],
  ['14', 'exit']
])

const FUNCTION_CODES = new Set(FUNCTION_CATALOG.map(([code]) => code))

function pyCount(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function onOffArg(value: string): boolean | null {
  const clean = value.trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(clean)) return true
  if (['off', 'false', '0', 'no'].includes(clean)) return false
  return null
}

export class AgentCli {
  constructor(private readonly agent: Agent) {}

  async showSettingsStatus(): Promise<void> {
    const agent = this.agent
    await agent.settings.ensureSettings(agent.preferences())
    const settings = await agent.settings.readSettingsDict()
    const storage = agent.settings.storageInfo()
    out(`\n  ${C.GRAY}- ${C.CYAN}${C.BOLD}User Settings & Preferences${C.RESET}`)
    out(`  ${C.GRAY}- Database:        ${getDbPath()}`)
    out(`  ${C.GRAY}- Scope:           ${storage.scope}`)
    const behavior = agent.behaviorConfig()
    out(
      `  ${C.GRAY}- Behavior:        ${behavior.responseStyle} style · deep mode ` +
        `${behavior.deepMode ? 'on' : 'off'} · ${behavior.maxSteps} steps · streaming ` +
        `${behavior.streamResponses ? 'on' : 'off'}`
    )
    for (const [k, v] of Object.entries(settings)) {
      out(`  ${C.GRAY}- ${pyLjust(k, 16)} ${C.WHITE}${v}${C.RESET}`)
    }
    out(`  ${C.GRAY}-`)
  }

  async showMemoryStatus(): Promise<void> {
    const agent = this.agent
    await agent.memory.ensureMemory()
    const text = await agent.memory.readMemoryContent()
    const storage = await agent.memory.storageInfo()
    const entries = pyCount(text, '## Interaction Log -')
    out(`\n  ${C.GRAY}- ${C.MAGENTA}${C.BOLD}Memory Status${C.RESET}`)
    out(`  ${C.GRAY}- Database: ${getDbPath()}`)
    out(`  ${C.GRAY}- Key:      ${storage.key}`)
    out(`  ${C.GRAY}- Entries: ${entries} interaction(s)`)
    out(
      `  ${C.GRAY}- Size:    ${pyFormatThousands(pyLen(text))} characters ` +
        `(${pyFormatThousands(pySplitlines(text).length)} lines)`
    )
    out(`  ${C.GRAY}-`)
  }

  showTokenStatus(): void {
    const agent = this.agent
    const settings = agent.tokenConfig()
    const compaction = agent.compactionConfig()
    const summary = tokenUsageRepository.summary(null, 5)
    const onOff = (value: boolean): string => (value ? 'on' : 'off')
    const count = (value: number): string => pyFormatThousands(value)
    out(`\n  ${C.CYAN}${C.BOLD}Token Usage & Limits${C.RESET}`)
    if (summary.requests === 0) {
      out(`  ${C.GRAY}- No model requests logged yet.${C.RESET}`)
    } else {
      const estimated =
        summary.estimatedRequests > 0
          ? ` (${count(summary.estimatedRequests)} estimated)`
          : ''
      out(`  ${C.GRAY}- Requests: ${count(summary.requests)}${estimated}`)
      out(`  ${C.GRAY}- Input:    ${count(summary.inputTokens)} tokens`)
      out(`  ${C.GRAY}- Output:   ${count(summary.outputTokens)} tokens`)
      out(`  ${C.GRAY}- Cached:   ${count(summary.cachedTokens)} tokens`)
      out(`  ${C.GRAY}- Total:    ${count(summary.totalTokens)} tokens`)
      for (const group of summary.byModel.slice(0, 5)) {
        out(
          `  ${C.GRAY}- ${pyLjust(group.key || 'unknown', 28)} ` +
            `${count(group.requests)} req · ${count(group.inputTokens)} in / ` +
            `${count(group.outputTokens)} out`
        )
      }
      for (const row of summary.biggest) {
        out(
          `  ${C.GRAY}- ${pyLjust((row.label || row.kind).slice(0, 28), 28)} ` +
            `${row.model} · ${count(row.inputTokens)} in / ${count(row.outputTokens)} out`
        )
      }
    }
    out(
      `  ${C.GRAY}- Memory:   ${
        settings.maxMemoryChars === 0
          ? 'no app cap'
          : `${count(settings.maxMemoryChars)} chars`
      } · relevance ${onOff(settings.memoryRelevance)}`
    )
    out(
      `  ${C.GRAY}- Tools:    ${
        settings.maxToolOutputChars === 0
          ? 'no app cap'
          : `${count(settings.maxToolOutputChars)} chars`
      } · slim schemas ${onOff(settings.slimTools)} · reuse reads ${onOff(settings.reuseReadResults)}`
    )
    out(
      `  ${C.GRAY}- Loop guard: ${onOff(settings.loopGuard)} · output limit: ${
        settings.maxOutputTokens === 0
          ? 'provider default'
          : `${count(settings.maxOutputTokens)} tokens`
      }`
    )
    out(`  ${C.GRAY}- Small-job model: ${settings.cheapModel}`)
    out(
      `  ${C.GRAY}- Compaction: ${compaction.enabled ? 'auto' : 'manual'} at ` +
        `${compaction.thresholdPercent}% -> ${compaction.targetPercent}% · ` +
        `summarizer ${compaction.summarizerModel}`
    )
    out(`  ${C.DIM}Set with: ${TOKEN_COMMAND_USAGE}${C.RESET}`)
    out(`  ${C.GRAY}-`)
  }

  availableModels(): CatalogItem[] {
    const agent = this.agent
    if (agent.modelController) {
      void agent.modelController.catalog.refreshAsync(
        agent.client.client as unknown as CatalogClient | null
      )
      return agent.modelController.catalog.getModels()
    }
    return AppConstants.MODELS.map((model) => [
      model,
      (AppConstants.MODEL_CATALOG as Record<string, string>)[model] ?? model
    ])
  }

  async pickModel(): Promise<void> {
    const agent = this.agent
    const items = this.availableModels()
    const chosen = await agent.choose('Select a Gemini Model', items, { current: agent.model })
    if (chosen) {
      agent.model = chosen
      agent.state.pinned = true
      if (agent.modelController) await agent.modelController.selectModel(chosen)
      await agent.saveSettings({ model: chosen })
      out(`  ${C.GREEN}- Model set to ${chosen}${C.RESET}`)
    } else {
      out(`  ${C.DIM}Cancelled. Active model: ${agent.model}${C.RESET}`)
    }
  }

  async pickEffort(arg = ''): Promise<void> {
    const agent = this.agent
    if (arg) {
      const level = EffortLevel.fromString(arg)
      agent.effortLevel = level
      if (agent.modelController) await agent.modelController.selectEffortLevel(level)
      out(
        `  ${C.GREEN}- Reasoning effort set to ${level.icon} ${level.displayName} ` +
          `(${level.costHint})${C.RESET}`
      )
      return
    }

    const levels: ChooseItem[] = EffortLevel.allLevels().map((level) => [
      level.value,
      `${level.icon} ${pyLjust(level.displayName, 11)} - ${level.costHint}`
    ])
    const chosen = await agent.choose('Select AI Reasoning Effort Level', levels, {
      current: agent.effortLevel.value
    })
    if (chosen) {
      const level = EffortLevel.fromString(chosen)
      agent.effortLevel = level
      if (agent.modelController) await agent.modelController.selectEffortLevel(level)
      out(
        `  ${C.GREEN}- Reasoning effort set to ${level.icon} ${level.displayName} ` +
          `(${level.costHint})${C.RESET}`
      )
    } else {
      out(`  ${C.DIM}Cancelled. Active effort: ${agent.effortLevel.displayName}${C.RESET}`)
    }
  }

  private async runCompactionCommand(): Promise<void> {
    const result = await this.agent.compactNow('manual')
    if (result === null) {
      out(
        `  ${C.GRAY}Nothing older to compact yet. The latest request is always kept in full.${C.RESET}`
      )
      return
    }
    if (result.status === 'success') {
      out(
        `  ${C.GREEN}- Compacted ${result.messagesSummarized} messages into a summary ` +
          `(${result.beforePercent}% -> ${result.afterPercent}% of context).${C.RESET}`
      )
    } else {
      out(`  ${C.RED}- Compaction failed: ${result.error ?? 'unknown error'}${C.RESET}`)
      out(`  ${C.GRAY}The original history is untouched and is still being sent in full.${C.RESET}`)
    }
  }

  private async compactionSettings(arg: string): Promise<void> {
    const agent = this.agent
    const current = agent.compactionConfig()
    const usage = agent.contextUsage()
    const fields = arg.split(/\s+/).filter((part) => part !== '')

    if (fields.length === 0) {
      out(`\n  ${C.CYAN}${C.BOLD}Conversation Compaction${C.RESET}`)
      out(`  ${C.GRAY}- Auto compact:    ${current.enabled ? 'on' : 'off'}`)
      out(`  ${C.GRAY}- Threshold:       ${current.thresholdPercent}% of the request budget`)
      out(`  ${C.GRAY}- Target:          ${current.targetPercent}% after compaction`)
      out(`  ${C.GRAY}- Recent messages: ${current.recentMessages} user turns kept verbatim`)
      out(`  ${C.GRAY}- Summarizer:      ${current.summarizerModel}`)
      out(
        `  ${C.GRAY}- Context now:     ${usage.percent}% of ${pyFormatThousands(usage.budgetTokens)} tokens`
      )
      out(
        `  ${C.DIM}Set with: /compaction on|off | threshold <50-95> | target <10-80> | ` +
          `recent <2-50> | model <model-id>${C.RESET}`
      )
      out(`  ${C.GRAY}-`)
      return
    }

    const key = fields[0].toLowerCase()
    const value = fields.slice(1).join(' ').trim()
    if (key === 'on' || key === 'off') {
      await agent.updateCompactionSettings({ enabled: key === 'on' })
      out(`  ${C.GREEN}- Auto compaction ${key === 'on' ? 'enabled' : 'disabled'}.${C.RESET}`)
      return
    }
    if (key === 'threshold' || key === 'target' || key === 'recent') {
      const number = Number(value)
      if (!Number.isFinite(number)) {
        out(`  ${C.RED}- /compaction ${key} needs a number.${C.RESET}`)
        return
      }
      if (key === 'threshold') await agent.updateCompactionSettings({ thresholdPercent: number })
      else if (key === 'target') await agent.updateCompactionSettings({ targetPercent: number })
      else await agent.updateCompactionSettings({ recentMessages: number })
      const saved = agent.compactionConfig()
      const applied =
        key === 'threshold'
          ? `${saved.thresholdPercent}%`
          : key === 'target'
            ? `${saved.targetPercent}%`
            : `${saved.recentMessages} turns`
      out(`  ${C.GREEN}- Compaction ${key} set to ${applied}.${C.RESET}`)
      return
    }
    if (key === 'model' || key === 'summarizer') {
      if (!value) {
        out(`  ${C.RED}- /compaction model needs a model id.${C.RESET}`)
        return
      }
      await agent.updateCompactionSettings({ summarizerModel: value })
      out(`  ${C.GREEN}- Compaction summarizer set to ${agent.compactionConfig().summarizerModel}.${C.RESET}`)
      return
    }
    out(
      `  ${C.DIM}Unknown compaction setting '${key}'. Use on|off, threshold, target, recent or model.${C.RESET}`
    )
  }

  private async behaviorSettingsCommand(name: string, arg: string): Promise<void> {
    const agent = this.agent
    const current = agent.behaviorConfig()
    const report = (): void => {
      out(`\n  ${C.CYAN}${C.BOLD}Agent Behavior${C.RESET}`)
      out(`  ${C.GRAY}- Response style: ${current.responseStyle} (concise | balanced | thorough)`)
      out(`  ${C.GRAY}- Deep mode:      ${current.deepMode ? 'on' : 'off'}`)
      out(`  ${C.GRAY}- Max steps:      ${current.maxSteps} (${MIN_BEHAVIOR_STEPS}-${MAX_BEHAVIOR_STEPS})`)
      out(
        `  ${C.GRAY}- Streaming:      ${current.streamResponses ? 'on' : 'off'}` +
          (agent.state.streamingAllowed ? '' : ' (this surface does not render live deltas)')
      )
      out(
        `  ${C.DIM}Set with: /style concise|balanced|thorough · /deep on|off · ` +
          `/steps <${MIN_BEHAVIOR_STEPS}-${MAX_BEHAVIOR_STEPS}> · /stream on|off${C.RESET}`
      )
      out(`  ${C.GRAY}-`)
    }
    if (arg === '') {
      report()
      return
    }
    if (name === 'style') {
      const value = RESPONSE_STYLES.find((style) => style === arg.toLowerCase())
      if (value === undefined) {
        out(`  ${C.RED}- /style needs concise, balanced or thorough.${C.RESET}`)
        return
      }
      const next = await agent.updateBehaviorSettings({ responseStyle: value })
      out(`  ${C.GREEN}- Response style set to ${next.responseStyle}.${C.RESET}`)
      return
    }
    if (name === 'deep' || name === 'stream') {
      const on = onOffArg(arg)
      if (on === null) {
        out(`  ${C.RED}- /${name} needs on or off.${C.RESET}`)
        return
      }
      const next =
        name === 'deep'
          ? await agent.updateBehaviorSettings({ deepMode: on })
          : await agent.updateBehaviorSettings({ streamResponses: on })
      const label = name === 'deep' ? 'Deep mode' : 'Live streaming'
      const value = name === 'deep' ? next.deepMode : next.streamResponses
      out(`  ${C.GREEN}- ${label} ${value ? 'enabled' : 'disabled'}.${C.RESET}`)
      return
    }
    const number = Number(arg)
    if (!Number.isFinite(number)) {
      out(`  ${C.RED}- /steps needs a number.${C.RESET}`)
      return
    }
    const next = await agent.updateBehaviorSettings({ maxSteps: stepsValue(number) })
    out(`  ${C.GREEN}- Max steps per task set to ${next.maxSteps}.${C.RESET}`)
  }

  async executeSingleCommand(rawCmd: string): Promise<'exit' | null> {
    const agent = this.agent
    let raw = pyStrip(rawCmd)
    if (raw.startsWith('/')) raw = pyStrip(raw.slice(1))
    const space = raw.indexOf(' ')
    const name = pyStrip(space === -1 ? raw : raw.slice(0, space)).toLowerCase()
    const arg = space === -1 ? '' : pyStrip(raw.slice(space + 1))
    const resolved = NUM_MAP.get(name) ?? name

    if (await this.agent.changesController.handleCliCommand(resolved)) return null
    if (resolved === 'exit' || resolved === 'quit' || resolved === 'q') return 'exit'

    if (resolved === 'help') {
      out(HELP)
    } else if (resolved === 'function' || resolved === 'functions' || resolved === 'fn') {
      if (arg && FUNCTION_CODES.has(arg)) {
        agent.state.activeFunction = arg
        if (arg === 'build' || arg === 'plan' || arg === 'read') agent.state.mode = arg
        else agent.state.mode = 'build'
        agent.state.system = await agent.buildSystem()
        await agent.saveSettings({
          function_suite: agent.state.activeFunction,
          mode: agent.state.mode
        })
        out(`  ${C.BG_FUNC} FUNCTION ${C.RESET} ${C.GREEN}Activated ${arg}${C.RESET}`)
      } else {
        await agent.pickFunction()
      }
    } else if (resolved === 'plan') {
      agent.state.mode = 'plan'
      agent.state.activeFunction = 'plan'
      await agent.saveSettings({ function_suite: 'plan', mode: 'plan' })
      out(
        `  ${C.BG_PLAN} PLAN ${C.RESET} ${C.YELLOW}Read-only mode active. ` +
          `Edits and shell commands disabled.${C.RESET}`
      )
    } else if (resolved === 'read') {
      agent.state.mode = 'read'
      agent.state.activeFunction = 'read'
      await agent.saveSettings({ function_suite: 'read', mode: 'read' })
      out(
        `  ${C.BG_READ} READ ${C.RESET} ${C.CYAN}Strict read & media inspection mode active.${C.RESET}`
      )
    } else if (resolved === 'build') {
      agent.state.mode = 'build'
      agent.state.activeFunction = 'all'
      await agent.saveSettings({ function_suite: 'all', mode: 'build' })
      out(`  ${C.BG_BUILD} BUILD ${C.RESET} ${C.GREEN}Full agent access active.${C.RESET}`)
    } else if (resolved === 'pip') {
      await agent.turnEngine.installPipPackages()
    } else if (resolved === 'undo') {
      await agent.undo()
    } else if (resolved === 'revert') {
      await agent.revert()
    } else if (resolved === 'target' || resolved === 'target_dir' || resolved === 'targetdir') {
      if (!arg) {
        out(`\n  ${C.CYAN}${C.BOLD}Current Target Directory:${C.RESET} ${agent.state.root}`)
        if (agent.state.root === agent.state.appRoot) {
          out(
            `  ${C.GRAY}(Using default application folder. Use /target <path> to change)${C.RESET}\n`
          )
        } else {
          out(
            `  ${C.GRAY}(All file tools & commands are strictly locked inside this folder)${C.RESET}\n`
          )
        }
      } else {
        const [ok, msg] = await agent.setTargetDirectory(arg)
        if (ok) out(`\n  ${C.GREEN}${C.BOLD}- Success:${C.RESET} ${msg}\n`)
        else out(`\n  ${C.RED}${C.BOLD}- Error:${C.RESET} ${msg}\n`)
      }
    } else if (resolved === 'settings') {
      await this.showSettingsStatus()
    } else if (resolved === 'memory') {
      await this.showMemoryStatus()
    } else if (resolved === 'clear') {
      agent.state.contents = []
      agent.state.todos = []
      agent.state.checkpoints = []
      agent.state.undoStack = []
      const cleared = await agent.clearMemory()
      agent.state.system = await agent.buildSystem()
      out(
        cleared
          ? `  ${C.GRAY}Active chat and conversation memory cleared.${C.RESET}`
          : `  ${C.YELLOW}Active chat cleared, but app memory could not be saved.${C.RESET}`
      )
    } else if (resolved === 'init') {
      agent.state.mode = 'build'
      await agent.turn(
        'Analyze this project and create or update AGENTS.md in the project root. ' +
          'Include: what the project does, how to install, run, build and test it, the folder ' +
          'structure, code style and conventions, and anything important to avoid. ' +
          'Keep it under 80 lines and base it only on files you actually read.'
      )
      agent.state.system = await agent.buildSystem()
    } else if (resolved === 'model' || resolved === 'models') {
      if (arg) {
        agent.model = arg
        agent.state.pinned = true
        if (agent.modelController) await agent.modelController.selectModel(arg)
        out(`  ${C.GREEN}Model set to ${arg}${C.RESET}`)
      } else {
        await this.pickModel()
      }
    } else if (resolved === 'effort' || resolved === 'thinking' || resolved === 'reasoning') {
      await this.pickEffort(arg)
    } else if (resolved === 'todos' || resolved === 'totos') {
      agent.tools.printTodos()
    } else if (resolved === 'compact') {
      await this.runCompactionCommand()
    } else if (resolved === 'compaction') {
      await this.compactionSettings(arg)
    } else if (resolved === 'usage') {
      const total = agent.tokensIn + agent.tokensOut
      out(
        `  ${C.GRAY}Tokens:${C.RESET} ${pyFormatThousands(agent.tokensIn)} in * ` +
          `${pyFormatThousands(agent.tokensOut)} out * ${pyFormatThousands(total)} total`
      )
    } else if (resolved === 'token' || resolved === 'tokens') {
      const outcome = await agent.runTokenCommand(arg)
      if (outcome.kind === 'view') this.showTokenStatus()
      else if (outcome.kind === 'error') out(`  ${C.RED}- ${outcome.message}${C.RESET}`)
      else out(`  ${C.GREEN}- ${outcome.message}${C.RESET}`)
    } else if (resolved === 'style' || resolved === 'response') {
      await this.behaviorSettingsCommand('style', arg)
    } else if (resolved === 'deep') {
      await this.behaviorSettingsCommand('deep', arg)
    } else if (resolved === 'steps') {
      await this.behaviorSettingsCommand('steps', arg)
    } else if (resolved === 'stream') {
      await this.behaviorSettingsCommand('stream', arg)
    } else {
      out(`  ${C.DIM}Unknown command '${raw}'. Type /help or enter a number (1-14).${C.RESET}`)
    }
    return null
  }

  async command(line: string): Promise<'exit' | null> {
    const rawLine = pyStrip(line)
    if (rawLine.includes('+')) {
      for (const part of rawLine.split('+')) {
        const trimmed = pyStrip(part)
        if (!trimmed) continue
        const res = await this.executeSingleCommand(trimmed)
        if (res === 'exit') return 'exit'
      }
      return null
    }
    return await this.executeSingleCommand(rawLine)
  }
}
