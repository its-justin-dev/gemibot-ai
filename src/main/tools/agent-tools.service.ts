import { readFile } from 'fs/promises'
import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import { WRITE_NAMES } from '../../shared/constants/tool-definitions'
import { ChangeType } from '../../shared/models/file-change'
import { KeyboardInterrupt, ToolError, errorMessage } from '../../shared/utils/exceptions'
import { pyRound } from '../../shared/utils/pyformat'
import { pyStr, pyTypeName } from '../../shared/utils/pystr'
import { pyTime } from '../../shared/utils/pytime'
import { makeUnifiedDiff } from '../../shared/utils/difflib'
import type { TurnFileChange } from '../../shared/utils/memory-entry'
import { clip } from '../../shared/utils/text'
import { nowStrftime } from '../../shared/utils/strftime'
import { out, outRaw, printDiff } from '../utils/console-out'
import { pyResolve } from '../utils/fs-path'
import type { AgentState, TimelineEvent } from '../models/agent-state'
import type { AgentGenerate } from '../services/agent-generate.service'
import type { AgentPaths } from '../services/agent-paths.service'
import type { AgentSystem } from '../services/agent-system.service'
import type { AiClient } from '../services/ai-client.service'
import type { ChangeTracker } from '../services/change-tracker.service'
import type { FileOperations } from '../services/file-operations.service'
import { bindArgs, type ToolContext, type ToolSpec } from './tool-contract'
import { FILE_TOOLS } from './file-tools'
import { DATA_TOOLS } from './data-tools'
import { IMAGE_TOOLS } from './image-tools'
import { WEB_TOOLS } from './web-tools'
import { DOCX_TOOLS } from './doc-tools'
import { EXCEL_TOOLS } from './sheet-tools'
import { PDF_TOOLS } from './pdf-tools'
import { PPTX_TOOLS } from './pptx-tools'
import { VOICE_TOOLS } from './voice-tools'
import { VIDEO_TOOLS } from './video-tools'
import { ARCHIVE_TOOLS } from './archive-tools'
import { SYSTEM_TOOLS } from './system-tools'

export interface AgentToolsDeps {
  state: AgentState
  paths: AgentPaths
  system: AgentSystem
  generate: AgentGenerate
  client: AiClient
  fileOps: FileOperations
  changeTracker: ChangeTracker
  readLine?: (prompt: string) => Promise<string | null>
}

const TOOLS: Record<string, ToolSpec> = {
  ...FILE_TOOLS,
  ...WEB_TOOLS,
  ...IMAGE_TOOLS,
  ...DOCX_TOOLS,
  ...EXCEL_TOOLS,
  ...PDF_TOOLS,
  ...PPTX_TOOLS,
  ...VOICE_TOOLS,
  ...VIDEO_TOOLS,
  ...DATA_TOOLS,
  ...ARCHIVE_TOOLS,
  ...SYSTEM_TOOLS
}

function errTypeName(error: unknown): string {
  if (error instanceof Error) return error.name
  return pyTypeName(error)
}

/** Identical repeats of these can point at the earlier output instead of running again. */
const READ_REUSE_NAMES = new Set(['read_file', 'list_files', 'glob_files', 'grep_files'])

/** A command may rewrite files, so caches cannot survive it even though it is not a write tool. */
function mutatesFiles(name: string): boolean {
  return WRITE_NAMES.has(name) || name === 'run_command'
}

/** Key-order-independent identity for "the model asked for the exact same thing again". */
function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((field) => `${JSON.stringify(field)}:${canonicalValue(record[field])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}\u0000${canonicalValue(args)}`
}

export class AgentTools {
  readonly ctx: ToolContext
  private readonly specs: Map<string, ToolSpec> = new Map()
  private readonly readLine: (prompt: string) => Promise<string | null>
  /** Caches are per caller (main agent or one sub-agent) and die when the parent turn changes. */
  private readonly callCaches = new Map<
    string,
    { loops: Map<string, number>; reads: Map<string, number> }
  >()
  private cacheSerial = -1

  constructor(deps: AgentToolsDeps) {
    this.readLine = deps.readLine ?? (async () => null)
    for (const [name, spec] of Object.entries(TOOLS)) this.specs.set(name, spec)
    this.ctx = {
      ...deps,
      allowed: (tool, detail) => this.allowed(tool, detail),
      commit: (tool, full, rel, oldText, newText, crlf, what, why) =>
        this.commit(tool, full, rel, oldText, newText, crlf, what, why),
      beginBinaryArtifact: (full) => this.beginBinaryArtifact(full),
      recordBinaryArtifact: (full, actionLabel, summaryNote, what, why) =>
        this.recordBinaryArtifact(full, actionLabel, summaryNote, what, why),
      checkCommandPaths: (command) => this.checkCommandPaths(command),
      printTodos: () => this.printTodos()
    }
  }

