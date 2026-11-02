import { readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { basename, join } from 'path'

import { AppConstants } from '../../shared/constants/app-constants'
import { C } from '../../shared/constants/colors'
import {
  KeyboardInterrupt,
  PythonError,
  ToolError,
  errorMessage
} from '../../shared/utils/exceptions'
import { fnmatch } from '../../shared/utils/fnmatch'
import { pyFormatFixed, pyFormatIntWidth } from '../../shared/utils/pyformat'
import {
  pyCompare,
  pyIntValue,
  pyRstrip,
  pySlice,
  pySplitlines,
  pyStr,
  pyStrip,
  pyTypeName
} from '../../shared/utils/pystr'
import { pyOr, pyTruthy } from '../../shared/utils/pytruth'
import { pyTime } from '../../shared/utils/pytime'
import { SequenceMatcher, charsOf, makeUnifiedDiff } from '../../shared/utils/difflib'
import { isBinary } from '../../shared/utils/text'
import { out, outRaw, sleep } from '../utils/console-out'
import { pathExists, pathIsDir, pathIsFile } from '../utils/fs-stat'
import { readText } from '../utils/fs-text'
import { pyGlob } from '../utils/py-glob'
import { killProcessTree, pyNewlines, shellReturncode, spawnShell } from '../utils/py-subprocess'
import { label, pathArg, type ToolSpec } from './tool-contract'

function compareListing(a: Dirent, b: Dirent): number {
  const aFile = a.isFile() ? 1 : 0
  const bFile = b.isFile() ? 1 : 0
  if (aFile !== bFile) return aFile - bFile
  return pyCompare(a.name.toLowerCase(), b.name.toLowerCase())
}

const ENV_TEMPLATES = ['.example', '.sample', '.template', '.dist']

/** Secret-bearing dotenv files never go into a prompt, the timeline or the database. */
function isSecretEnvFile(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (name === '.env') return true
  if (!name.startsWith('.env.')) return false
  return !ENV_TEMPLATES.some((suffix) => name.endsWith(suffix))
}

async function walkListing(
  directory: string,
  level: number,
  depth: number,
  lines: string[]
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of [...entries].sort(compareListing)) {
    if (AppConstants.IGNORED.has(entry.name)) continue
    if (lines.length >= 500) return
    lines.push('  '.repeat(level) + entry.name + (entry.isDirectory() ? '/' : ''))
    if (entry.isDirectory() && level + 1 < depth) {
      await walkListing(join(directory, entry.name), level + 1, depth, lines)
    }
  }
}

const listFiles: ToolSpec = {
  python: 'tool_list_files',
  params: [
    { name: 'path', default: '.' },
    { name: 'depth', default: 2 }
  ],
  run: async (ctx, args) => {
    const base = await ctx.paths.resolve(pathArg(args.path))
    if (!(await pathIsDir(base))) throw new ToolError(`Not a directory: ${label(args.path)}`)
    const depth = Math.max(1, Math.min(pyIntValue(pyOr(args.depth, 2)), 4))
    const lines: string[] = []
    await walkListing(base, 0, depth, lines)
    return lines.join('\n') || '(empty directory)'
  }
}

const readFileTool: ToolSpec = {
  python: 'tool_read_file',
  params: [
    { name: 'path', required: true },
    { name: 'offset', default: 1 },
    { name: 'limit', default: 2000 }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    if (isSecretEnvFile(full)) {
      throw new ToolError(
        `Refusing to read ${label(args.path)}: dotenv files hold secrets. ` +
          'Ask the user to share the value instead.'
      )
    }
    if (!(await pathExists(full))) throw new ToolError(`File not found: ${label(args.path)}`)
    if (await pathIsDir(full)) {
      throw new ToolError(`${label(args.path)} is a directory. Use list_files instead`)
    }
    const size = (await stat(full)).size
    if (size > 64 * 1024 * 1024) {
      throw new ToolError(
        `File is too large to read (${pyFormatFixed(size / (1024 * 1024), 1)} MB). ` +
          'Use grep_files to find the section you need.'
      )
    }
    const [text] = await ctx.fileOps.readTextFile(full)
    const lines = text.split('\n')
    const start = Math.max(1, pyIntValue(pyOr(args.offset, 1)))
    const count = Math.max(1, pyIntValue(pyOr(args.limit, 2000)))
    const chunk = lines.slice(start - 1, start - 1 + count)
    const body = chunk
      .map((line, i) => `${pyFormatIntWidth(start + i, 5)}| ${pySlice(line, 0, 2000)}`)
      .join('\n')
    const end = start + chunk.length - 1
    const footer = `\n[lines ${start}-${end} of ${lines.length}]`
    return (body || '(empty file)') + footer
  }
}

