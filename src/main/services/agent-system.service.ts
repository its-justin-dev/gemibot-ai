import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { machine as osMachine, release as osRelease, version as osVersion } from 'os'
import { join } from 'path'
import type { GenerateContentConfig, Tool } from '@google/genai'
import { AppConstants } from '../../shared/constants/app-constants'
import { buildAgentPrompt } from '../../shared/prompts/system-prompt'
import { DEFAULT_BEHAVIOR_SETTINGS } from '../../shared/types/behavior-settings'
import {
  ALL_DECLARATIONS,
  ALL_READ_DECLARATIONS,
  FUNCTION_TOOL_MAP,
  type SchemaSpec,
  type ToolDecl
} from '../../shared/constants/tool-definitions'
import { EffortLevel } from '../../shared/models/effort-level'
import { clip } from '../../shared/utils/text'
import { pyFormatThousands } from '../../shared/utils/pyformat'
import { pyLen, pySlice } from '../../shared/utils/pystr'
import { strftime } from '../../shared/utils/strftime'
import { readText } from '../utils/fs-text'
import { toFunctionDeclarations } from '../configs/tool-schemas'
import type { AgentState } from '../models/agent-state'
import type { AgentMemory } from './agent-memory.service'
import type { AgentPaths } from './agent-paths.service'
import { stripForPrompt } from './conversation-journal.service'
import {
  estimateTextTokens,
  historySummaryInstruction,
  summaryInstruction
} from './conversation-history.service'
import type { ModelController } from '../controllers/model-controller.service'

export function pyPlatformSystem(): string {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'Darwin'
  if (process.platform === 'linux') return 'Linux'
  return process.platform
}

export function pyPlatformRelease(): string {
  const raw = osRelease()
  if (process.platform !== 'win32') return raw
  const [major, , build] = raw.split('.')
  if (major === '10' && Number(build) >= 22000) return '11'
  if (major === '10') return '10'
  return raw
}

export function pyPlatformVersion(): string {
  return process.platform === 'win32' ? osRelease() : osVersion()
}

export function pyPlatformMachine(): string {
  if (process.platform !== 'win32') return osMachine()
  return process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || ''
}

export function pyOsName(): string {
  return process.platform === 'win32' ? 'nt' : 'posix'
}

const MEMORY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'will', 'your', 'you',
  'are', 'was', 'were', 'but', 'not', 'can', 'all', 'any', 'how', 'what', 'when',
  'where', 'why', 'use', 'using', 'into', 'file', 'files', 'line', 'lines', 'code',
  'add', 'fix', 'update', 'change', 'please', 'make', 'need', 'should', 'about',
  'there', 'their', 'them', 'then', 'than', 'also', 'just', 'like', 'some', 'more',
  'most', 'only', 'over', 'such', 'very', 'want', 'done', 'does', 'each', 'been'
])

function focusWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]{4,}/gu) ?? []
  return new Set(words.filter((word) => !MEMORY_STOP_WORDS.has(word)))
}