  toolNames(): string[] {
    return [...this.specs.keys()].sort()
  }

  private callCache(scope: string): {
    loops: Map<string, number>
    reads: Map<string, number>
  } {
    const serial = this.ctx.state.toolTurnSerial
    if (serial !== this.cacheSerial) {
      this.cacheSerial = serial
      this.callCaches.clear()
    }
    let cache = this.callCaches.get(scope)
    if (cache === undefined) {
      cache = { loops: new Map(), reads: new Map() }
      this.callCaches.set(scope, cache)
    }
    return cache
  }

  /** A successful file-changing call makes every earlier read stale; keep only its own count. */
  private afterMutation(
    cache: { loops: Map<string, number>; reads: Map<string, number> },
    key: string
  ): void {
    // Parallel sub-agents share the filesystem, so one agent's write invalidates every scope.
    for (const other of this.callCaches.values()) other.reads.clear()
    for (const other of [...cache.loops.keys()]) {
      if (other !== key) cache.loops.delete(other)
    }
  }

  private emit(
    name: string,
    args: Record<string, unknown>,
    output: string,
    isError: boolean,
    status: string,
    duration: number | null,
    fileChanges: TurnFileChange[]
  ): void {
    const state = this.ctx.state
    const ev: TimelineEvent = {
      type: 'action',
      tool: name,
      args,
      output,
      is_error: isError,
      status,
      ...(duration === null ? {} : { duration }),
      timestamp: nowStrftime('%H:%M:%S'),
      file_changes: fileChanges
    }
    state.turnTimelineEvents.push(ev)
    state.journal?.recordEvent(ev)
    if (typeof state.onTimelineEvent === 'function') {
      try {
        state.onTimelineEvent(ev)
      } catch {}
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const state = this.ctx.state
    // A model turn is the only place where a repeated call means the same thing twice; direct
    // callers (tests, CLI helpers) keep the v1 path exactly.
    const scope = state.toolTurnSerial > 0 ? state.usageSender || 'main' : null
    return await this.run(name, args, state, scope)
  }

  /** Sub-agents share this instance but keep their own cache and their own history length. */
  async executeFor(
    scope: string,
    history: AgentState,
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return await this.run(name, args, history, scope)
  }

  private async run(
    name: string,
    args: Record<string, unknown>,
    history: AgentState,
    scope: string | null
  ): Promise<Record<string, unknown>> {
    const state = this.ctx.state
    const t0 = pyTime()
    const fileChgBefore = state.turnFileChanges.length

    if ((state.mode === 'plan' || state.mode === 'read') && WRITE_NAMES.has(name)) {
      const errMsg =
        `Tool '${name}' is disabled in ${state.mode.toUpperCase()} mode. ` +
        'Switch to /build or /function.'
      state.turnToolLogs.push({ tool: name, args, raw_output: errMsg, is_error: true })
      this.emit(name, args, errMsg, true, 'Failed', null, [])
      return { error: errMsg }
    }

    const spec = this.specs.get(name)
    if (!spec) {
      const errMsg = `Unknown tool: ${name}`
      state.turnToolLogs.push({ tool: name, args, raw_output: errMsg, is_error: true })
      this.emit(name, args, errMsg, true, 'Failed', null, [])
      return { error: errMsg }
    }

    const settings = state.tokenSettings ?? null
    const cache = scope === null ? null : this.callCache(scope)
    const key = callKey(name, args)

    if (cache !== null && settings !== null && settings.reuseReadResults && READ_REUSE_NAMES.has(name)) {
      const at = cache.reads.get(key)
      if (at !== undefined && history.contents.length - at <= AppConstants.HISTORY_KEEP_ENTRIES) {
        // The first repeat is answered from the earlier result; the next one is a loop that
        // should stop even though no tool work happens.
        if (settings.loopGuard) {
          const seen = (cache.loops.get(key) ?? 1) + 1
          cache.loops.set(key, seen)
          if (seen >= 3) {
            const errMsg =
              `Blocked a repeated ${name} call: the same arguments were asked for ${seen} ` +
              'times this turn. Its result is already in the conversation above.'
            state.turnToolLogs.push({ tool: name, args, raw_output: errMsg, is_error: true })
            this.emit(name, args, errMsg, true, 'Blocked', 0, [])
            return { error: errMsg }
          }
        }
        const note =
          `Reused the identical ${name} result from earlier in this turn; it is still in the ` +
          'conversation above and nothing changed, so the tool did not run again.'
        state.turnToolLogs.push({ tool: name, args, raw_output: note, is_error: false, duration: 0 })
        this.emit(name, args, note, false, 'Reused', 0, [])
        return { output: note }
      }
    }

    if (cache !== null && settings !== null && settings.loopGuard) {
      const seen = cache.loops.get(key) ?? 0
      if (seen >= 2) {
        const errMsg =
          `Blocked a repeated ${name} call: the exact same arguments already ran ${seen} times ` +
          'this turn. Use the earlier result, or change the arguments and try again.'
        state.turnToolLogs.push({ tool: name, args, raw_output: errMsg, is_error: true })
        this.emit(name, args, errMsg, true, 'Blocked', 0, [])
        return { error: errMsg }
      }
      cache.loops.set(key, seen + 1)
    }

    try {
      const rawOut = pyStr(await spec.run(this.ctx, bindArgs(spec, args)))
      const dur = pyRound(pyTime() - t0, 3)
      const exitMatch = name === 'run_command' ? /^exit code (-?\d+)/u.exec(rawOut) : null
      const failedExit = exitMatch !== null && Number(exitMatch[1]) !== 0
      const newChgs = state.turnFileChanges.slice(fileChgBefore).map((c) => ({ ...c }))
      state.turnToolLogs.push({
        tool: name,
        args,
        raw_output: rawOut,
        is_error: failedExit,
        duration: dur
      })
      this.emit(name, args, rawOut, failedExit, failedExit ? 'Failed' : 'Success', dur, newChgs)
      if (cache !== null && READ_REUSE_NAMES.has(name)) cache.reads.set(key, history.contents.length)
      if (cache !== null && mutatesFiles(name)) this.afterMutation(cache, key)
      return { output: clip(rawOut) }
    } catch (e) {
      if (e instanceof KeyboardInterrupt) throw e

      if (e instanceof ToolError) {
        const errMsg = errorMessage(e)
        const dur = pyRound(pyTime() - t0, 3)
        const newChgs = state.turnFileChanges.slice(fileChgBefore).map((c) => ({ ...c }))
        const statusVal = errMsg.toLowerCase().includes('denied') ? 'Denied' : 'Failed'
        state.turnToolLogs.push({
          tool: name,
          args,
          raw_output: errMsg,
          is_error: true,
          duration: dur
        })
        this.emit(name, args, errMsg, true, statusVal, dur, newChgs)
        return { error: errMsg }
      }

      const raw = errorMessage(e)
      const errMsg =
        e instanceof Error && e.name === 'TypeError'
          ? `Bad arguments: ${raw}`
          : `${errTypeName(e)}: ${raw}`
      const dur = pyRound(pyTime() - t0, 3)
      state.turnToolLogs.push({
        tool: name,
        args,
        raw_output: errMsg,
        is_error: true,
        duration: dur
      })
      this.emit(name, args, errMsg, true, 'Failed', dur, [])
      return { error: errMsg }
    }
  }

  async allowed(tool: string, detail: string): Promise<boolean> {
    const state = this.ctx.state
    if (state.autoYes || state.always.has(tool)) return true
    if (state.autoApproveEdits && (tool === 'edit_file' || tool === 'write_file')) return true

    if (typeof state.onPermission === 'function') {
      try {
        const res = await state.onPermission(tool, detail)
        const trusted = res === 'always' || res === 'a'
        const ok = trusted || Boolean(res)
        if (trusted) state.always.add(tool)
        state.journal?.record(
          `Permission ${ok ? 'Accepted' : 'Rejected'}`,
          `${tool}: ${detail}${trusted ? ' (always)' : ''}`
        )
        return ok
      } catch {}
    }

    const mon = state.escMonitor
    if (mon) mon.pause()
    try {
      out(
        `\n  ${C.YELLOW}- Permission Required${C.RESET} [${C.BOLD}${tool}${C.RESET}] ` +
          `${C.DIM}${detail}${C.RESET}`
      )
      const prompt = `  ${C.YELLOW}- Allow? [y]es / [a]lways / [n]o - ${C.RESET}`
      for (;;) {
        outRaw(prompt)
        const answer = await this.readLine(prompt)
        if (answer === null) return false
        const clean = answer.trim().toLowerCase()
        if (clean === 'y' || clean === 'yes') return true
        if (clean === 'a' || clean === 'always') {
          state.always.add(tool)
          return true
        }
        if (clean === 'n' || clean === 'no' || clean === '') return false
      }
    } finally {
      if (mon) mon.resume()
    }
  }

  async commit(
    tool: string,
    full: string,
    rel: string,
    oldText: string | null,
    newText: string,
    crlf: boolean,
    what = '',
    why = ''
  ): Promise<string> {
    const { state, fileOps } = this.ctx
    printDiff(rel, oldText || '', newText, oldText === null)
    if (!(await this.allowed(tool, rel))) {
      throw new ToolError(
        'The user denied this change. Do not retry it; ask what they want instead.'
      )
    }
    state.undoStack.push([full, oldText, crlf])
    const diffStr = makeUnifiedDiff(rel, oldText || '', newText).join('\n')
    const ctype = oldText === null ? ChangeType.ADDED : ChangeType.MODIFIED
    await fileOps.writeTextFile(full, newText, crlf, ctype, diffStr, what, why)
    state.turnFileChanges.push({
      action: oldText === null ? 'created' : 'modified',
      path: rel,
      diff: diffStr,
      old_content: oldText,
      new_content: newText
    })
    return `${oldText === null ? 'Created' : 'Updated'} ${rel}`
  }

  async beginBinaryArtifact(fullPath: string): Promise<void> {
    const state = this.ctx.state
    const rel = this.ctx.paths.rel(fullPath)
    const oldBytes = await readFile(fullPath).catch(() => null)
    state.undoStack.push(
      oldBytes === null ? [fullPath, null, false] : [fullPath, null, false, oldBytes]
    )
    // Snapshot before the write so reject/undo can restore the original bytes.
    await this.ctx.changeTracker.recordChange(
      rel,
      fullPath,
      oldBytes === null ? ChangeType.ADDED : ChangeType.MODIFIED,
      '',
      true,
      '',
      ''
    )
  }

  async recordBinaryArtifact(
    fullPath: string,
    actionLabel: string,
    summaryNote: string,
    what = '',
    why = ''
  ): Promise<void> {
    const state = this.ctx.state
    const rel = this.ctx.paths.rel(fullPath)
    const top = state.undoStack[state.undoStack.length - 1]
    const existed = top !== undefined && top[0] === fullPath && (top[1] !== null || top[3] !== undefined)
    if (!top || top[0] !== fullPath) state.undoStack.push([fullPath, null, false])
    const act = actionLabel.toLowerCase()
    let ctype: ChangeType
    if (
      act.includes('image') ||
      act.includes('generate') ||
      act.includes('uhd') ||
      act.includes('qr')
    )
      ctype = ChangeType.GENERATED
    else if (act.includes('docx') || act.includes('doc')) ctype = ChangeType.DOCX_EDITED
    else ctype = existed ? ChangeType.MODIFIED : ChangeType.ADDED
    await this.ctx.changeTracker.recordChange(rel, fullPath, ctype, summaryNote, true, what, why)
    state.turnFileChanges.push({
      action: actionLabel,
      path: rel,
      diff: `Binary/Media artifact ${actionLabel}: ${rel}\n${summaryNote}`,
      old_content: null,
      new_content: summaryNote
    })
  }

  checkCommandPaths(command: string): string[] {
    const suspicious: string[] = []
    if (command.includes('..')) suspicious.push("parent traversal ('..')")
    for (const match of command.matchAll(/([A-Za-z]:[\\/][^\s"'<>|]+)/g)) {
      const pathStr = match[1].replace(/[,;.]+$/u, '')
      try {
        if (!this.ctx.paths.isWithinTarget(pyResolve(pathStr))) suspicious.push(pathStr)
      } catch {}
    }
    return suspicious
  }

  printTodos(): void {
    const todos = this.ctx.state.todos as Array<Record<string, unknown>>
    if (todos.length === 0) {
      out(`  ${C.DIM}No active todos.${C.RESET}`)
      return
    }
    const marks: Record<string, string> = { completed: '-', in_progress: '-', pending: '-' }
    out(`\n  ${C.GRAY}- ${C.BOLD}Tasks${C.RESET}`)
    for (const t of todos) {
      const status = (t['status'] ?? 'pending') as string
      const color = status === 'completed' ? C.GREEN : status === 'in_progress' ? C.YELLOW : C.DIM
      out(`  ${C.GRAY}- ${color}${marks[status] ?? '-'} ${t['content'] ?? ''}${C.RESET}`)
    }
    out(`  ${C.GRAY}-`)
  }
}