const globFiles: ToolSpec = {
  python: 'tool_glob_files',
  params: [
    { name: 'pattern', required: true },
    // Models routinely carry `path` over from grep_files/list_files, so it scopes the search
    // instead of failing the call as an unexpected keyword argument.
    { name: 'path', default: '.' }
  ],
  run: async (ctx, args) => {
    const pattern = pyStr(args.pattern)
    const base = await ctx.paths.resolve(pathArg(args.path))
    const results: string[] = []
    let truncated = false
    for await (const match of pyGlob(base, pattern)) {
      const rel = ctx.paths.rel(match)
      const parts = rel.split(/[\\/]/u).filter((part) => part !== '' && part !== '.')
      if (parts.some((part) => AppConstants.IGNORED.has(part))) continue
      if (!(await pathIsFile(match))) continue
      results.push(rel)
      if (results.length >= 300) {
        truncated = true
        break
      }
    }
    const body = results.sort(pyCompare).join('\n') || 'No files matched'
    return truncated ? `${body}\n[result limit reached]` : body
  }
}

async function collectSearchFiles(dir: string, include: string, files: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const dirnames: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirnames.push(entry.name)
    else if (entry.isFile()) {
      if (include && !fnmatch(entry.name, include)) continue
      files.push(join(dir, entry.name))
    }
  }
  for (const name of dirnames) {
    if (AppConstants.IGNORED.has(name)) continue
    await collectSearchFiles(join(dir, name), include, files)
  }
}

const grepFiles: ToolSpec = {
  python: 'tool_grep_files',
  params: [
    { name: 'pattern', required: true },
    { name: 'path', default: '.' },
    { name: 'include', default: null },
    { name: 'ignore_case', default: false }
  ],
  run: async (ctx, args) => {
    let regex: RegExp
    try {
      regex = new RegExp(pyStr(args.pattern), pyTruthy(args.ignore_case) ? 'i' : '')
    } catch (e) {
      throw new ToolError(`Invalid regular expression: ${errorMessage(e)}`)
    }
    const base = await ctx.paths.resolve(pathArg(args.path))
    if (isSecretEnvFile(base)) {
      throw new ToolError(`Refusing to search ${label(args.path)}: dotenv files hold secrets.`)
    }
    const files: string[] = (await pathIsFile(base)) ? [base] : []
    if (await pathIsDir(base)) await collectSearchFiles(base, pyStr(args.include ?? ''), files)

    const results: string[] = []
    for (const file of files) {
      if (ctx.state.escMonitor?.check()) throw new KeyboardInterrupt()
      if (isSecretEnvFile(file)) continue
      let raw: Buffer
      try {
        if ((await stat(file)).size > 1_000_000) continue
        raw = await readFile(file)
      } catch {
        continue
      }
      if (isBinary(raw)) continue
      const lines = pySplitlines(raw.toString('utf-8'))
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index] as string)) continue
        results.push(
          `${ctx.paths.rel(file)}:${index + 1}: ${pySlice(pyStrip(lines[index] as string), 0, 300)}`
        )
        if (results.length >= 150) return `${results.join('\n')}\n[result limit reached]`
      }
    }
    return results.join('\n') || 'No matches found'
  }
}

const todoWrite: ToolSpec = {
  python: 'tool_todo_write',
  params: [{ name: 'todos', required: true }],
  run: async (ctx, args) => {
    if (!Array.isArray(args.todos)) {
      throw new PythonError('TypeError', `'${pyTypeName(args.todos)}' object is not iterable`)
    }
    ctx.state.todos = args.todos.map((todo) => ({ ...(todo as Record<string, unknown>) }))
    ctx.printTodos()
    return 'Todo list updated'
  }
}

const READ_PREFIX = /^(?:\d{5,}| {1,4}\d{1,4})\| ?/u
const READ_FOOTER = /\n?\[lines \d+-\d+ of \d+\]\s*$/u

