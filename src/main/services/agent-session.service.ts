import { mkdir, stat, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { C } from '../../shared/constants/colors'
import { pyGet, pyKey } from '../../shared/utils/pydict'
import { pyLen, pySlice, pySplitWords, pyStr } from '../../shared/utils/pystr'
import type { AgentState, Checkpoint, Todo, UndoEntry } from '../models/agent-state'
import { writeText } from '../utils/fs-text'
import { out } from '../utils/console-out'
import type { AgentPaths } from './agent-paths.service'
import type { AgentMemory } from './agent-memory.service'

export type ChooseItem = [value: string, note: string]

export interface ChooseOptions {
  current?: string
  page?: number
}

export type ChooseHook = (
  title: string,
  items: ChooseItem[],
  options?: ChooseOptions
) => string | null | Promise<string | null>

export interface AgentSessionDeps {
  paths: AgentPaths
  memory: AgentMemory
  buildSystem(): string | Promise<string>
  choose: ChooseHook
  onFileRestored?(fullPath: string, state: AgentState): Promise<void> | void
}

export class AgentSession {
  private readonly deps: AgentSessionDeps

  constructor(deps: AgentSessionDeps) {
    this.deps = deps
  }

  async rebuildCheckpointsFromContents(state: AgentState): Promise<Checkpoint[]> {
    const rebuilt: Checkpoint[] = []
    const memLen = pyLen(await this.deps.memory.readMemoryContent())
    for (let idx = 0; idx < state.contents.length; idx++) {
      const content = state.contents[idx]
      if (content.role === 'user' && content.parts && content.parts.length > 0) {
        const firstText = content.parts[0].text
        if (firstText) {
          let clean = firstText
          if (clean.includes('User Request:\n')) clean = clean.split('User Request:\n')[1]
          // Sessions stored before the memory migration still carry the old file-based note.
          const legacyNote = '\n\nNote (Required to do last): Log this interaction in /memory/memory.md.'
          if (clean.includes(legacyNote)) clean = clean.split(legacyNote)[0]
          clean = clean.split('\n\nReferenced files:\n')[0]
          rebuilt.push({
            prompt: clean,
            time: 'session',
            contents_len: idx,
            undo_len: state.undoStack.length,
            todos: [],
            memory_len: memLen
          })
        }
      }
    }
    return rebuilt
  }

  async popAndRestoreFile(state: AgentState): Promise<UndoEntry> {
    const entry = state.undoStack.pop() as UndoEntry
    const [full, oldText, crlf, oldBytes] = entry
    const rel = this.deps.paths.rel(full)
    if (oldBytes !== undefined) {
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, oldBytes)
      out(`  ${C.GRAY}- ${C.GREEN}-'''' Restored ${rel}${C.RESET}`)
    } else if (oldText === null) {
      if (await exists(full)) await unlink(full)
      out(`  ${C.GRAY}- ${C.GREEN}-'''' Removed ${rel}${C.RESET}`)
    } else {
      await mkdir(dirname(full), { recursive: true })
      await writeText(full, oldText, crlf)
      out(`  ${C.GRAY}- ${C.GREEN}-'''' Restored ${rel}${C.RESET}`)
    }
    if (this.deps.onFileRestored) {
      try {
        await this.deps.onFileRestored(full, state)
      } catch {}
    }
    return entry
  }

  async undo(state: AgentState): Promise<void> {
    if (state.undoStack.length === 0) {
      out(`  ${C.DIM}Nothing to undo.${C.RESET}`)
      return
    }
    await this.popAndRestoreFile(state)
  }

  async revert(state: AgentState): Promise<void> {
    if (state.checkpoints.length === 0) {
      out(`  ${C.DIM}No previous prompts to revert to yet.${C.RESET}`)
      return
    }

    const items: ChooseItem[] = []
    const totalUndos = state.undoStack.length
    for (let idx = state.checkpoints.length - 1; idx >= 0; idx--) {
      const cp = state.checkpoints[idx]
      const oneLine = pySplitWords(pyStr(pyKey(cp, 'prompt'))).join(' ')
      const preview = `${pySlice(oneLine, 0, 52)}${pyLen(oneLine) > 52 ? '...' : ''}`
      const label = `#${idx + 1}: ${preview}`
      const filesSince = Math.max(0, totalUndos - (pyGet<number>(cp, 'undo_len', 0) ?? 0))
      const turnsSince = state.checkpoints.length - idx
      const note = `[${pyStr(pyGet<string>(cp, 'time', ''))}] - reverts ${turnsSince} prompt(s), ${filesSince} file change(s)`
      items.push([label, note])
    }

    const chosen = await this.deps.choose('Revert session, files & memory to before prompt', items)
    if (!chosen) {
      out(`  ${C.DIM}Revert cancelled.${C.RESET}`)
      return
    }

    const match = /^#(\d+):/.exec(chosen)
    if (!match) return
    const targetIdx = Number(match[1]) - 1
    if (!(0 <= targetIdx && targetIdx < state.checkpoints.length)) return

    const targetCp = state.checkpoints[targetIdx]
    const targetUndoLen = pyGet<number>(targetCp, 'undo_len', 0) ?? 0
    const targetContentsLen = pyGet<number>(targetCp, 'contents_len', 0) ?? 0
    const targetMemoryLen = pyGet<number | null>(targetCp, 'memory_len', null)
    const revertedTurns = state.checkpoints.length - targetIdx
    let revertedFiles = 0

    out(
      `\n  ${C.GRAY}- ${C.YELLOW}${C.BOLD}Reverting to before #${targetIdx + 1}${C.RESET} ` +
        `${C.DIM}(${pySlice(pyStr(pyKey(targetCp, 'prompt')), 0, 60)})${C.RESET}`
    )
    while (state.undoStack.length > targetUndoLen) {
      await this.popAndRestoreFile(state)
      revertedFiles += 1
    }

    if (targetMemoryLen !== null && targetMemoryLen !== undefined)
      await this.rollbackMemory(targetMemoryLen, true)

    state.truncateContents(targetContentsLen)
    state.todos = (pyGet<Todo[]>(targetCp, 'todos', []) as Todo[]).map((t) => ({ ...t }))
    state.checkpoints = state.checkpoints.slice(0, targetIdx)
    state.system = await this.deps.buildSystem()

    out(
      `  ${C.GRAY}- ${C.GREEN}- Reverted ${revertedTurns} prompt(s) and ` +
        `${revertedFiles} file change(s).${C.RESET}`
    )
  }

  async rollbackToCheckpoint(state: AgentState, targetIdx: number): Promise<boolean> {
    if (!(0 <= targetIdx && targetIdx < state.checkpoints.length)) return false
    const targetCp = state.checkpoints[targetIdx]
    const targetUndoLen = pyGet<number>(targetCp, 'undo_len', 0) ?? 0
    const targetContentsLen = pyGet<number>(targetCp, 'contents_len', 0) ?? 0
    const targetMemoryLen = pyGet<number | null>(targetCp, 'memory_len', null)

    while (state.undoStack.length > targetUndoLen) {
      await this.popAndRestoreFile(state)
    }

    if (targetMemoryLen !== null && targetMemoryLen !== undefined)
      await this.rollbackMemory(targetMemoryLen, false)

    state.truncateContents(targetContentsLen)
    state.todos = (pyGet<Todo[]>(targetCp, 'todos', []) as Todo[]).map((t) => ({ ...t }))
    state.checkpoints = state.checkpoints.slice(0, targetIdx)
    state.system = await this.deps.buildSystem()
    return true
  }

  private async rollbackMemory(targetMemoryLen: number, announce: boolean): Promise<void> {
    const rolled = await this.deps.memory.truncateMemory(targetMemoryLen)
    if (rolled && announce)
      out(`  ${C.GRAY}- ${C.MAGENTA}-'''' Rolled back conversation memory${C.RESET}`)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