function memoryTitle(section: string): string {
  const first = (section.split('\n', 1)[0] ?? '').replace(/^##\s*/u, '').trim()
  return pySlice(first, 0, 72)
}

/**
 * Picks the memory sections that mention the current request, then fills the remaining budget
 * with the newest ones. Output keeps the original order so the journal still reads chronologically,
 * and the omission note names what was left out instead of silently dropping it.
 */
function selectRelevantMemory(text: string, cap: number, focus: string): string {
  const chunks = text.split(/\n(?=## )/u)
  const header = chunks.length > 1 && !chunks[0].startsWith('## ') ? (chunks.shift() ?? '') : ''
  if (chunks.length === 0) {
    const omitted = text.length - cap
    return `[... ${pyFormatThousands(omitted)} older characters omitted ...]\n` + pySlice(text, -cap)
  }

  const words = focusWords(focus)
  const ranked = chunks
    .map((section, index) => {
      const hay = section.toLowerCase()
      let matches = 0
      for (const word of words) if (hay.includes(word)) matches += 1
      return { section, index, matches }
    })
    .sort((a, b) => b.matches - a.matches || b.index - a.index)

  const chosen = new Map<number, string>()
  let used = Math.min(header.length + 220, Math.floor(cap / 3))
  for (const entry of ranked) {
    const remaining = cap - used
    if (remaining < 240) break
    if (entry.section.length <= remaining) {
      chosen.set(entry.index, entry.section)
      used += entry.section.length + 2
      continue
    }
    if (chosen.size === 0) {
      chosen.set(
        entry.index,
        pySlice(entry.section, 0, remaining - 40) + '\n[... section truncated ...]'
      )
      used = cap
      break
    }
  }
  if (chosen.size === 0) {
    const newest = chunks[chunks.length - 1]
    chosen.set(chunks.length - 1, pySlice(newest, 0, Math.max(240, cap - 40)))
  }

  const kept = chunks.filter((_, index) => chosen.has(index))
  const omitted = chunks.length - kept.length
  let note = ''
  if (omitted > 0) {
    const titles = ranked
      .filter((entry) => !chosen.has(entry.index))
      .map((entry) => memoryTitle(entry.section))
      .filter((title) => title !== '')
    const index = titles.length > 0 ? `: ${titles.slice(0, 6).join('; ')}${titles.length > 6 ? '; …' : ''}` : ''
    note = `[... ${omitted} older memory section${omitted === 1 ? '' : 's'} omitted${index} ...]\n`
  }
  const body = chunks
    .map((_, index) => chosen.get(index))
    .filter((section): section is string => section !== undefined)
    .join('\n')
  return [header, note + body].filter((part) => part !== '').join('\n')
}

const SLIM_DESCRIPTION = 160
const SLIM_PARAMETER_DESCRIPTION = 110

/** First sentence (or a word-boundary clip) so the schema still says what the tool is for. */
function shortText(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  if (clean.length <= max) return clean
  const stop = clean.search(/[.!?](?:\s|$)/u)
  if (stop > 20 && stop + 1 <= max) return clean.slice(0, stop + 1)
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function slimDeclaration(declaration: ToolDecl): ToolDecl {
  const properties = declaration.parameters.properties
  const slimmed: ToolDecl = {
    ...declaration,
    description: shortText(declaration.description, SLIM_DESCRIPTION)
  }
  if (properties === undefined) return slimmed
  const nextProperties: Record<string, SchemaSpec> = {}
  for (const [name, property] of Object.entries(properties)) {
    nextProperties[name] =
      property.description === undefined
        ? property
        : { ...property, description: shortText(property.description, SLIM_PARAMETER_DESCRIPTION) }
  }
  return { ...slimmed, parameters: { ...declaration.parameters, properties: nextProperties } }
}

function slimDeclarations(tools: ToolDecl[]): ToolDecl[] {
  return tools.map(slimDeclaration)
}

interface ProjectInfo {
  type: string
  scripts: string[]
}

const PROJECT_MARKERS: [string, string][] = [
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['Cargo.toml', 'Rust'],
  ['go.mod', 'Go'],
  ['composer.json', 'PHP'],
  ['Gemfile', 'Ruby'],
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java/Kotlin'],
  ['build.gradle.kts', 'Java/Kotlin'],
  ['pubspec.yaml', 'Dart/Flutter']
]

const SCRIPT_PRIORITY = [
  'build',
  'typecheck',
  'type-check',
  'lint',
  'test',
  'test:unit',
  'test:e2e',
  'e2e',
  'check'
]

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > 1_000_000) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function packageType(pkg: Record<string, unknown>): string {
  const deps: Record<string, unknown> = {
    ...(typeof pkg.dependencies === 'object' && pkg.dependencies !== null
      ? (pkg.dependencies as Record<string, unknown>)
      : {}),
    ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
      ? (pkg.devDependencies as Record<string, unknown>)
      : {})
  }
  const labels: [string, string][] = [
    ['electron', 'Electron'],
    ['next', 'Next.js'],
    ['react', 'React'],
    ['vue', 'Vue'],
    ['@angular/core', 'Angular'],
    ['svelte', 'Svelte'],
    ['typescript', 'TypeScript']
  ]
  const found = labels.filter(([name]) => name in deps).map(([, label]) => label)
  return found.length > 0 ? found.join(' + ') : 'Node.js'
}

/**
 * A two-line read of the target folder: what kind of project it is and which checks it offers.
 * Both come from files that are already on disk, so the model does not have to spend a tool call
 * discovering the obvious. Unknown folders simply omit the lines.
 */
function projectInfo(root: string): ProjectInfo {
  const pkg = readJsonFile(join(root, 'package.json'))
  let type = pkg !== null ? packageType(pkg) : ''
  if (type === '') {
    for (const [file, label] of PROJECT_MARKERS) {
      if (existsSync(join(root, file))) {
        type = label
        break
      }
    }
  }

  const scripts: string[] = []
  const rawScripts =
    pkg !== null && typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : null
  if (rawScripts !== null) {
    for (const name of SCRIPT_PRIORITY) {
      if (typeof rawScripts[name] === 'string') scripts.push(name)
    }
  }
  return { type, scripts }
}

export interface AgentSystemDeps {
  paths: AgentPaths
  memory: AgentMemory
  modelController(): ModelController | null
}

export class AgentSystem {
  private readonly deps: AgentSystemDeps

  constructor(deps: AgentSystemDeps) {
    this.deps = deps
  }

  tree(root: string, depth = 2, limit = 120): string {
    const lines: string[] = []
    const walk = (directory: string, level: number): void => {
      let entries: { name: string; isFile: boolean; isDir: boolean }[]
      try {
        entries = readdirSync(directory, { withFileTypes: true }).map((entry) => {
          let isFile = false
          let isDir = false
          try {
            const st = statSync(join(directory, entry.name))
            isFile = st.isFile()
            isDir = st.isDirectory()
          } catch {}
          return { name: entry.name, isFile, isDir }
        })
      } catch {
        return
      }
      entries.sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
        const an = a.name.toLowerCase()
        const bn = b.name.toLowerCase()
        return an < bn ? -1 : an > bn ? 1 : 0
      })
      for (const entry of entries) {
        if (AppConstants.IGNORED.has(entry.name)) continue
        if (lines.length >= limit) return
        lines.push(`${'  '.repeat(level)}${entry.name}${entry.isDir ? '/' : ''}`)
        if (entry.isDir && level + 1 < depth) walk(join(directory, entry.name), level + 1)
      }
    }
    walk(root, 0)
    if (lines.length >= limit) lines.push('...')
    return lines.join('\n') || '(empty folder)'
  }

  /**
   * Saving effort is the cheapest the app can be, so it trims what is sent as well as how long
   * the model thinks. Without a controller the caller is on the default effort.
   */
  tokenBudget(): { memoryChars: number; keepEntries: number } {
    const saving = this.isSaving()
    return saving
      ? {
          memoryChars: AppConstants.SAVING_MEMORY_PROMPT_CHARS,
          keepEntries: AppConstants.SAVING_HISTORY_KEEP_ENTRIES
        }
      : {
          memoryChars: AppConstants.MEMORY_PROMPT_CHARS,
          keepEntries: AppConstants.HISTORY_KEEP_ENTRIES
        }
  }

  private isSaving(): boolean {
    return this.deps.modelController()?.currentEffort.equals(EffortLevel.SAVING) ?? false
  }

  /**
   * The memory feed: v1 sends its most recent characters, while the token settings select the
   * sections that match the current request and name what was omitted.
   */
  private memoryView(memText: string, state: AgentState, focusText: string): string {
    const settings = state.tokenSettings ?? null
    const effortCap = this.tokenBudget().memoryChars
    if (settings === null) {
      const omitted = pyLen(memText) - effortCap
      return omitted > 0
        ? `[... ${pyFormatThousands(omitted)} older characters omitted ...]\n` +
            pySlice(memText, -effortCap)
        : memText
    }
    if (this.isSaving()) {
      const omitted = pyLen(memText) - effortCap
      return omitted > 0
        ? `[... ${pyFormatThousands(omitted)} older characters omitted ...]\n` +
            pySlice(memText, -effortCap)
        : memText
    }
    const cap = settings.maxMemoryChars > 0 ? settings.maxMemoryChars : effortCap
    if (pyLen(memText) <= cap) return memText
    if (!settings.memoryRelevance) {
      const omitted = pyLen(memText) - cap
      return `[... ${pyFormatThousands(omitted)} older characters omitted ...]\n` + pySlice(memText, -cap)
    }
    return selectRelevantMemory(memText, cap, focusText)
  }

  /** Project instruction files, newest convention first, sharing one small token budget. */
  private async projectInstructions(root: string): Promise<string[]> {
    const parts: string[] = []
    let budget = 9_000
    for (const name of ['GEMIBOT.md', 'AGENTS.md']) {
      if (budget <= 0) break
      const path = join(root, name)
      try {
        if (!existsSync(path) || !statSync(path).isFile()) continue
        const { text } = await readText(path)
        const chunk = clip(text.trim(), Math.min(6_000, budget))
        if (chunk === '') continue
        parts.push(
          `Project instructions (${name}; follow them unless the current user request says ` +
            `otherwise):\n${chunk}`
        )
        budget -= chunk.length
      } catch {}
    }
    return parts
  }

  async buildSystem(state: AgentState, focusText = ''): Promise<string> {
    const settings = state.tokenSettings ?? null
    const concise = settings !== null
    const behavior = state.behaviorSettings ?? DEFAULT_BEHAVIOR_SETTINGS
    const today = strftime(new Date(), concise ? '%A, %B %d, %Y' : '%A, %B %d, %Y %I:%M %p')
    const info = projectInfo(state.root)
    const parts: string[] = [
      buildAgentPrompt({
        mode: state.mode,
        responseStyle: behavior.responseStyle,
        deepActive: state.deepActive === true,
        complexity: state.taskComplexity ?? null
      })
    ]
    parts.push(
      'Environment:\n' +
        `- Script: Gemibot.py\n` +
        `- Target Directory: ${state.root}\n` +
        `- Application Root: ${state.appRoot}\n` +
        `- Active Mode: ${state.mode}\n` +
        `- Active Function Suite: ${state.activeFunction}\n` +
        (info.type !== '' ? `- Project: ${info.type}\n` : '') +
        (info.scripts.length > 0 ? `- Project scripts: ${info.scripts.join(', ')}\n` : '') +
        `- Memory: conversation database (loaded automatically)\n` +
        `- Operating system: ${pyPlatformSystem()} ${pyPlatformRelease()}\n` +
        `- Shell commands run with: ${pyOsName() === 'nt' ? 'cmd.exe' : 'sh'}\n` +
        (concise ? '' : `- Today: ${today}\n`) +
        `- Runtime: Electron ${process.versions.electron ?? 'unknown'} / Node ${process.versions.node} (${process.execPath})\n\n` +
        `Project files (inside Target Directory):\n${this.tree(state.root)}`
    )
    parts.push(...(await this.projectInstructions(state.root)))
    const memText = stripForPrompt(await this.deps.memory.readMemoryContent())
    state.memoryPromptChars = 0
    if (memText.trim() !== '') {
      const memView = this.memoryView(memText, state, focusText)
      state.memoryPromptChars = memView.length
      parts.push('System Development Progress (from the conversation database):\n' + memView)
    }
    // The daily line changes at most once a day, so it sits after the cacheable blocks and the
    // memory feed rather than near the top of the prompt.
    if (concise) parts.push(`Current date: ${today}`)
    return parts.join('\n\n')
  }

  /**
   * The base prompt plus the persisted compaction summary and the digest of any turns this one
   * request had to leave out. Only the request is affected; the stored transcript keeps everything.
   */
  private systemPrompt(
    state: AgentState,
    overrides?: { historySummary?: string | null; requestDigest?: string | null }
  ): string {
    const summary =
      overrides?.historySummary !== undefined ? overrides.historySummary : state.historySummary
    const digest =
      overrides?.requestDigest !== undefined ? overrides.requestDigest : state.requestDigest
    const parts: string[] = [state.system ?? '']
    if (summary) parts.push(historySummaryInstruction(summary))
    if (digest) parts.push(summaryInstruction(digest))
    return parts.filter((part) => part !== '').join('\n\n')
  }

  private modeTools(state: AgentState): { tools: ToolDecl[]; extraNote: string } {
    const slim = (tools: ToolDecl[]): ToolDecl[] =>
      state.tokenSettings?.slimTools === true ? slimDeclarations(tools) : tools
    if (state.mode === 'plan') {
      return {
        tools: slim(ALL_READ_DECLARATIONS),
        extraNote: '\n\n' + AppConstants.PLAN_NOTE.trim()
      }
    }
    if (state.mode === 'read') {
      return {
        tools: slim(ALL_READ_DECLARATIONS),
        extraNote: '\n\n' + AppConstants.READ_NOTE.trim()
      }
    }
    return {
      tools: slim(FUNCTION_TOOL_MAP[state.activeFunction] ?? ALL_DECLARATIONS),
      extraNote: `\n\nActive Function Suite: ${state.activeFunction}`
    }
  }

  /** Everything in a request that is not conversation history, measured in estimated tokens. */
  requestOverheadTokens(
    state: AgentState,
    model: string,
    overrides?: { historySummary?: string | null; requestDigest?: string | null }
  ): number {
    const system = this.systemPrompt(state, overrides)
    if (AppConstants.isGemma(model)) return estimateTextTokens(system)
    const { tools, extraNote } = this.modeTools(state)
    let chars = system.length + extraNote.length
    try {
      chars += JSON.stringify(toFunctionDeclarations(tools)).length
    } catch {}
    if (AppConstants.isGrounding(model)) chars += 64
    return Math.ceil(chars / 4)
  }

  config(state: AgentState): GenerateContentConfig {
    return this.configFor(state, state.model)
  }

  /**
   * Builds the request for the model that will actually be called, so a ladder fallback gets its
   * own grounding/thinking support instead of inheriting the selected model's configuration.
   */
  configFor(state: AgentState, model: string): GenerateContentConfig {
    const maxOutputTokens = state.tokenSettings?.maxOutputTokens ?? 0
    if (AppConstants.isGemma(model)) {
      return {
        systemInstruction: this.systemPrompt(state),
        automaticFunctionCalling: undefined,
        ...(maxOutputTokens > 0 ? { maxOutputTokens } : {})
      }
    }

    const { tools, extraNote } = this.modeTools(state)

    const toolObjects: Tool[] = [{ functionDeclarations: toFunctionDeclarations(tools) }]
    if (AppConstants.isGrounding(model)) {
      toolObjects.push({ googleSearch: {} })
    }

    const system = `${this.systemPrompt(state)}${extraNote}`
    const thinkingCfg =
      this.deps.modelController()?.getThinkingConfigFor(model, state.effortOverride) ?? null

    return {
      systemInstruction: system,
      tools: toolObjects,
      automaticFunctionCalling: { disable: true },
      thinkingConfig: thinkingCfg ?? undefined,
      ...(maxOutputTokens > 0 ? { maxOutputTokens } : {})
    }
  }

  noToolConfig(state: AgentState): GenerateContentConfig {
    return { systemInstruction: this.systemPrompt(state), automaticFunctionCalling: undefined }
  }

  /**
   * Antigravity agents reject a `systemInstruction` with a 400, so the persona has to travel
   * inside the one user turn the failover is allowed to send.
   */
  singleTurnPrompt(state: AgentState, userPrompt: string): string {
    const system = this.systemPrompt(state).trim()
    if (system === '') return userPrompt
    return `${system}\n\nFollow the instructions above. User request:\n${userPrompt}`
  }
}