// Models paste read_file's decoration ("    N| " prefixes plus the trailing
// "[lines a-b of c]") straight into old_string. Undo it, but only when every line
// carries read_file's 5-column prefix, so real content like "1| item" is left alone.
function stripReadFileDecorations(value: string): string | null {
  const lines = value.replace(READ_FOOTER, '').split('\n')
  const marked = lines.filter((line) => line !== '')
  if (marked.length === 0 || !marked.every((line) => READ_PREFIX.test(line))) return null
  const stripped = lines.map((line) => line.replace(READ_PREFIX, '')).join('\n')
  return stripped.trim() === '' ? null : stripped
}

const LEAD = /^[ \t]*/u

/** A runaway command (`yes`, a server log tail) must not buffer the whole session into RAM. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** Leading spaces of a line, or -1 when a tab is involved and no space count is meaningful. */
function spaceIndent(line: string): number {
  const lead = LEAD.exec(line)?.[0] ?? ''
  return lead.includes('\t') ? -1 : lead.length
}

function shiftLine(line: string, delta: number): string {
  if (line.trim() === '') return line
  if (delta > 0) return ' '.repeat(delta) + line
  const lead = spaceIndent(line)
  return lead < 0 ? line : line.slice(Math.min(lead, -delta))
}

/**
 * Last resort for a block the model retyped instead of pasting: the trailing spaces are gone and
 * the whole thing sits a level or two off. Compares trimmed lines, then shifts the replacement by
 * the file's own indent difference so the surrounding code keeps its depth. Returns null when
 * nothing matches, so the caller still answers with the v1.0 "not found" wording.
 */
function matchTrimmedBlock(
  text: string,
  needle: string,
  replacement: string
): { text: string; count: number } | null {
  const lines = text.split('\n')
  const want = needle.split('\n').map((line) => line.trim())
  if (!want.some((line) => line !== '')) return null

  const runs: number[] = []
  let used = 0
  for (let start = 0; start + want.length <= lines.length; start++) {
    if (start < used) continue
    if (want.every((line, i) => lines[start + i].trim() === line)) {
      runs.push(start)
      used = start + want.length
    }
  }
  if (runs.length === 0) return null

  const block = needle.split('\n')
  let delta = 0
  for (let i = 0; i < block.length; i++) {
    const fileLine = lines[runs[0] + i]
    if (fileLine.trim() === '' && block[i].trim() === '') continue
    const [fileIndent, needleIndent] = [spaceIndent(fileLine), spaceIndent(block[i])]
    delta = fileIndent < 0 || needleIndent < 0 ? 0 : fileIndent - needleIndent
    break
  }
  const shifted =
    delta === 0
      ? replacement.split('\n')
      : replacement.split('\n').map((line) => shiftLine(line, delta))

  const merged = [...lines]
  for (const start of [...runs].reverse()) merged.splice(start, want.length, ...shifted)
  return { text: merged.join('\n'), count: runs.length }
}

const NOT_FOUND =
  'old_string was not found. Read the file again and copy the exact ' +
  'text including spaces and indentation, without line number prefixes'

const appearsTimes = (count: number): string =>
  `old_string appears ${count} times. Add more surrounding lines to ` +
  'make it unique, or set replace_all to true'

const WORDS = /[^a-z0-9]+/u

/**
 * A refusal that only says "read it again" costs a step and teaches the model nothing: a weak model
 * answered it with the same invented block fifteen times in a row. Point at the nearest real text
 * instead so the next call has something to copy.
 */
function nearestTextHint(rel: string, lines: string[], needle: string): string {
  if (lines.length > 20000) return ''
  const probe = needle
    .split('\n')
    .reduce((longest, line) => (line.trim().length > longest.trim().length ? line : longest), '')
  const wanted = new Set(
    probe
      .toLowerCase()
      .split(WORDS)
      .filter((word) => word.length >= 4)
  )
  if (wanted.size === 0) return ''

  let best = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    // A minified bundle is one enormous line, so every comparison below works on a clipped view.
    const line = pySlice(lines[i], 0, 500)
    if (line.trim() === '') continue
    if (
      !line
        .toLowerCase()
        .split(WORDS)
        .some((word) => wanted.has(word))
    )
      continue
    const score = new SequenceMatcher(
      null,
      charsOf(pySlice(probe, 0, 500).trim().toLowerCase()),
      charsOf(line.trim().toLowerCase())
    ).ratio()
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best < 0 || bestScore < 0.4) return ''

  const from = Math.max(0, best - 2)
  const window = lines.slice(from, from + 12).map((line) => pySlice(line, 0, 200))
  return `\n\nThe closest text in ${rel} is at line ${best + 1}, and the file reads:\n${window.join('\n')}`
}

const editFile: ToolSpec = {
  python: 'tool_edit_file',
  params: [
    { name: 'path', required: true },
    { name: 'old_string', required: true },
    { name: 'new_string', required: true },
    { name: 'replace_all', default: false },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    const oldString = pyStr(args.old_string).replaceAll('\r\n', '\n')
    const newString = pyStr(args.new_string).replaceAll('\r\n', '\n')
    const replaceAll = pyTruthy(args.replace_all)
    const what = pyStr(args.what)
    const why = pyStr(args.why)

    if (oldString === newString) throw new ToolError('old_string and new_string are identical')
    if (!(await pathExists(full))) {
      if (oldString === '') {
        return ctx.commit('edit_file', full, rel, null, newString, false, what, why)
      }
      throw new ToolError(`File not found: ${label(args.path)}`)
    }
    if (await pathIsDir(full)) {
      throw new ToolError(`${label(args.path)} is a directory`)
    }
    if (oldString === '') {
      throw new ToolError('old_string is empty but the file exists. Use write_file to overwrite it')
    }

    const { text: oldText, crlf } = await readText(full)
    let needle = oldString
    let replacement = newString
    let count = oldText.split(needle).length - 1
    if (count === 0) {
      const undecorated = stripReadFileDecorations(oldString)
      if (undecorated !== null) {
        const relaxed = oldText.split(undecorated).length - 1
        if (relaxed > 0) {
          needle = undecorated
          count = relaxed
          const cleanNew = stripReadFileDecorations(newString)
          if (cleanNew !== null) replacement = cleanNew
        }
      }
    }
    // Stripping read_file's decoration can leave two strings that say the same thing, which the
    // check above could not see.
    if (needle === replacement) throw new ToolError('old_string and new_string are identical')
    if (count === 0) {
      const trimmed = matchTrimmedBlock(oldText, needle, replacement)
      if (trimmed !== null) {
        if (trimmed.count > 1 && !replaceAll) throw new ToolError(appearsTimes(trimmed.count))
        return ctx.commit('edit_file', full, rel, oldText, trimmed.text, crlf, what, why)
      }
    }
    if (count === 0) {
      throw new ToolError(NOT_FOUND + nearestTextHint(rel, oldText.split('\n'), needle))
    }
    if (count > 1 && !replaceAll) throw new ToolError(appearsTimes(count))
    const newText = replaceAll
      ? oldText.replaceAll(needle, () => replacement)
      : oldText.replace(needle, () => replacement)
    return ctx.commit('edit_file', full, rel, oldText, newText, crlf, what, why)
  }
}

const writeFile: ToolSpec = {
  python: 'tool_write_file',
  params: [
    { name: 'path', required: true },
    { name: 'content', required: true },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    const content = pyStr(args.content)
    const what = pyStr(args.what)
    const why = pyStr(args.why)

    if (await pathIsDir(full)) throw new ToolError(`${label(args.path)} is a directory`)

    if (await pathExists(full)) {
      const { text: oldText, crlf } = await readText(full)
      if (oldText === content) return `No changes needed in ${rel}`
      return ctx.commit('write_file', full, rel, oldText, content, crlf, what, why)
    }
    return ctx.commit('write_file', full, rel, null, content, false, what, why)
  }
}

const deleteFile: ToolSpec = {
  python: 'tool_delete_file',
  params: [
    { name: 'path', required: true },
    { name: 'what', default: '' },
    { name: 'why', default: '' }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.path))
    const rel = ctx.paths.rel(full)
    const what = pyStr(args.what)
    const why = pyStr(args.why)

    if (!(await pathIsFile(full))) throw new ToolError(`File not found: ${label(args.path)}`)

    const raw = await readFile(full)
    const oldText = isBinary(raw) ? '' : raw.toString('utf-8')
    const crlf = oldText.includes('\r\n')

    out(`\n  ${C.RED}${C.BOLD}- Delete:${C.RESET} ${rel}`)
    if (!(await ctx.allowed('delete_file', rel)))
      throw new ToolError('The user denied this deletion.')

    ctx.state.undoStack.push(
      isBinary(raw) ? [full, null, false, raw] : [full, oldText, crlf]
    )
    const diffStr = makeUnifiedDiff(rel, oldText, '').join('\n')
    await ctx.fileOps.deleteFile(full, what, why)
    ctx.state.turnFileChanges.push({
      action: 'deleted',
      path: rel,
      diff: diffStr,
      old_content: oldText,
      new_content: null
    })
    return `Deleted ${rel}`
  }
}

const runCommand: ToolSpec = {
  python: 'tool_run_command',
  params: [
    { name: 'command', required: true },
    { name: 'timeout', default: 120 }
  ],
  run: async (ctx, args) => {
    const command = pyStr(args.command)
    const suspicious = ctx.checkCommandPaths(command)
    if (suspicious.length > 0) {
      const warnMsg =
        `\n  ${C.YELLOW}[SECURITY WARNING]${C.RESET} Command appears to reference paths outside the target directory:\n` +
        `  ${C.RED}- ${suspicious.join(', ')}${C.RESET}\n` +
        `  Target directory: ${C.CYAN}${ctx.paths.root}${C.RESET}\n` +
        `  Command: ${C.WHITE}${command}${C.RESET}\n`
      out(warnMsg)
      if (
        !(await ctx.allowed('run_command_outside_target', `Run command outside target? ${command}`))
      ) {
        throw new ToolError('Command blocked: references paths outside target directory.')
      }
    } else if (!(await ctx.allowed('run_command', command))) {
      throw new ToolError('The user denied this command.')
    }

    const requested = Math.max(1, Math.min(pyIntValue(pyOr(args.timeout, 120)), 600))
    const proc = spawnShell(command, ctx.paths.root)

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    let dropped = 0
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const room = MAX_CAPTURE_BYTES - captured
      if (room <= 0) {
        dropped += chunk.byteLength
        return
      }
      if (chunk.byteLength <= room) {
        target.push(chunk)
        captured += chunk.byteLength
        return
      }
      target.push(chunk.subarray(0, room))
      dropped += chunk.byteLength - room
      captured = MAX_CAPTURE_BYTES
    }
    proc.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk))
    proc.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk))

    let exitCode: number | null = null
    let exitSignal: string | null = null
    let finished = false
    const exited = new Promise<void>((resolve) => {
      proc.on('close', (code, signal) => {
        exitCode = code
        exitSignal = signal
        finished = true
        resolve()
      })
      proc.on('error', (error: Error) => {
        capture(stderr, Buffer.from(`\n${error.message}\n`))
        finished = true
        resolve()
      })
    })

    const start = pyTime()
    let frame = 0
    let aborted = false
    try {
      while (!finished) {
        if (ctx.state.escMonitor?.check()) {
          aborted = true
          killProcessTree(proc, 'SIGTERM')
          await Promise.race([exited, sleep(1)])
          if (!finished) killProcessTree(proc, 'SIGKILL')
          throw new KeyboardInterrupt()
        }
        const elapsed = pyTime() - start
        if (elapsed > requested) {
          aborted = true
          killProcessTree(proc, 'SIGKILL')
          throw new ToolError(`Command timed out after ${requested} seconds`)
        }
        const spin = AppConstants.SPINNER_FRAMES[frame % AppConstants.SPINNER_FRAMES.length]
        frame += 1
        outRaw(
          `\r\x1b[K  ${C.GRAY}- ${C.CYAN}${spin}${C.RESET} ` +
            `${C.DIM}running (${pyFormatFixed(elapsed, 1)}s) - esc to interrupt${C.RESET}`
        )
        await Promise.race([exited, sleep(0.06)])
      }
    } finally {
      outRaw('\r\x1b[K')
      if (aborted) killProcessTree(proc, 'SIGKILL')
    }

    const returncode = shellReturncode(exitCode, exitSignal)
    const note =
      dropped > 0
        ? `\n[... output truncated: ${dropped} bytes dropped after the first ` +
          `${MAX_CAPTURE_BYTES} bytes]`
        : ''
    const fullOutput =
      pyNewlines(Buffer.concat(stdout).toString('utf-8')) +
      pyNewlines(Buffer.concat(stderr).toString('utf-8'))
    return pyRstrip(`exit code ${returncode}\n${fullOutput}${note}`)
  }
}

export const FILE_TOOLS: Record<string, ToolSpec> = {
  list_files: listFiles,
  read_file: readFileTool,
  glob_files: globFiles,
  grep_files: grepFiles,
  todo_write: todoWrite,
  edit_file: editFile,
  write_file: writeFile,
  delete_file: deleteFile,
  run_command: runCommand
}
