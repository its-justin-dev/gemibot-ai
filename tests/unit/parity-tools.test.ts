import { mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, utimes, writeFile } from 'fs/promises'
import { cpus, release as osRelease, tmpdir, totalmem } from 'os'
import { dirname, join } from 'path'

import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import sharp from 'sharp'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { C } from '../../src/shared/constants/colors'
import { ALL_DECLARATIONS } from '../../src/shared/constants/tool-definitions'
import { AppConstants } from '../../src/shared/constants/app-constants'
import { PythonError } from '../../src/shared/utils/exceptions'
import { pyFormatIntWidth } from '../../src/shared/utils/pyformat'
import { pyRepr } from '../../src/shared/utils/pyrepr'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { checkZipDate, ntJoin, readTarMembers } from '../../src/main/utils/py-archive'
import { OFFICE_DOCUMENT } from '../../src/main/utils/ooxml-package'
import { Agent } from '../../src/main/services/agent.service'

/**
 * Parity tests for the ported v1.0 tools, driven through the real `execute()` dispatcher so the
 * signature binding, the printed lines and the returned string are all covered by one call.
 *
 * The expectations are the v1.0 strings from `views/window_app.py`, including the quirks that look
 * like mistakes: `read_file` prints `    1| ` for an empty file because its `(empty file)` answer
 * only fires when the offset runs past the end (`[lines 99-98 of 4]`), `list_files` silently drops
 * everything after row 500, `grep_files` ignores any file over 1 MB, `todo_write` marks every
 * status with the same `-` glyph, `run_command` loses every `\r` because `Popen(text=True)`
 * translates newlines while `web_fetch` keeps the `\r\n` it decoded by hand, and `web_fetch` keeps
 * the space an entity decoded into instead of folding it away.
 */

const network = vi.hoisted(() => ({ online: true }))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => network.online
}))

/**
 * `edge_tts.Communicate` stood in for a network stream: the case that matters is which text and
 * voice reach the engine, how many audio bytes come back, and what the failure message says.
 */
const tts = vi.hoisted(() => ({
  fail: false,
  chunks: [1] as number[],
  calls: [] as string[]
}))
vi.mock('edge-tts-universal', () => ({
  Communicate: class {
    constructor(text: string, options: { voice?: string }) {
      tts.calls.push(`${text}|${options?.voice ?? ''}`)
    }
    async *stream(): AsyncGenerator<{ type: string; data: Uint8Array }> {
      if (tts.fail) throw new Error('edge unavailable')
      for (const size of tts.chunks) yield { type: 'audio', data: new Uint8Array(size) }
    }
  }
}))

let root = ''
let raw = ''
let detach: (() => void) | null = null

async function makeAgent(autoYes = true): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-tools-'))
  return await Agent.create({
    root,
    model: 'gemini-3.5-flash-lite',
    autoYes,
    apiKey: 'parity-test-placeholder',
    choose: async () => null
  })
}

/** Run a tool through `execute()` and hand back the result plus the file changes it reported. */
async function run(
  agent: Agent,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await agent.tools.execute(name, args)
}

function only(result: Record<string, unknown>): string {
  const output = result.output
  if (typeof output !== 'string') throw new Error(`No output in ${JSON.stringify(result)}`)
  return output
}

function failure(result: Record<string, unknown>): string {
  const error = result.error
  if (typeof error !== 'string') throw new Error(`No error in ${JSON.stringify(result)}`)
  return error
}

/** Write a fixture file, creating its folder first — most cases here need nesting. */
async function writeAt(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}

/** Copy a fixture into the scratch root under its bare name, the way the oracle ran it. */
async function stage(src: string): Promise<string> {
  const name = src.split(/[\\/]/u).pop() as string
  await writeFile(join(root, name), await readFile(src))
  return name
}

beforeEach(() => {
  raw = ''
  network.online = true
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    raw += String(chunk)
    return true
  }) as never)
  detach = onConsoleOutput(() => undefined)
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const pending = root
  root = ''
  if (pending) {
    await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => {
        // A locked scratch dir must never look like a parity failure.
      }
    )
  }
})

describe('execute() — the dispatcher', () => {
  it('registers a tool for every declaration the model is offered', async () => {
    const agent = await makeAgent()
    const names = new Set(agent.tools.toolNames())
    const missing = ALL_DECLARATIONS.map((d) => d.name).filter((name) => !names.has(name))
    // Stage 3 ports the groups in order; the list has to be empty when it finishes.
    expect(missing).toEqual([])
  })

  it('answers an unknown tool with no duration and no file changes', async () => {
    const agent = await makeAgent()
    const result = await run(agent, 'no_such_tool', {})
    expect(failure(result)).toBe('Unknown tool: no_such_tool')
    expect(agent.state.turnTimelineEvents.at(-1)).toMatchObject({
      is_error: true,
      status: 'Failed',
      file_changes: []
    })
    expect(agent.state.turnTimelineEvents.at(-1)).not.toHaveProperty('duration')
  })

  it('refuses a write tool in PLAN mode before it binds the arguments', async () => {
    const agent = await makeAgent()
    agent.state.mode = 'plan'
    const result = await run(agent, 'write_file', {})
    expect(failure(result)).toBe(
      "Tool 'write_file' is disabled in PLAN mode. Switch to /build or /function."
    )
  })

  it('reproduces CPython binding errors for a bad argument list', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'read_file', { path: 'notes.txt', nope: 1 }))).toBe(
      "Bad arguments: tool_read_file() got an unexpected keyword argument 'nope'"
    )
    expect(failure(await run(agent, 'read_file', {}))).toBe(
      "Bad arguments: tool_read_file() missing 1 required positional argument: 'path'"
    )
    expect(failure(await run(agent, 'grep_files', { path: '.' }))).toBe(
      "Bad arguments: tool_grep_files() missing 1 required positional argument: 'pattern'"
    )
    expect(failure(await run(agent, 'edit_file', { path: 'a.txt' }))).toBe(
      "Bad arguments: tool_edit_file() missing 2 required positional arguments: 'old_string' and 'new_string'"
    )
  })

  it('clips an output longer than MAX_OUTPUT on the way back to the model', async () => {
    const agent = await makeAgent()
    // `read_file` caps every line at 2000 characters, so the clip has to be reached with rows.
    const rows = Array.from({ length: 400 }, () => 'z'.repeat(100))
    await writeAt(join(root, 'big.txt'), rows.join('\n'))
    const raw =
      `${rows.map((row, i) => `${pyFormatIntWidth(i + 1, 5)}| ${row}`).join('\n')}` +
      '\n[lines 1-400 of 400]'
    const output = only(await run(agent, 'read_file', { path: 'big.txt' }))
    expect(output).toBe(
      `${raw.slice(0, AppConstants.MAX_OUTPUT)}` +
        `\n... [truncated ${raw.length - AppConstants.MAX_OUTPUT} characters]`
    )
  })
})

describe('list_files', () => {
  it('shows folders first, then files, with the ignored names left out', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'work', 'notes.txt'), 'hello\n')
    await writeAt(join(root, 'work', 'src', 'a.py'), 'print(1)\n')
    await writeAt(join(root, 'work', 'node_modules', 'x.js'), 'module.exports = 1\n')
    expect(only(await run(agent, 'list_files', { path: 'work' }))).toBe('src/\n  a.py\nnotes.txt')
  })

  it('answers an empty folder and a wrong path the way v1.0 does', async () => {
    const agent = await makeAgent()
    await mkdir(join(root, 'nothing'), { recursive: true })
    expect(only(await run(agent, 'list_files', { path: 'nothing' }))).toBe('(empty directory)')
    expect(failure(await run(agent, 'list_files', { path: 'missing-folder' }))).toBe(
      'Not a directory: missing-folder'
    )
  })

  it('clamps depth to 1-4 and stops at 500 rows', async () => {
    const agent = await makeAgent()
    await mkdir(join(root, 'work', 'more'), { recursive: true })
    for (let i = 0; i < 25; i++) await writeFile(join(root, 'work', `f${i}.txt`), '')
    // `int(depth or 2)` makes 0 mean the default 2, and `max(1, min(…, 4))` pins 99 to 4.
    const flat = only(await run(agent, 'list_files', { path: 'work', depth: -1 }))
    expect(flat.split('\n')).toHaveLength(26)
    expect(flat).not.toContain('m0.txt')
    expect(only(await run(agent, 'list_files', { path: 'work', depth: 0 }))).toBe(
      only(await run(agent, 'list_files', { path: 'work', depth: 2 }))
    )
    expect(only(await run(agent, 'list_files', { path: 'work', depth: 99 }))).toBe(
      only(await run(agent, 'list_files', { path: 'work', depth: 4 }))
    )
    for (let i = 0; i < 480; i++) await writeFile(join(root, 'work', 'more', `m${i}.txt`), '')
    const capped = only(await run(agent, 'list_files', { path: 'work', depth: 4 }))
    expect(capped.split('\n')).toHaveLength(500)
    expect(capped).toContain('m479.txt')
    expect(capped).not.toContain('f9.txt')
  })
})

describe('read_file', () => {
  it('numbers lines from 1 in a five-wide column and reports the range', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
    expect(only(await run(agent, 'read_file', { path: 'notes.txt' }))).toBe(
      '    1| alpha\n    2| beta\n    3| gamma\n    4| \n[lines 1-4 of 4]'
    )
  })

  it('keeps the empty-looking row for an empty file and only says (empty file) past the end', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'blank.txt'), '')
    expect(only(await run(agent, 'read_file', { path: 'blank.txt' }))).toBe(
      '    1| \n[lines 1-1 of 1]'
    )
    await writeAt(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
    expect(only(await run(agent, 'read_file', { path: 'notes.txt', offset: 99 }))).toBe(
      '(empty file)\n[lines 99-98 of 4]'
    )
  })

  it('honours offset and limit together', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\nthree\nfour\n')
    expect(only(await run(agent, 'read_file', { path: 'notes.txt', offset: 2, limit: 2 }))).toBe(
      '    2| two\n    3| three\n[lines 2-3 of 5]'
    )
  })

  it('rejects a missing path and a directory', async () => {
    const agent = await makeAgent()
    await mkdir(join(root, 'src'), { recursive: true })
    expect(failure(await run(agent, 'read_file', { path: 'nope.txt' }))).toBe(
      'File not found: nope.txt'
    )
    expect(failure(await run(agent, 'read_file', { path: 'src' }))).toBe(
      'src is a directory. Use list_files instead'
    )
  })

  it('refuses a dotenv file but still reads its template', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, '.env'), 'GEMINI_API_KEY=very-secret\n')
    await writeAt(join(root, '.env.example'), 'GEMINI_API_KEY=your-key\n')
    expect(failure(await run(agent, 'read_file', { path: '.env' }))).toBe(
      'Refusing to read .env: dotenv files hold secrets. Ask the user to share the value instead.'
    )
    expect(failure(await run(agent, 'read_file', { path: '.env.local' }))).toBe(
      'Refusing to read .env.local: dotenv files hold secrets. Ask the user to share the value instead.'
    )
    expect(only(await run(agent, 'read_file', { path: '.env.example' }))).toBe(
      '    1| GEMINI_API_KEY=your-key\n    2| \n[lines 1-2 of 2]'
    )
  })
})

describe('glob_files', () => {
  it('matches recursively, keeps hidden folders and drops the ignored ones', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'notes.txt'), 'a\n')
    await writeAt(join(root, 'src', 'a.py'), 'b\n')
    await writeAt(join(root, '.hidden', 'deep.txt'), 'c\n')
    await writeAt(join(root, 'node_modules', 'x.txt'), 'd\n')
    expect(only(await run(agent, 'glob_files', { pattern: '**/*.txt' }))).toBe(
      '.hidden/deep.txt\nnotes.txt'
    )
    expect(only(await run(agent, 'glob_files', { pattern: 'src/*.py' }))).toBe('src/a.py')
    expect(only(await run(agent, 'glob_files', { pattern: '*.py' }))).toBe('No files matched')
  })

  it('sorts the matches and refuses an absolute pattern like pathlib does', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'b.txt'), '')
    await writeFile(join(root, 'a.txt'), '')
    expect(only(await run(agent, 'glob_files', { pattern: '*.txt' }))).toBe('a.txt\nb.txt')
    expect(failure(await run(agent, 'glob_files', { pattern: '/etc/*.txt' }))).toBe(
      'NotImplementedError: Non-relative patterns are unsupported'
    )
  })
})

describe('grep_files', () => {
  it('reports rel:line: text and respects ignore_case and include', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'notes.txt'), 'Hello world\nsecond line\nHELLO again\n')
    expect(only(await run(agent, 'grep_files', { pattern: 'Hello' }))).toBe(
      'notes.txt:1: Hello world'
    )
    expect(only(await run(agent, 'grep_files', { pattern: 'hello' }))).toBe('No matches found')
    expect(only(await run(agent, 'grep_files', { pattern: 'hello', ignore_case: true }))).toBe(
      'notes.txt:1: Hello world\nnotes.txt:3: HELLO again'
    )
    expect(only(await run(agent, 'grep_files', { pattern: 'Hello', include: '*.md' }))).toBe(
      'No matches found'
    )
  })

  it('skips binary files and caps at 150 rows', async () => {
    const agent = await makeAgent()
    await writeFile(
      join(root, 'many.txt'),
      Array.from({ length: 152 }, (_, i) => `hit ${i}`).join('\n')
    )
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
    const output = only(await run(agent, 'grep_files', { pattern: 'hit' }))
    expect(output.endsWith('\n[result limit reached]')).toBe(true)
    expect(output.split('\n')).toHaveLength(151)
    expect(output).toContain('many.txt:1: hit 0')
    expect(output).not.toContain('blob.bin')
  })

  it('calls a broken pattern an invalid regular expression', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'grep_files', { pattern: '(' }))).toMatch(
      /^Invalid regular expression: /u
    )
  })

  it('never searches a dotenv file, directly or inside the tree', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, '.env'), 'GEMINI_API_KEY=very-secret\n')
    await writeAt(join(root, '.env.example'), 'GEMINI_API_KEY=your-key\n')
    expect(failure(await run(agent, 'grep_files', { path: '.env', pattern: 'secret' }))).toBe(
      'Refusing to search .env: dotenv files hold secrets.'
    )
    expect(only(await run(agent, 'grep_files', { pattern: 'very-secret' }))).toBe('No matches found')
    expect(only(await run(agent, 'grep_files', { pattern: 'your-key' }))).toBe(
      '.env.example:1: GEMINI_API_KEY=your-key'
    )
  })
})

describe('todo_write', () => {
  it('prints the task block with v1.0’s single mark for every status', async () => {
    const agent = await makeAgent()
    const output = only(
      await run(agent, 'todo_write', {
        todos: [
          { content: 'Done', status: 'completed' },
          { content: 'Doing', status: 'in_progress' },
          { content: 'Todo', status: 'pending' }
        ]
      })
    )
    expect(output).toBe('Todo list updated')
    expect(agent.state.todos).toHaveLength(3)
    expect(raw).toBe(
      `\n  ${C.GRAY}- ${C.BOLD}Tasks${C.RESET}\n` +
        `  ${C.GRAY}- ${C.GREEN}- Done${C.RESET}\n` +
        `  ${C.GRAY}- ${C.YELLOW}- Doing${C.RESET}\n` +
        `  ${C.GRAY}- ${C.DIM}- Todo${C.RESET}\n` +
        `  ${C.GRAY}-\n`
    )
  })

  it('says so when the list is empty', async () => {
    const agent = await makeAgent()
    await run(agent, 'todo_write', { todos: [] })
    expect(raw).toBe(`  ${C.DIM}No active todos.${C.RESET}\n`)
  })
})

describe('edit_file', () => {
  it('replaces a unique match and reports the change', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\n')
    expect(
      only(
        await run(agent, 'edit_file', { path: 'notes.txt', old_string: 'two', new_string: 'three' })
      )
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('one\nthree\n')
    expect(agent.state.undoStack.at(-1)).toEqual([join(root, 'notes.txt'), 'one\ntwo\n', false])
    expect(agent.state.turnFileChanges.at(-1)).toMatchObject({
      action: 'modified',
      path: 'notes.txt'
    })
  })

  it('keeps the three refusal messages distinct', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'x\ny\nx\n')
    expect(
      failure(
        await run(agent, 'edit_file', { path: 'notes.txt', old_string: 'x', new_string: 'x' })
      )
    ).toBe('old_string and new_string are identical')
    expect(
      failure(
        await run(agent, 'edit_file', { path: 'notes.txt', old_string: 'zzz', new_string: 'q' })
      )
    ).toBe(
      'old_string was not found. Read the file again and copy the exact text including spaces and indentation, without line number prefixes'
    )
    expect(
      failure(
        await run(agent, 'edit_file', { path: 'notes.txt', old_string: 'x', new_string: 'q' })
      )
    ).toBe(
      'old_string appears 2 times. Add more surrounding lines to make it unique, or set replace_all to true'
    )
    expect(
      only(
        await run(agent, 'edit_file', {
          path: 'notes.txt',
          old_string: 'x',
          new_string: 'q',
          replace_all: true
        })
      )
    ).toBe('Updated notes.txt')
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('q\ny\nq\n')
  })

  it('treats an empty old_string as create-only and keeps $& literal', async () => {
    const agent = await makeAgent()
    expect(
      failure(await run(agent, 'edit_file', { path: 'nope.txt', old_string: 'a', new_string: 'b' }))
    ).toBe('File not found: nope.txt')
    expect(
      only(
        await run(agent, 'edit_file', {
          path: 'fresh.txt',
          old_string: '',
          new_string: 'created\n'
        })
      )
    ).toBe('Created fresh.txt')
    await writeFile(join(root, 'dollar.txt'), 'target\n')
    await run(agent, 'edit_file', { path: 'dollar.txt', old_string: 'target', new_string: '$&$1' })
    expect(await readFile(join(root, 'dollar.txt'), 'utf-8')).toBe('$&$1\n')
  })
})

describe('write_file', () => {
  it('creates, reports no change, and overwrites', async () => {
    const agent = await makeAgent()
    expect(only(await run(agent, 'write_file', { path: 'a.txt', content: 'one\n' }))).toBe(
      'Created a.txt'
    )
    expect(only(await run(agent, 'write_file', { path: 'a.txt', content: 'one\n' }))).toBe(
      'No changes needed in a.txt'
    )
    expect(only(await run(agent, 'write_file', { path: 'a.txt', content: 'two\n' }))).toBe(
      'Updated a.txt'
    )
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('two\n')
  })

  it('treats memory/memory.md as an ordinary file now that memory lives in the database', async () => {
    const agent = await makeAgent()
    expect(
      only(await run(agent, 'write_file', { path: 'memory/memory.md', content: 'A new note\n' }))
    ).toBe('Created memory/memory.md')
    expect(await readFile(join(root, 'memory', 'memory.md'), 'utf-8')).toBe('A new note\n')
  })

  it('refuses a directory', async () => {
    const agent = await makeAgent()
    await mkdir(join(root, 'bucket'))
    expect(failure(await run(agent, 'write_file', { path: 'bucket', content: 'x' }))).toBe(
      'bucket is a directory'
    )
  })
})

describe('delete_file', () => {
  it('prints the delete line', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'gone.txt'), 'bye\n')
    raw = ''
    expect(only(await run(agent, 'delete_file', { path: 'gone.txt' }))).toBe('Deleted gone.txt')
    expect(raw).toBe(`\n  ${C.RED}${C.BOLD}- Delete:${C.RESET} gone.txt\n`)
    const names = (await readdir(root)).filter((name) => name === 'gone.txt')
    expect(names).toEqual([])
    expect(agent.state.turnFileChanges.at(-1)).toMatchObject({
      action: 'deleted',
      path: 'gone.txt'
    })
  })

  it('reports a refusal as a Denied row that still carries the deletion diff', async () => {
    const agent = await makeAgent(false)
    agent.state.onPermission = async () => false
    await writeFile(join(root, 'keep.txt'), 'stay\n')
    const result = await run(agent, 'delete_file', { path: 'keep.txt' })
    expect(failure(result)).toBe('The user denied this deletion.')
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Denied', is_error: true })
    expect((event?.file_changes as unknown[]).length).toBe(0)
    expect(await readFile(join(root, 'keep.txt'), 'utf-8')).toBe('stay\n')
  })
})

describe('run_command', () => {
  it('returns the exit code line with the drained output', async () => {
    const agent = await makeAgent()
    expect(only(await run(agent, 'run_command', { command: 'node -p 6*7' }))).toBe(
      'exit code 0\n42'
    )
  })

  it('translates the newlines the pipes carry, the way Popen(text=True) does', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'crlf.js'), "process.stdout.write('a\\r\\nb\\rc')\n")
    expect(only(await run(agent, 'run_command', { command: 'node crlf.js' }))).toBe(
      'exit code 0\na\nb\nc'
    )
  })

  it('runs in the target directory and keeps a non-zero code', async () => {
    const agent = await makeAgent()
    // `f"exit code {rc}\n{out}".rstrip()` swallows the separator when the command said nothing.
    expect(only(await run(agent, 'run_command', { command: 'node -e process.exit(3)' }))).toBe(
      'exit code 3'
    )
    // `int(timeout or 120)` makes a 0 mean the default, so this command runs and keeps its code.
    expect(
      only(await run(agent, 'run_command', { command: 'node -e process.exit(1)', timeout: 0 }))
    ).toBe('exit code 1')
  })

  it('kills a command that outlives its clamped timeout', async () => {
    const agent = await makeAgent()
    const slow = process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 20'
    expect(failure(await run(agent, 'run_command', { command: slow, timeout: 1 }))).toBe(
      'Command timed out after 1 seconds'
    )
  })

  it('warns and blocks when the command points outside the target', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    raw = ''
    const result = await run(agent, 'run_command', { command: 'type ..\\secrets.txt' })
    expect(failure(result)).toBe('Command blocked: references paths outside target directory.')
    expect(raw).toContain(`${C.YELLOW}[SECURITY WARNING]${C.RESET}`)
    expect(raw).toContain(`${C.RED}- parent traversal ('..')${C.RESET}`)
    // A GUI dialog answers without printing, so the detail only reaches the timeline.
    expect(asked).toEqual([
      ['run_command_outside_target', 'Run command outside target? type ..\\secrets.txt']
    ])
    expect(raw).not.toContain('Permission Required')
  })

  it('asks for permission with the bare command as the detail', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    expect(failure(await run(agent, 'run_command', { command: 'node -p 1' }))).toBe(
      'The user denied this command.'
    )
    expect(asked).toEqual([['run_command', 'node -p 1']])
  })
})

describe('web_fetch', () => {
  function mocked(
    body: string,
    init: { status?: number; statusText?: string; contentType?: string } = {}
  ): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async (url: unknown) => {
      void url
      return new Response(Buffer.from(body, 'utf-8'), {
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
        headers: init.contentType ? { 'content-type': init.contentType } : {}
      })
    })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('refuses a non-http url and a denied one', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'web_fetch', { url: 'ftp://example.com' }))).toBe(
      'Only http and https URLs are supported'
    )
    const no = await makeAgent(false)
    no.state.onPermission = async () => false
    expect(failure(await run(no, 'web_fetch', { url: 'https://example.com' }))).toBe(
      'The user denied this request.'
    )
  })

  it('drops script and style, strips tags, unescapes entities and folds blank lines', async () => {
    const agent = await makeAgent()
    const spy = mocked(
      '<html>\n<head><script>var a = 1;</script>\n<style>p { color: red }</style></head>\n' +
        '<body>\n  <h1>Title&nbsp;&amp; more</h1>\n\n\n  <p>Two   spaces</p>\n</body>\n</html>',
      { contentType: 'text/html; charset=utf-8' }
    )
    const output = only(await run(agent, 'web_fetch', { url: 'https://example.com' }))
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'User-Agent': 'Mozilla/5.0 (Gemibot CLI)' }
    })
    expect(output).toBe('Title\u00a0& more \n\n Two spaces')
  })

  it('turns an http status and a transport failure into the v1.0 request error', async () => {
    const agent = await makeAgent()
    mocked('nope', { status: 404, statusText: 'Not Found' })
    expect(failure(await run(agent, 'web_fetch', { url: 'https://example.com/x' }))).toBe(
      'Request failed: HTTP Error 404: Not Found'
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    expect(failure(await run(agent, 'web_fetch', { url: 'https://example.com/x' }))).toBe(
      'Request failed: <urlopen error fetch failed>'
    )
  })

  it('reads at most two megabytes and keeps the CRLF it decoded by hand', async () => {
    const agent = await makeAgent()
    const big = `${'a'.repeat(200)}\r\n`.repeat(20_000)
    mocked(big, { contentType: 'text/plain; charset=utf-8' })
    const output = only(await run(agent, 'web_fetch', { url: 'https://example.com/big' }))
    // `response.read(2_000_000)` cuts mid-line, and unlike `run_command` nothing translates the
    // newlines: `bytes.decode()` keeps every `\r`, including the one the cut lands on.  `execute()`
    // then clips the answer for the model, which is where the row count stops growing.
    expect(output).toBe(
      big.slice(0, 2_000_000).slice(0, AppConstants.MAX_OUTPUT) +
        `\n... [truncated ${2_000_000 - AppConstants.MAX_OUTPUT} characters]`
    )
  })
})

describe('grounding tools', () => {
  it('parses the duckduckgo markup into the bullet block', async () => {
    const agent = await makeAgent()
    const html =
      '<div class="result"><div class="result__title"><a>First  hit</a></div>' +
      '<div class="result__snippet">Snippet  one</div>' +
      '<div class="result__url">example.com</div></div>' +
      '<div class="result"><div class="result__title"><a>Second hit</a></div>' +
      '<div class="result__snippet">Snippet  two</div></div>' +
      '<div class="result"><div class="result__url">no-title.example</div></div>'
    const spy = vi.fn(async (...args: unknown[]) => {
      return new Response(Buffer.from(String(args[0]) === 'skip' ? '' : html, 'utf-8'), {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    })
    vi.stubGlobal('fetch', spy)
    const output = only(await run(agent, 'search_grounding', { query: 'first hit' }))
    expect(spy.mock.calls[0]?.[0]).toBe('https://html.duckduckgo.com/html/?q=first%20hit')
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gemibot/2.0' }
    })
    // `get_text(strip=True)` strips each text node and joins with `""`, so a double space inside
    // one node survives; a missing `.result__url` answers with the empty string.
    expect(output).toBe(
      "Google Search Grounding Results for 'first hit':\n\n" +
        '• **First  hit**\n  Snippet  one\n  Source: example.com\n\n' +
        '• **Second hit**\n  Snippet  two\n  Source: '
    )
  })

  it('keeps the no-results and failure wordings, and refuses an empty query', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'search_grounding', { query: '   ' }))).toBe(
      'Search query cannot be empty.'
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>nothing</html>'))
    )
    expect(only(await run(agent, 'search_grounding', { query: 'quiet' }))).toBe(
      'Google Search Grounding executed for: quiet'
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('boom')
      })
    )
    expect(only(await run(agent, 'search_grounding', { query: 'boom' }))).toBe(
      "Search Grounding query for 'boom' completed (<urlopen error boom>)."
    )
  })

  it('keeps a row whose snippet element is empty, because a bs4 Tag is always truthy', async () => {
    const agent = await makeAgent()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<div class="result"><div class="result__title">Has title</div>' +
              '<div class="result__snippet"></div></div>'
          )
      )
    )
    expect(only(await run(agent, 'search_grounding', { query: 'edge' }))).toBe(
      "Google Search Grounding Results for 'edge':\n\n• **Has title**\n  \n  Source: "
    )
  })

  it('reads the nominatim rows and falls back to the maps url', async () => {
    const agent = await makeAgent()
    const payload = JSON.stringify([
      { display_name: 'Poblacion, Makati', lat: '14.557', lon: '121.025', type: 'city' },
      { display_name: 'Makati City', lat: '14.57', lon: '121.03', type: 'administrative' }
    ])
    const spy = vi.fn<(url: unknown) => Promise<Response>>(
      async () => new Response(Buffer.from(payload, 'utf-8'))
    )
    vi.stubGlobal('fetch', spy)
    expect(only(await run(agent, 'map_grounding', { location: 'Makati City' }))).toBe(
      "Google Maps Grounding for 'Makati City':\n\n" +
        '• **Poblacion, Makati**\n  Type: city | Coordinates: 14.557, 121.025\n' +
        '  Google Maps: https://www.google.com/maps/search/?api=1&query=14.557,121.025\n\n' +
        '• **Makati City**\n  Type: administrative | Coordinates: 14.57, 121.03\n' +
        '  Google Maps: https://www.google.com/maps/search/?api=1&query=14.57,121.03'
    )
    expect(String(spy.mock.calls[0]?.[0])).toContain(
      'https://nominatim.openstreetmap.org/search?q=Makati%20City&format=json&addressdetails=1&limit=5'
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]'))
    )
    expect(only(await run(agent, 'map_grounding', { location: 'nowhere!' }))).toBe(
      'Google Maps Grounding for: nowhere!\n' + 'URL: https://www.google.com/maps/search/nowhere%21'
    )
  })

  it('refuses an empty location', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'map_grounding', { location: '' }))).toBe(
      'Location cannot be empty.'
    )
  })
})

describe('image tools', () => {
  const FIXTURE = join(__dirname, '../fixtures/exif-sample.jpg')

  function visionStub(agent: Agent): { texts: string[]; prompts: string[] } {
    const texts: string[] = []
    const prompts: string[] = []
    agent.client.generateContent = async (_model, contents) => {
      prompts.push(String(contents[0]?.parts?.at(-1)?.text ?? ''))
      texts.push('A tiny red photo.')
      return {
        candidates: [{ content: { role: 'model', parts: [{ text: 'A tiny red photo.' }] } }],
        text: 'A tiny red photo.',
        usage_metadata: null,
        raw_response: null
      }
    }
    return { texts, prompts }
  }

  it('image_read prints the Pillow metadata block and the vision reply', async () => {
    const agent = await makeAgent()
    const stub = visionStub(agent)
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    const output = only(await run(agent, 'image_read', { path: 'exif-sample.jpg' }))
    expect(output).toBe(
      'File: exif-sample.jpg (787 bytes, image/jpeg)\n' +
        'Dimensions: 3x2 px | Format: JPEG | Mode: RGB\n' +
        // Values and formatting match PIL exactly; the entry ORDER is the file order, while
        // Pillow 11.3 materialises `getexif()` through a lazily-populated dict whose iteration
        // order depends on CPython set internals — recorded as a divergence in the final report.
        'EXIF: Make=Acme Corp, Model=Model X100, Orientation=1, XResolution=720000.0, ' +
        'YResolution=72.0, ResolutionUnit=2, Software=G?mi\n\n' +
        'Vision Analysis:\nA tiny red photo.'
    )
    expect(stub.prompts[0]).toBe(
      'Describe this image in detail, including objects, text, layout, and colors.'
    )
  })

  it('image_ocr sends the exact OCR prompt and shares the read pipeline', async () => {
    const agent = await makeAgent()
    const stub = visionStub(agent)
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    const output = only(await run(agent, 'image_ocr', { path: 'exif-sample.jpg' }))
    expect(output).toContain('Vision Analysis:\nA tiny red photo.')
    expect(stub.prompts[0]).toBe(
      'Perform exact, character-for-character OCR on this image (language hint: auto). ' +
        'Preserve all headings, line breaks, tables (as Markdown tables), and code blocks. ' +
        'Output the extracted text clearly.'
    )
  })

  it('image_read reports a missing image with the v1.0 wording', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'image_read', { path: 'nope.png' }))).toBe(
      'Image not found: nope.png'
    )
  })

  it('a vision failure becomes the Gemini Vision note instead of a tool error', async () => {
    const agent = await makeAgent()
    agent.client.generateContent = async () => {
      throw new TypeError('offline')
    }
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    const output = only(await run(agent, 'image_read', { path: 'exif-sample.jpg' }))
    expect(output).toContain('\n\nVision Analysis:\nGemini Vision call failed: offline')
  })

  it('image_transform writes the output and returns the summary line', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    const summary = only(
      await run(agent, 'image_transform', {
        path: 'exif-sample.jpg',
        operation: 'resize',
        width: 6,
        height: 4,
        output_path: 'out/small.jpg'
      })
    )
    expect(summary).toBe('Transformed exif-sample.jpg -> out/small.jpg (resize, 6x4)')
    expect((await readFile(join(root, 'out', 'small.jpg'))).length).toBeGreaterThan(0)
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Success' })
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'modified',
      path: 'out/small.jpg'
    })
  })

  it('image_transform keeps the original spelling in the refusal', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    expect(
      failure(await run(agent, 'image_transform', { path: 'exif-sample.jpg', operation: 'Zoom' }))
    ).toBe('Unsupported operation: Zoom')
  })

  it('the generate and transform permission prompts use the v1.0 details', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    await writeFile(join(root, 'exif-sample.jpg'), await readFile(FIXTURE))
    expect(
      failure(await run(agent, 'image_generate_uhd', { prompt: 'cat', output_path: 'cat.jpg' }))
    ).toBe('The user denied image generation.')
    expect(
      failure(
        await run(agent, 'image_transform', { path: 'exif-sample.jpg', operation: 'grayscale' })
      )
    ).toBe('The user denied image transformation.')
    expect(asked).toEqual([
      ['image_generate_uhd', 'cat.jpg (4k)'],
      ['image_transform', 'grayscale -> exif-sample.jpg']
    ])
  })
})

describe('docx tools', () => {
  const FIXTURE = join(__dirname, '../fixtures/oracle-sample.docx')

  it('docx_read reproduces the python-docx markdown walk', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    expect(only(await run(agent, 'docx_read', { path: 'oracle-sample.docx' }))).toBe(
      '# DOCX Document: oracle-sample.docx\n' +
        '\n' +
        '## Chapter One\n' +
        '### Section\n' +
        '   3| First paragraph with words.\n' +
        '   5| Second paragraph, styled Default.\n' +
        '#### Sub\n' +
        '\n' +
        '## Extracted Tables (1)\n' +
        '\n' +
        '### Table 1\n' +
        '| A1 | B1 |\n' +
        '| --- | --- |\n' +
        '| A2 | B2 |'
    )
  })

  it('docx_read can skip the tables', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    const output = only(
      await run(agent, 'docx_read', { path: 'oracle-sample.docx', include_tables: false })
    )
    expect(output).not.toContain('Extracted Tables')
    expect(output).toContain('#### Sub')
  })

  it('docx_analyze matches the oracle report line for line', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    expect(only(await run(agent, 'docx_analyze', { path: 'oracle-sample.docx' }))).toBe(
      'DOCX Structural & Content Analysis: oracle-sample.docx\n' +
        '- Author: Oracle Author\n' +
        '- Title: Oracle Doc\n' +
        '- Created: 2013-12-23 23:15:00+00:00 | Modified: 2013-12-23 23:15:00+00:00\n' +
        '- Non-empty Paragraphs: 5\n' +
        '- Total Words: 12 (~1 min read)\n' +
        '- Total Characters: 81\n' +
        '- Tables Count: 1\n' +
        '- Sections Count: 1\n' +
        '- Styles Used: Heading 1, Heading 2, Heading 3, Normal\n' +
        '\nHeading Outline:\n' +
        '  - Heading 1: Chapter One\n' +
        '  - Heading 2: Section\n' +
        '  - Heading 3: Sub'
    )
  })

  it('docx_read reports a missing file with the v1.0 wording', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'docx_read', { path: 'nope.docx' }))).toBe(
      'DOCX file not found: nope.docx'
    )
  })

  it('docx_write creates the file and its summary counts every paragraph', async () => {
    const agent = await makeAgent()
    const summary = only(
      await run(agent, 'docx_write', {
        path: 'docs/plan.docx',
        content:
          '# Title\n\nBody line.\n\n- Bullet one\n1. Numbered\n\n| H1 | H2 |\n| --- | --- |\n| a | b |',
        title: 'The Plan'
      })
    )
    // Title heading + body + bullet + numbered = 4 body paragraphs (cell paragraphs don't
    // count), 1 table.
    expect(summary).toBe('Wrote DOCX file docs/plan.docx (5 paragraphs, 1 tables)')
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Success' })
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'created',
      path: 'docs/plan.docx'
    })
    // The written file must be a real docx python-docx could open — checked via the venv in
    // the parity oracle; here we at least re-read it through docx_read.
    const readBack = only(await run(agent, 'docx_read', { path: 'docs/plan.docx' }))
    expect(readBack).toContain('Body line.')
    expect(readBack).toContain('| a | b |')
  })

  it('docx_edit counts run-level and paragraph-level replacements like v1.0', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    const summary = only(
      await run(agent, 'docx_edit', {
        path: 'oracle-sample.docx',
        find_text: 'paragraph',
        replace_text: 'sentence'
      })
    )
    // Two body paragraphs contain the word; each is one run, so v1.0 counts 2.
    expect(summary).toBe('Updated DOCX oracle-sample.docx (replacements=2, appended=False)')
    const readBack = only(await run(agent, 'docx_read', { path: 'oracle-sample.docx' }))
    expect(readBack).toContain('First sentence with words.')
    expect(readBack).not.toContain('First paragraph')
  })

  it('docx_edit appends markdown and reports it', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    const summary = only(
      await run(agent, 'docx_edit', {
        path: 'oracle-sample.docx',
        append_markdown: '### Appended\n\nTail paragraph.'
      })
    )
    expect(summary).toBe('Updated DOCX oracle-sample.docx (replacements=0, appended=True)')
    const readBack = only(await run(agent, 'docx_read', { path: 'oracle-sample.docx' }))
    expect(readBack).toContain('#### Appended')
    expect(readBack).toContain('| Tail paragraph.')
  })

  it('the write and edit prompts use the v1.0 details', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    await writeFile(join(root, 'oracle-sample.docx'), await readFile(FIXTURE))
    expect(failure(await run(agent, 'docx_write', { path: 'new.docx', content: 'x' }))).toBe(
      'The user denied DOCX creation.'
    )
    expect(
      failure(await run(agent, 'docx_edit', { path: 'oracle-sample.docx', find_text: 'a' }))
    ).toBe('The user denied DOCX editing.')
    expect(asked).toEqual([
      ['docx_write', 'new.docx'],
      ['docx_edit', 'oracle-sample.docx']
    ])
  })
})

describe('excel tools', () => {
  const CSV = join(__dirname, '../fixtures/oracle-sample.csv')
  const XLSX = join(__dirname, '../fixtures/oracle-sample.xlsx')

  it('excel_read prints the csv line table with the python row numbers', async () => {
    const agent = await makeAgent()
    const path = await stage(CSV)
    expect(only(await run(agent, 'excel_read', { path }))).toBe(
      'CSV File: oracle-sample.csv (5 total rows)\n' +
        '   1| name | age | score | active\n' +
        '   2| Alice | 34 | 91.5 | True\n' +
        '   3| Bob | 28 | 78 | False\n' +
        '   4| Cara |  | 85.0 | True\n' +
        '   5| Dan | 41 |  | True'
    )
  })

  it('excel_read skips the all-empty row and keeps the formula text', async () => {
    const agent = await makeAgent()
    const path = await stage(XLSX)
    expect(only(await run(agent, 'excel_read', { path }))).toBe(
      'Workbook: oracle-sample.xlsx | Sheets: Data, Notes\n' +
        'Active Sheet: Data (3 rows x 3 cols)\n' +
        '\n' +
        '   1| name | age | score\n' +
        '   2| Alice | 34 | 91.5\n' +
        '   3| Bob | 28 | =B2+B3'
    )
  })

  it('excel_read can be aimed at a sheet and clamped to max_rows', async () => {
    const agent = await makeAgent()
    const path = await stage(XLSX)
    expect(only(await run(agent, 'excel_read', { path, sheet: 'Notes', max_rows: 2 }))).toBe(
      'Workbook: oracle-sample.xlsx | Sheets: Data, Notes\n' +
        'Active Sheet: Notes (1 rows x 1 cols)\n' +
        '\n' +
        '   1| hello'
    )
    // The csv branch slices instead of announcing a truncation.
    const csv = await stage(CSV)
    expect(only(await run(agent, 'excel_read', { path: csv, max_rows: 3 }))).toBe(
      'CSV File: oracle-sample.csv (5 total rows)\n' +
        '   1| name | age | score | active\n' +
        '   2| Alice | 34 | 91.5 | True\n' +
        '   3| Bob | 28 | 78 | False'
    )
    expect(only(await run(agent, 'excel_read', { path, max_rows: 2 }))).toBe(
      'Workbook: oracle-sample.xlsx | Sheets: Data, Notes\n' +
        'Active Sheet: Data (3 rows x 3 cols)\n' +
        '\n' +
        '   1| name | age | score\n' +
        '   2| Alice | 34 | 91.5\n' +
        '... [truncated after 2 rows]'
    )
  })

  it('excel_analyze on a csv carries the openpyxl note and the pandas block', async () => {
    const agent = await makeAgent()
    const path = await stage(CSV)
    expect(only(await run(agent, 'excel_analyze', { path }))).toBe(
      'Spreadsheet Analysis: oracle-sample.csv\n' +
        'openpyxl inspection note: openpyxl does not support .csv file format, please check you can open it with Excel first. Supported formats are: .xlsx,.xlsm,.xltx,.xltm\n' +
        '\n' +
        'Pandas Statistical Summary:\n' +
        'Shape: 4 rows x 4 columns\n' +
        'Columns & Types:\n' +
        'name          str\n' +
        'age       float64\n' +
        'score     float64\n' +
        'active       bool\n' +
        '\n' +
        'Missing Values:\n' +
        'age      1\n' +
        'score    1\n' +
        '\n' +
        'Numeric Describe:\n' +
        '         name        age      score active\n' +
        'count       4   3.000000   3.000000      4\n' +
        'unique      4        NaN        NaN      2\n' +
        'top     Alice        NaN        NaN   True\n' +
        'freq        1        NaN        NaN      3\n' +
        'mean      NaN  34.333333  84.833333    NaN\n' +
        'std       NaN   6.506407   6.751543    NaN\n' +
        'min       NaN  28.000000  78.000000    NaN\n' +
        '25%       NaN  31.000000  81.500000    NaN\n' +
        '50%       NaN  34.000000  85.000000    NaN\n' +
        '75%       NaN  37.500000  88.250000    NaN\n' +
        'max       NaN  41.000000  91.500000    NaN'
    )
  })

  it('excel_analyze on a workbook matches the oracle report line for line', async () => {
    const agent = await makeAgent()
    const path = await stage(XLSX)
    expect(only(await run(agent, 'excel_analyze', { path }))).toBe(
      'Spreadsheet Analysis: oracle-sample.xlsx\n' +
        'Sheets (2): Data, Notes\n' +
        '  - [Data]: 3 rows x 3 cols | Populated cells: 9 | Formulas: 1\n' +
        '  - [Notes]: 1 rows x 1 cols | Populated cells: 1 | Formulas: 0\n' +
        '\n' +
        'Pandas Statistical Summary:\n' +
        'Shape: 2 rows x 3 columns\n' +
        'Columns & Types:\n' +
        'name         str\n' +
        'age        int64\n' +
        'score    float64\n' +
        '\n' +
        'Missing Values:\n' +
        'score    1\n' +
        '\n' +
        'Numeric Describe:\n' +
        '         name        age  score\n' +
        'count       2   2.000000    1.0\n' +
        'unique      2        NaN    NaN\n' +
        'top     Alice        NaN    NaN\n' +
        'freq        1        NaN    NaN\n' +
        'mean      NaN  31.000000   91.5\n' +
        'std       NaN   4.242641    NaN\n' +
        'min       NaN  28.000000   91.5\n' +
        '25%       NaN  29.500000   91.5\n' +
        '50%       NaN  31.000000   91.5\n' +
        '75%       NaN  32.500000   91.5\n' +
        'max       NaN  34.000000   91.5'
    )
  })

  it('excel_read and excel_analyze report a missing file with the v1.0 wording', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'excel_read', { path: 'nope.xlsx' }))).toBe(
      'Spreadsheet not found: nope.xlsx'
    )
    expect(failure(await run(agent, 'excel_analyze', { path: 'nope.csv' }))).toBe(
      'Spreadsheet not found: nope.csv'
    )
  })

  it('excel_write stores formulas, sizes columns and reports the counts', async () => {
    const agent = await makeAgent()
    const summary = only(
      await run(agent, 'excel_write', {
        path: 'out/book.xlsx',
        sheet_name: 'Data',
        headers: ['name', 'qty'],
        rows: [
          ['Apple', '3'],
          ['Pear', '=SUM(B2:B3)']
        ]
      })
    )
    expect(summary).toBe('Wrote Excel workbook out/book.xlsx [sheet=Data, headers=2, rows=2]')
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Success' })
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'created',
      path: 'out/book.xlsx'
    })
    expect(only(await run(agent, 'excel_read', { path: 'out/book.xlsx' }))).toBe(
      'Workbook: out/book.xlsx | Sheets: Data\n' +
        'Active Sheet: Data (3 rows x 2 cols)\n' +
        '\n' +
        '   1| name | qty\n' +
        '   2| Apple | 3\n' +
        '   3| Pear | =SUM(B2:B3)'
    )
    // v1.0 sizes every column to min(max(longest cell + 3, 12), 50) over the cell texts.
    const wb = new ExcelJS.Workbook()
    // exceljs types its buffers against an older `@types/node` than the one Node 24 exports.
    const bytes = await readFile(join(root, 'out', 'book.xlsx'))
    await wb.xlsx.load(bytes as unknown as Parameters<ExcelJS.Xlsx['load']>[0])
    const data = wb.getWorksheet('Data') as ExcelJS.Worksheet
    expect([data.getColumn(1).width, data.getColumn(2).width]).toEqual([12, 14])

    // Writing again takes the workbook-exists branch: a new sheet, the old one untouched.
    expect(
      only(
        await run(agent, 'excel_write', {
          path: 'out/book.xlsx',
          sheet_name: 'Extra',
          headers: ['a', 'b'],
          rows: [['1', '2.50']]
        })
      )
    ).toBe('Wrote Excel workbook out/book.xlsx [sheet=Extra, headers=2, rows=1]')
    expect(only(await run(agent, 'excel_read', { path: 'out/book.xlsx' }))).toBe(
      'Workbook: out/book.xlsx | Sheets: Data, Extra\n' +
        'Active Sheet: Data (3 rows x 2 cols)\n' +
        '\n' +
        '   1| name | qty\n' +
        '   2| Apple | 3\n' +
        '   3| Pear | =SUM(B2:B3)'
    )
    expect(only(await run(agent, 'excel_read', { path: 'out/book.xlsx', sheet: 'Extra' }))).toBe(
      'Workbook: out/book.xlsx | Sheets: Data, Extra\n' +
        'Active Sheet: Extra (2 rows x 2 cols)\n' +
        '\n' +
        '   1| a | b\n' +
        '   2| 1 | 2.5'
    )
  })

  it('excel_write asks with the bare relative path and honours a denial', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    expect(
      failure(
        await run(agent, 'excel_write', {
          path: 'sub/book.xlsx',
          headers: ['a'],
          rows: [['1']]
        })
      )
    ).toBe('The user denied Excel write.')
    expect(asked).toEqual([['excel_write', 'sub/book.xlsx']])
  })
})

describe('pdf tools', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /** The content `tools/parity/make-pdf.py` handed to v1.0's `tool_pdf_write` for the report. */
  const LONG_CONTENT = [
    'Report of the Q3 field study.',
    '',
    '# Heading one',
    'The quick brown fox jumps over the lazy dog '.repeat(4),
    'A short line.',
    'x'.repeat(200),
    '',
    '   indented line keeps its leading spaces',
    'trailing spaces   ',
    'final line'
  ].join('\n')

  /** What `extract_text()` answered for it: a row for every drawn string, none for the blanks. */
  const REPORT_ROWS = [
    'Document',
    'Report of the Q3 field study.',
    '# Heading one',
    'The quick brown fox jumps over the lazy dog The quick brown fox jumps over the lazy dog The',
    'quick brown fox jumps over the lazy dog The quick brown fox jumps over the lazy dog',
    'A short line.',
    'x'.repeat(92),
    'x'.repeat(92),
    'x'.repeat(16),
    '   indented line keeps its leading spaces',
    'trailing spaces',
    'final line'
  ]

  /** v1.0 joined a header line onto one `\n--- Page n / total ---\n` block per requested page. */
  function readOut(name: string, total: number, pages: [number, string[]][]): string {
    const out = [`PDF File: ${name} (Total pages: ${total})`]
    for (const [p, rows] of pages) {
      out.push(`\n--- Page ${p} / ${total} ---\n${rows.join('\n')}`)
    }
    return out.join('\n')
  }

  /** The seven analyze lines, with the `/Info` triple and the word count left to the caller. */
  function analysis(
    name: string,
    pages: number,
    meta: string[],
    words: number,
    encrypted = false
  ): string {
    const [title, author, creator] = meta
    return (
      `PDF Analysis: ${name}\n` +
      `- Pages: ${pages}\n` +
      `- Encrypted: ${encrypted ? 'True' : 'False'}\n` +
      `- Title: ${title}\n` +
      `- Author: ${author}\n` +
      `- Creator: ${creator}\n` +
      `- Total Extracted Words: ${words}`
    )
  }

  // 92 characters is what `textwrap.wrap(line, 92)` keeps, and a filler row is 7 of the pairs.
  const FILLER_ROW = Array.from({ length: 7 }, () => 'filler words').join(' ')
  const fillerRows = (n: number): string[] => Array.from({ length: n }, () => FILLER_ROW)
  // Body rows run from y 709 down in 14 pt steps while y stays at or above 55: 47 of them.
  const ROWS_PER_PAGE = 47

  it('pdf_read keeps the leading spaces of an indented row and drops its trailing ones', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-report.pdf'))
    expect(only(await run(agent, 'pdf_read', { path }))).toBe(
      readOut('oracle-report.pdf', 1, [[1, REPORT_ROWS]])
    )
  })

  it('pdf_read clamps the window to the request before it clamps to the page count', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-report.pdf'))
    const header = 'PDF File: oracle-report.pdf (Total pages: 1)'
    // start 2 is kept, end 3 becomes min(3, 1) + 1 and the range comes back empty.
    expect(only(await run(agent, 'pdf_read', { path, start_page: 2, end_page: 3 }))).toBe(header)
    // `int(start_page or 1)` turns 0 into 1 and `int(end_page or 20)` turns 0 into 20.
    expect(only(await run(agent, 'pdf_read', { path, start_page: 0, end_page: 0 }))).toBe(
      readOut('oracle-report.pdf', 1, [[1, REPORT_ROWS]])
    )
    // The end is pulled up to the start, so an out-of-range start can never look like a range.
    expect(only(await run(agent, 'pdf_read', { path, start_page: 5, end_page: 2 }))).toBe(header)
  })

  it('pdf_analyze prints the metadata pypdf saw and the whole-document word count', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-report.pdf'))
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-report.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 62)
    )
  })

  it('pdf_analyze prints the /Info entries reportlab was given', async () => {
    const agent = await makeAgent()
    expect(
      only(await run(agent, 'pdf_analyze', { path: await stage(fx('oracle-titled.pdf')) }))
    ).toBe(
      analysis('oracle-titled.pdf', 1, ['Measured Titles', 'Ada Lovelace', 'Reportlab Canvas'], 5)
    )
    expect(only(await run(agent, 'pdf_read', { path: await stage(fx('oracle-titled.pdf')) }))).toBe(
      readOut('oracle-titled.pdf', 1, [[1, ['Body text with four words']]])
    )
  })

  it('a written document keeps reportlab default /Info values, not the title argument', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-meta.pdf'))
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-meta.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 4)
    )
    expect(only(await run(agent, 'pdf_read', { path }))).toBe(
      readOut('oracle-meta.pdf', 1, [[1, ['Tiny Title', 'Tiny body.']]])
    )
  })

  it('a page with nothing but a title answers that title and counts as one word', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-empty.pdf'))
    expect(only(await run(agent, 'pdf_read', { path }))).toBe(
      readOut('oracle-empty.pdf', 1, [[1, ['Document']]])
    )
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-empty.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 1)
    )
  })

  it('pdf_read paginates a two page document and pdf_analyze counts across both', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-pages.pdf'))
    const page1 = ['Two Pages', 'page one body', ...fillerRows(ROWS_PER_PAGE - 1)]
    const page2 = [...fillerRows(11), 'filler words', 'last line']
    expect(only(await run(agent, 'pdf_read', { path, start_page: 1, end_page: 2 }))).toBe(
      readOut('oracle-pages.pdf', 2, [
        [1, page1],
        [2, page2]
      ])
    )
    // start 2 is kept and end 9 stops at the total.
    expect(only(await run(agent, 'pdf_read', { path, start_page: 2, end_page: 9 }))).toBe(
      readOut('oracle-pages.pdf', 2, [[2, page2]])
    )
    // 400 pairs of filler words plus the title, the body line and the closing line.
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-pages.pdf', 2, ['untitled', 'anonymous', 'anonymous'], 807)
    )
  })

  it('pdf_analyze reports the /Encrypt dictionary the way pypdf reads it', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-openenc.pdf'))
    // An empty user password is decrypted by both readers, so the line comes back True while the
    // text still extracts — the one case that pins `reader.is_encrypted` rather than a guess.
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-openenc.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 3, true)
    )
    expect(only(await run(agent, 'pdf_read', { path }))).toBe(
      readOut('oracle-openenc.pdf', 1, [[1, ['Readable though encrypted']]])
    )
  })

  it('an encrypted pdf answers the pypdf decryption error from both readers', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-secret.pdf'))
    expect(failure(await run(agent, 'pdf_read', { path }))).toBe(
      'FileNotDecryptedError: File has not been decrypted'
    )
    expect(failure(await run(agent, 'pdf_analyze', { path }))).toBe(
      'FileNotDecryptedError: File has not been decrypted'
    )
  })

  it('a file that is not a pdf answers the pypdf stream error from both readers', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-junk.pdf'))
    expect(failure(await run(agent, 'pdf_read', { path }))).toBe(
      'PdfStreamError: Stream has ended unexpectedly'
    )
    expect(failure(await run(agent, 'pdf_analyze', { path }))).toBe(
      'PdfStreamError: Stream has ended unexpectedly'
    )
  })

  it('the readers report a missing pdf with the v1.0 wording', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'pdf_read', { path: 'oracle-nope.pdf' }))).toBe(
      'PDF not found: oracle-nope.pdf'
    )
    expect(failure(await run(agent, 'pdf_analyze', { path: 'sub/oracle-nope.pdf' }))).toBe(
      'PDF not found: sub/oracle-nope.pdf'
    )
  })

  it('pdf_write output reads back exactly as the v1.0-written document', async () => {
    const agent = await makeAgent()
    const summary = only(
      await run(agent, 'pdf_write', { path: 'out/nested/report.pdf', content: LONG_CONTENT })
    )
    expect(summary).toBe("Created PDF out/nested/report.pdf (title='Document')")
    expect((await readFile(join(root, 'out', 'nested', 'report.pdf'))).length).toBeGreaterThan(0)
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Success' })
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'created',
      path: 'out/nested/report.pdf',
      new_content: `Created PDF out/nested/report.pdf (title='Document')\n\n${LONG_CONTENT}`
    })

    // The reader is the only available witness of the writer, and v1.0 read its own file like this.
    expect(only(await run(agent, 'pdf_read', { path: 'out/nested/report.pdf' }))).toBe(
      readOut('out/nested/report.pdf', 1, [[1, REPORT_ROWS]])
    )
    expect(only(await run(agent, 'pdf_analyze', { path: 'out/nested/report.pdf' }))).toBe(
      analysis('out/nested/report.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 62)
    )
  })

  it('pdf_write breaks the page once a row would fall below y 55', async () => {
    const agent = await makeAgent()
    const content = Array.from({ length: ROWS_PER_PAGE + 2 }, () => 'word').join('\n')
    expect(
      only(await run(agent, 'pdf_write', { path: 'break.pdf', content, title: 'Title' }))
    ).toBe("Created PDF break.pdf (title='Title')")
    const text = only(await run(agent, 'pdf_read', { path: 'break.pdf', end_page: 2 }))
    expect(text).toBe(
      readOut('break.pdf', 2, [
        [1, ['Title', ...Array.from({ length: ROWS_PER_PAGE }, () => 'word')]],
        [2, ['word', 'word']]
      ])
    )
  })

  it('pdf_write with empty content still writes the title', async () => {
    const agent = await makeAgent()
    expect(only(await run(agent, 'pdf_write', { path: 'blank.pdf', content: '' }))).toBe(
      "Created PDF blank.pdf (title='Document')"
    )
    expect(only(await run(agent, 'pdf_analyze', { path: 'blank.pdf' }))).toBe(
      analysis('blank.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 1)
    )
  })

  it('pdf_write asks with the bare relative path and honours a denial', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    expect(failure(await run(agent, 'pdf_write', { path: 'sub/doc.pdf', content: 'Body.' }))).toBe(
      'The user denied PDF creation.'
    )
    expect(asked).toEqual([['pdf_write', 'sub/doc.pdf']])
  })

  it('pdf_read keeps a Symbol glyph as its raw code character — known divergence', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-unicode.pdf'))
    // v1.0/pypdf answered 'Café — naïve ✓'; pdfjs decoded the base-14 Symbol run as code 51.
    expect(only(await run(agent, 'pdf_read', { path }))).toBe(
      readOut('oracle-unicode.pdf', 1, [[1, ['Ünïcode', 'Café — naïve 3']]])
    )
    expect(only(await run(agent, 'pdf_analyze', { path }))).toBe(
      analysis('oracle-unicode.pdf', 1, ['untitled', 'anonymous', 'anonymous'], 5)
    )
  })
})

describe('pptx tools', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)
  const WIDE = 'x'.repeat(200)

  /** v1.0 appends a `\n--- Slide n ---` entry per slide and joins the list on one `\n`. */
  function readOut(name: string, total: number, slides: [number, string[]][]): string {
    const out = [`PowerPoint Presentation: ${name} (${total} slides)`]
    for (const [index, lines] of slides) out.push(`\n--- Slide ${index} ---`, ...lines)
    return out.join('\n')
  }

  /**
   * Stage a fixture under its own name and read it back through the port. The recorded
   * `oracle-*.pptx` decks carry the v1.0 "Gemibot AI Bro" subtitle in their own XML, so the
   * expectations below keep that spelling; only strings the port writes changed.
   */
  async function read(agent: Agent, name: string): Promise<string> {
    await stage(fx(name))
    return only(await run(agent, 'pptx_read', { path: name }))
  }

  async function readFailure(agent: Agent, name: string): Promise<string> {
    await stage(fx(name))
    return failure(await run(agent, 'pptx_read', { path: name }))
  }

  const OFFICE_DOCUMENT =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
  const NOTES_SLIDE =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'

  const DECK_SLIDES: [number, string[]][] = [
    [1, ['Deck Title', 'Deck Subtitle']],
    [
      2,
      [
        'Slide One',
        'first bullet',
        'second bullet',
        'Ünïcode — naïve ✓',
        '[Speaker Notes]: Notes for slide one'
      ]
    ],
    [3, ['No Bullets']],
    [4, ['Wide', WIDE, '', 'tail']]
  ]

  it('pptx_read walks the deck v1.0 wrote, slide for slide', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-deck.pptx')).toBe(readOut('oracle-deck.pptx', 4, DECK_SLIDES))
  })

  it('writes the default subtitle, but nothing for an empty one', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-sub.pptx')).toBe(
      readOut('oracle-sub.pptx', 2, [
        [1, ['T', 'Generated by Gemibot AI Bro']],
        [2, ['H', 'b']]
      ])
    )
    expect(await read(agent, 'oracle-nosub.pptx')).toBe(
      readOut('oracle-nosub.pptx', 2, [
        [1, ['T']],
        [2, ['H', 'b']]
      ])
    )
  })

  it('answers one slide for a deck whose slide list is empty or None', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-empty.pptx')).toBe(
      readOut('oracle-empty.pptx', 1, [[1, ['Empty Deck', 'Generated by Gemibot AI Bro']]])
    )
    expect(await read(agent, 'oracle-noslides.pptx')).toBe(
      readOut('oracle-noslides.pptx', 1, [[1, ['None Arg', 'Generated by Gemibot AI Bro']]])
    )
  })

  it('skips pictures, tables, groups and connectors and folds runs, breaks and fields', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-rich.pptx')).toBe(
      readOut('oracle-rich.pptx', 3, [
        [
          1,
          ['box paragraph one\nbox paragraph two', '[Speaker Notes]: spaced notes  \n second line']
        ],
        [
          2,
          ['first paragraph', 'run a\vafter brafter tab', '12 after field', 'inside an autoshape']
        ],
        [3, []]
      ])
    )
  })

  it('reports a deck inside a folder with a posix rel', async () => {
    const agent = await makeAgent()
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'rich.pptx'), await readFile(fx('oracle-rich.pptx')))
    expect(only(await run(agent, 'pptx_read', { path: 'sub/rich.pptx' })).split('\n')[0]).toBe(
      'PowerPoint Presentation: sub/rich.pptx (3 slides)'
    )
  })

  it('reads the deck the npm writer produced exactly as v1.0 read it', async () => {
    const agent = await makeAgent()
    // `oracle-node.pptx` was built by `tools/parity/probe-pptxgen.mjs` and read by v1.0's own
    // python-pptx, so this is the cross-implementation proof for the writer's text model.
    expect(await read(agent, 'oracle-node.pptx')).toBe(
      readOut('oracle-node.pptx', 9, [
        ...DECK_SLIDES,
        [5, ['Types', '42', 'True', 'None', '3.5', "[1, 'a']", "{'k': 'v'}"]],
        [6, ['Line', 'Break', 'first', 'second', 'a\vb', 'q\tx', '[Speaker Notes]: n1\nn2']],
        [7, ['Ctrl', '_x0007_bell', 'cr_x000D_here', '_x001B_esc']],
        [8, ['Later breaks', 'b0', 'x', 'b1\vy', 'b2\vy']],
        [9, ['Up\nDown', 'S1\nS2']]
      ])
    )
  })

  it('coerces each bullet through str() and keeps the paragraph/line-break split', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-coerce.pptx')).toBe(
      readOut('oracle-coerce.pptx', 5, [
        [1, ['T', 'Generated by Gemibot AI Bro']],
        [2, ['Types', '42', 'True', 'None', '3.5', "[1, 'a']", "{'k': 'v'}"]],
        [3, ['Line', 'Break', 'first', 'second', 'a\vb', 'q\tx', '[Speaker Notes]: n1\nn2']],
        [4, ['Ctrl', '_x0007_bell', 'cr_x000D_here', '_x001B_esc']],
        [5, ['Later breaks', 'b0', 'x', 'b1\vy', 'b2\vy']]
      ])
    )
  })

  it('splits a multi-line title and subtitle into paragraphs', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-multi.pptx')).toBe(
      readOut('oracle-multi.pptx', 2, [
        [1, ['Up\nDown', 'S1\nS2']],
        [2, ['H', 'b']]
      ])
    )
  })

  it('names a missing file, a non-zip and a zip that is not a package', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'pptx_read', { path: 'oracle-nope.pptx' }))).toBe(
      'PPTX not found: oracle-nope.pptx'
    )
    await stage(fx('oracle-junk.pptx'))
    expect(failure(await run(agent, 'pptx_read', { path: 'oracle-junk.pptx' }))).toBe(
      `PackageNotFoundError: Package not found at '${join(root, 'oracle-junk.pptx')}'`
    )
    expect(await readFailure(agent, 'oracle-zip.pptx')).toBe(
      `KeyError: "no member '/[Content_Types].xml' in package"`
    )
  })

  it('keeps the KeyError wording of a package with no presentation part', async () => {
    const agent = await makeAgent()
    for (const name of ['oracle-notpres.pptx', 'oracle-norels.pptx'])
      expect(await readFailure(agent, name)).toBe(
        `KeyError: "no relationship of type '${OFFICE_DOCUMENT}' in collection"`
      )
  })

  it('raises the KeyError of the slide id whose relationship or part is gone', async () => {
    const agent = await makeAgent()
    // Dropping the relationship and dropping the part it points at arrive at the same place: the
    // loader drops a relationship whose target is absent, so `rId8` is missing either way.
    for (const name of ['oracle-nosliderel.pptx', 'oracle-noslidepart.pptx'])
      expect(await readFailure(agent, name)).toBe(`KeyError: "no relationship with key 'rId8'"`)
  })

  it('counts the slides from p:sldIdLst, answering 0 when it is missing or empty', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-nosldidlst.pptx')).toBe(
      'PowerPoint Presentation: oracle-nosldidlst.pptx (0 slides)'
    )
    expect(await read(agent, 'oracle-emptysld.pptx')).toBe(
      'PowerPoint Presentation: oracle-emptysld.pptx (0 slides)'
    )
  })

  it('reads a shape with no txBody and a paragraph with no runs as empty', async () => {
    const agent = await makeAgent()
    expect(await read(agent, 'oracle-notxbody.pptx')).toBe(
      readOut('oracle-notxbody.pptx', 4, [
        [1, ['Deck Subtitle']],
        DECK_SLIDES[1],
        DECK_SLIDES[2],
        DECK_SLIDES[3]
      ])
    )
    expect(await read(agent, 'oracle-norun.pptx')).toBe(
      readOut('oracle-norun.pptx', 2, [
        [1, ['Generated by Gemibot AI Bro']],
        [2, ['H', 'b']]
      ])
    )
  })

  it('refuses a run without a:t, a slide without cSld or spTree, and two notes slides', async () => {
    const agent = await makeAgent()
    expect(await readFailure(agent, 'oracle-runnot.pptx')).toBe(
      'InvalidXmlError: required ``<a:t>`` child element not present'
    )
    expect(await readFailure(agent, 'oracle-nocsld.pptx')).toBe(
      'InvalidXmlError: required ``<p:cSld>`` child element not present'
    )
    expect(await readFailure(agent, 'oracle-notree.pptx')).toBe(
      'InvalidXmlError: required ``<p:spTree>`` child element not present'
    )
    expect(await readFailure(agent, 'oracle-twonotes.pptx')).toBe(
      `ValueError: multiple relationships of type '${NOTES_SLIDE}' in collection`
    )
  })

  it('pptx_write round-trips the oracle deck through the reader', async () => {
    const agent = await makeAgent()
    const summary = only(
      await run(agent, 'pptx_write', {
        path: 'deck.pptx',
        title: 'Deck Title',
        subtitle: 'Deck Subtitle',
        slides: [
          {
            heading: 'Slide One',
            bullets: ['first bullet', 'second bullet', 'Ünïcode — naïve ✓'],
            notes: 'Notes for slide one'
          },
          { heading: 'No Bullets', bullets: [] },
          { heading: 'Wide', bullets: [WIDE, '', 'tail'] }
        ]
      })
    )
    expect(summary).toBe('Created PowerPoint deck.pptx (4 total slides)')
    expect(only(await run(agent, 'pptx_read', { path: 'deck.pptx' }))).toBe(
      readOut('deck.pptx', 4, DECK_SLIDES)
    )
  })

  it('pptx_write creates the folder, reports the count and records the file', async () => {
    const agent = await makeAgent()
    const summary = only(
      await run(agent, 'pptx_write', {
        path: 'sub/new.pptx',
        title: 'Denied?',
        slides: [{ heading: 'H', bullets: ['b'] }]
      })
    )
    expect(summary).toBe('Created PowerPoint sub/new.pptx (2 total slides)')
    const event = agent.state.turnTimelineEvents.at(-1)
    expect(event).toMatchObject({ status: 'Success' })
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'created',
      path: 'sub/new.pptx'
    })
  })

  it('pptx_write asks with the bare relative path and honours a denial', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    expect(
      failure(await run(agent, 'pptx_write', { path: 'plan.pptx', title: 'T', slides: [] }))
    ).toBe('The user denied PPTX creation.')
    expect(asked).toEqual([['pptx_write', 'plan.pptx']])
  })

  it('reproduces the degenerate-argument ladder of the python-pptx text setter', async () => {
    const agent = await makeAgent()
    const write = async (
      name: string,
      title: unknown,
      slides: unknown,
      subtitle?: unknown
    ): Promise<Record<string, unknown>> =>
      await run(agent, 'pptx_write', { path: name, title, slides, subtitle })
    // `.text = value` calls `value.split()`, so anything without a `.split` fails there.
    expect(failure(await write('c1.pptx', null, []))).toBe(
      "AttributeError: 'NoneType' object has no attribute 'split'"
    )
    expect(failure(await write('c3.pptx', 'T', [{ heading: null, bullets: [] }]))).toBe(
      "AttributeError: 'NoneType' object has no attribute 'split'"
    )
    expect(failure(await write('c4.pptx', 'T', [{ heading: 42, bullets: [] }]))).toBe(
      "AttributeError: 'int' object has no attribute 'split'"
    )
    expect(failure(await write('c6.pptx', 'T', 'abc'))).toBe(
      "AttributeError: 'str' object has no attribute 'get'"
    )
    expect(failure(await write('c7.pptx', 'T', [null]))).toBe(
      "AttributeError: 'NoneType' object has no attribute 'get'"
    )
    // `for b_text in bullets` is where a TypeError comes from, and execute() routes every
    // TypeError through its `Bad arguments:` branch.
    expect(failure(await write('c10.pptx', 'T', [{ heading: 'H', bullets: 7 }]))).toBe(
      "Bad arguments: 'int' object is not iterable"
    )
    // The defaults and the falsy values all still write.
    expect(only(await write('c2.pptx', 'T', [{ bullets: ['b'] }]))).toBe(
      'Created PowerPoint c2.pptx (2 total slides)'
    )
    expect(only(await write('c5.pptx', 'T', [{}]))).toBe(
      'Created PowerPoint c5.pptx (2 total slides)'
    )
    expect(only(await write('c8.pptx', 'T', [{ heading: 'H', bullets: ['b'] }], null))).toBe(
      'Created PowerPoint c8.pptx (2 total slides)'
    )
    expect(only(await write('c9.pptx', 'T', [{ heading: 'H' }]))).toBe(
      'Created PowerPoint c9.pptx (2 total slides)'
    )
    expect(only(await write('c11.pptx', 'T', [{ heading: 'H', bullets: 'ab' }]))).toBe(
      'Created PowerPoint c11.pptx (2 total slides)'
    )
    expect(only(await write('c12.pptx', 'T', [{ heading: 'H', bullets: [], notes: 0 }]))).toBe(
      'Created PowerPoint c12.pptx (2 total slides)'
    )
  })

  it('applies the .get defaults and iterates a string bullet list character by character', async () => {
    const agent = await makeAgent()
    const COVER = [1, ['T', 'Generated by GemiBot AI']] as [number, string[]]
    await run(agent, 'pptx_write', { path: 'c2.pptx', title: 'T', slides: [{ bullets: ['b'] }] })
    expect(only(await run(agent, 'pptx_read', { path: 'c2.pptx' }))).toBe(
      readOut('c2.pptx', 2, [COVER, [2, ['Slide', 'b']]])
    )
    await run(agent, 'pptx_write', { path: 'c5.pptx', title: 'T', slides: [{}] })
    expect(only(await run(agent, 'pptx_read', { path: 'c5.pptx' }))).toBe(
      readOut('c5.pptx', 2, [COVER, [2, ['Slide']]])
    )
    await run(agent, 'pptx_write', {
      path: 'c8.pptx',
      title: 'T',
      slides: [{ heading: 'H', bullets: ['b'] }],
      subtitle: null
    })
    expect(only(await run(agent, 'pptx_read', { path: 'c8.pptx' }))).toBe(
      readOut('c8.pptx', 2, [
        [1, ['T']],
        [2, ['H', 'b']]
      ])
    )
    await run(agent, 'pptx_write', {
      path: 'c11.pptx',
      title: 'T',
      slides: [{ heading: 'H', bullets: 'ab' }]
    })
    expect(only(await run(agent, 'pptx_read', { path: 'c11.pptx' }))).toBe(
      readOut('c11.pptx', 2, [COVER, [2, ['H', 'a', 'b']]])
    )
    await run(agent, 'pptx_write', {
      path: 'c12.pptx',
      title: 'T',
      slides: [{ heading: 'H', bullets: [], notes: 0 }]
    })
    expect(only(await run(agent, 'pptx_read', { path: 'c12.pptx' }))).toBe(
      readOut('c12.pptx', 2, [COVER, [2, ['H']]])
    )
  })

  it('escapes a vertical tab in speaker notes — known divergence', async () => {
    const agent = await makeAgent()
    await run(agent, 'pptx_write', {
      path: 'vt.pptx',
      title: 'T',
      slides: [{ heading: 'H', bullets: ['b'], notes: 'a\vb' }]
    })
    // python-pptx turned a `\v` in notes into `<a:br/>`; pptxgenjs writes the notes as one run, so
    // the port escapes it as plain text instead, which keeps the package readable by both.
    expect(only(await run(agent, 'pptx_read', { path: 'vt.pptx' }))).toBe(
      readOut('vt.pptx', 2, [
        [1, ['T', 'Generated by GemiBot AI']],
        [2, ['H', 'b', '[Speaker Notes]: a_x000B_b']]
      ])
    )
  })
})

describe('corrupt office packages', () => {
  /**
   * Every message here is what v1.0 printed for the same damaged fixture:
   * `tools/parity/make-corrupt.py` ran the real `execute()` over packages built by hand and
   * `.recovered/oracle-corrupt.txt` keeps those lines. The damaged packages themselves were copied
   * into `tests/fixtures` by the same run, so the port keeps being measured against the same bytes
   * after current.v1.0 is shut down.
   */
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /** `execute()` renders an uncaught error as `{type(e).__name__}: {e}`. */
  const pyError = (name: string, message: string): string => `${name}: ${message}`
  const packageNotFound = (full: string): string =>
    pyError('PackageNotFoundError', `Package not found at '${full}'`)
  const noManifest = (): string =>
    pyError('KeyError', `"There is no item named '[Content_Types].xml' in the archive"`)
  const noOfficeDocument = (): string =>
    pyError('KeyError', `"no relationship of type '${OFFICE_DOCUMENT}' in collection"`)
  const noDocumentPart = (): string =>
    pyError('KeyError', `"There is no item named 'word/document.xml' in the archive"`)

  /** The ladder `docx.Document(str(full))` walks, in the order it walks it. */
  const DOCX: Array<[string, (full: string) => string]> = [
    ['corrupt-text.docx', packageNotFound],
    ['corrupt-empty.docx', packageNotFound],
    ['corrupt-zip.docx', noManifest],
    ['corrupt-ct.docx', noOfficeDocument],
    ['corrupt-nopart.docx', noDocumentPart],
    ['corrupt-norel.docx', noOfficeDocument]
  ]

  for (const tool of ['docx_read', 'docx_analyze', 'docx_edit'] as const) {
    for (const [name, expected] of DOCX) {
      it(`${tool} fails on ${name} with python-docx's wording`, async () => {
        const agent = await makeAgent()
        const staged = await stage(fx(name))
        const args: Record<string, unknown> = { path: staged }
        if (tool === 'docx_edit') {
          args.find_text = 'a'
          args.replace_text = 'b'
        }
        expect(failure(await run(agent, tool, args))).toBe(expected(join(root, staged)))
      })
    }
  }

  it('excel_read reports a file that is not a zip as zipfile does', async () => {
    const agent = await makeAgent()
    for (const name of ['corrupt-text.xlsx', 'corrupt-empty.xlsx']) {
      const staged = await stage(fx(name))
      expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(
        pyError('BadZipFile', 'File is not a zip file')
      )
    }
  })

  it('excel_read reports a zip with no manifest as zipfile does', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-zip.xlsx'))
    expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(noManifest())
  })

  it('excel_read reports a manifest with no workbook part as an OSError', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-ct.xlsx'))
    expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(
      pyError('OSError', 'File contains no valid workbook part')
    )
  })

  it('excel_read reports a sheet whose relationship is gone by its bare rId', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-norel.xlsx'))
    expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(
      pyError('KeyError', `'rId1'`)
    )
  })

  /**
   * The one damaged package that still reads. `ExcelReader.read_worksheets()` skips a sheet whose
   * part is not in the archive, so openpyxl reports the workbook with only `Notes` left — and the
   * port has to hide the placeholder worksheet exceljs invents for the missing part.
   */
  it('excel_read drops the sheet whose part is missing and reads the rest', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-nosheet.xlsx'))
    expect(only(await run(agent, 'excel_read', { path: staged }))).toBe(
      'Workbook: corrupt-nosheet.xlsx | Sheets: Notes\n' +
        'Active Sheet: Notes (1 rows x 1 cols)\n' +
        '\n' +
        '   1| hello'
    )
  })

  it('excel_write fails on a damaged workbook the way a read does', async () => {
    const agent = await makeAgent()
    for (const [name, expected] of [
      ['corrupt-text.xlsx', pyError('BadZipFile', 'File is not a zip file')],
      ['corrupt-zip.xlsx', noManifest()],
      ['corrupt-ct.xlsx', pyError('OSError', 'File contains no valid workbook part')],
      ['corrupt-norel.xlsx', pyError('KeyError', `'rId1'`)]
    ] as Array<[string, string]>) {
      const staged = await stage(fx(name))
      expect(
        `${name}: ${failure(await run(agent, 'excel_write', { path: staged, headers: ['h'], rows: [['v']] }))}`
      ).toBe(`${name}: ${expected}`)
    }
  })

  it('excel_write still writes over a workbook that lost a sheet part', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-nosheet.xlsx'))
    expect(
      only(await run(agent, 'excel_write', { path: staged, headers: ['h'], rows: [['v']] }))
    ).toBe('Wrote Excel workbook corrupt-nosheet.xlsx [sheet=Sheet1, headers=1, rows=1]')
  })

  /**
   * `tool_excel_analyze()` lets neither half escape, and the two libraries report the same damage
   * differently: openpyxl opens the archive, while pandas first picks an engine from the content
   * and only reaches openpyxl for a zip that carries `xl/workbook.xml`.
   */
  const ANALYZE: Array<[string, string]> = [
    [
      'corrupt-text.xlsx',
      'Spreadsheet Analysis: corrupt-text.xlsx\n' +
        'openpyxl inspection note: File is not a zip file\n' +
        'Pandas statistical summary note: Excel file format cannot be determined, you must specify an engine manually.'
    ],
    [
      'corrupt-empty.xlsx',
      'Spreadsheet Analysis: corrupt-empty.xlsx\n' +
        'openpyxl inspection note: File is not a zip file\n' +
        'Pandas statistical summary note: Excel file format cannot be determined, you must specify an engine manually.'
    ],
    [
      'corrupt-zip.xlsx',
      'Spreadsheet Analysis: corrupt-zip.xlsx\n' +
        'openpyxl inspection note: "There is no item named \'[Content_Types].xml\' in the archive"\n' +
        "Pandas statistical summary note: No such keys(s): 'io.excel.zip.reader'"
    ],
    [
      'corrupt-ct.xlsx',
      'Spreadsheet Analysis: corrupt-ct.xlsx\n' +
        'openpyxl inspection note: File contains no valid workbook part\n' +
        "Pandas statistical summary note: No such keys(s): 'io.excel.zip.reader'"
    ],
    [
      'corrupt-norel.xlsx',
      'Spreadsheet Analysis: corrupt-norel.xlsx\n' +
        "openpyxl inspection note: 'rId1'\n" +
        "Pandas statistical summary note: 'rId1'"
    ],
    [
      'corrupt-nosheet.xlsx',
      'Spreadsheet Analysis: corrupt-nosheet.xlsx\n' +
        'Sheets (1): Notes\n' +
        '  - [Notes]: 1 rows x 1 cols | Populated cells: 1 | Formulas: 0\n' +
        '\n' +
        'Pandas Statistical Summary:\n' +
        'Shape: 0 rows x 1 columns\n' +
        'Columns & Types:\n' +
        'hello    object\n' +
        '\n' +
        'Numeric Describe:\n' +
        '       hello\n' +
        'count      0\n' +
        'unique     0\n' +
        'top      NaN\n' +
        'freq     NaN'
    ]
  ]

  for (const [name, expected] of ANALYZE) {
    it(`excel_analyze keeps both notes for ${name}`, async () => {
      const agent = await makeAgent()
      const staged = await stage(fx(name))
      expect(only(await run(agent, 'excel_analyze', { path: staged }))).toBe(expected)
    })
  }

  /**
   * The office formats v1.0 could not open at all.  The two halves disagree about why:
   * `_validate_archive()` refuses the suffix before it touches the bytes, while pandas classifies
   * the content first and only then asks for the engine that format needs — `xlrd`, `pyxlsb` and
   * `odfpy` are not installed, so `import_optional_dependency()`'s own wording becomes the note.
   * The doubled space an absent `extra` leaves in that message is part of the output.
   */
  const importFailed = (install: string, extra = ''): string =>
    `\`Import ${install}\` failed. ${extra} Use pip or conda to install the ${install} package.`

  const FOREIGN: Array<[string, string, string]> = [
    [
      'corrupt-legacy.xls',
      'openpyxl does not support the old .xls file format, please use xlrd to read this file, ' +
        'or convert it to the more recent .xlsx file format.',
      importFailed('xlrd', 'Install xlrd >= 2.0.1 for xls Excel support')
    ],
    [
      'corrupt-xlsb.xlsb',
      'openpyxl does not support binary format .xlsb, please convert this file to .xlsx ' +
        'format if you want to open it with openpyxl',
      importFailed('pyxlsb')
    ],
    [
      'corrupt-ods.ods',
      'openpyxl does not support .ods file format, please check you can open it with Excel first. ' +
        'Supported formats are: .xlsx,.xlsm,.xltx,.xltm',
      importFailed('odfpy')
    ]
  ]

  for (const [name, refusal, pandasNote] of FOREIGN) {
    it(`excel_read and excel_write refuse ${name} by its suffix`, async () => {
      const agent = await makeAgent()
      const staged = await stage(fx(name))
      const expected = pyError('InvalidFileException', refusal)
      expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(expected)
      expect(
        failure(await run(agent, 'excel_write', { path: staged, headers: ['h'], rows: [['v']] }))
      ).toBe(expected)
    })

    it(`excel_analyze keeps both refusals for ${name}`, async () => {
      const agent = await makeAgent()
      const staged = await stage(fx(name))
      expect(only(await run(agent, 'excel_analyze', { path: staged }))).toBe(
        `Spreadsheet Analysis: ${staged}\n` +
          `openpyxl inspection note: ${refusal}\n` +
          `Pandas statistical summary note: ${pandasNote}`
      )
    })
  }

  /**
   * A file that starts `PK\x03\x04` but lost its central directory.  `zipfile.ZipFile()` fails on
   * it, so pandas raises while classifying the format rather than choosing an engine, and openpyxl
   * fails in `_validate_archive()` rather than on the suffix gate its `.xlsx` clears.
   */
  it('excel tools report a truncated archive as zipfile does', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('corrupt-trunc.xlsx'))
    expect(failure(await run(agent, 'excel_read', { path: staged }))).toBe(
      pyError('BadZipFile', 'File is not a zip file')
    )
    expect(
      failure(await run(agent, 'excel_write', { path: staged, headers: ['h'], rows: [['v']] }))
    ).toBe(pyError('BadZipFile', 'File is not a zip file'))
    expect(only(await run(agent, 'excel_analyze', { path: staged }))).toBe(
      'Spreadsheet Analysis: corrupt-trunc.xlsx\n' +
        'openpyxl inspection note: File is not a zip file\n' +
        'Pandas statistical summary note: File is not a zip file'
    )
  })
})

describe('voice tools', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  beforeEach(() => {
    tts.fail = false
    tts.chunks = [1]
    tts.calls = []
  })

  /**
   * `edge_tts.Communicate` is stood in for: the rung is a network stream, and decision 3 pins
   * media at content-equivalence, so what matters here is which engine the summary names, how the
   * voice argument reaches it, and how the byte count is read back off the file.
   */
  function audioStub(
    agent: Agent,
    reply: string | null = 'spoken words',
    boom?: string
  ): { shapes: string[]; prompts: string[] } {
    const shapes: string[] = []
    const prompts: string[] = []
    agent.client.generateContent = async (_model, contents) => {
      const parts = contents[0]?.parts ?? []
      const inline = parts[0]?.inline_data
      shapes.push(
        `[('inline', ${pyRepr(String(inline?.mime_type ?? ''))}, ` +
          `${inline ? Buffer.from(inline.data ?? '', 'base64').length : null}), ` +
          `('text', ${pyRepr(String(parts[1]?.text ?? ''))})]`
      )
      prompts.push(String(parts[1]?.text ?? ''))
      if (boom) throw new TypeError(boom)
      return {
        candidates:
          reply === null ? [] : [{ content: { role: 'model', parts: [{ text: reply }] } }],
        text: reply ?? '',
        usage_metadata: null,
        raw_response: null
      }
    }
    return { shapes, prompts }
  }

  const DEFAULT_PROMPT =
    'Analyze this audio: provide a full transcript, speaker tone/emotion, background noise ' +
    'assessment, and key takeaways.'

  /** The `Librosa Acoustic Profile` half of each pinned line, one line per fixture. */
  const PROFILES: Record<string, string> = {
    'voice-tone.wav':
      'Duration=1.00s | SR=44100Hz | RMS Energy=0.1414 | ZeroCrossingRate=0.0196 | Tempo=0.0 BPM',
    'voice-clicks.wav':
      'Duration=4.00s | SR=22050Hz | RMS Energy=0.0275 | ZeroCrossingRate=0.0017 | Tempo=117.5 BPM',
    'voice-8bit-stereo.wav':
      'Duration=1.00s | SR=8000Hz | RMS Energy=0.5502 | ZeroCrossingRate=0.1017 | Tempo=0.0 BPM',
    'voice-float32.wav':
      'Duration=1.00s | SR=16000Hz | RMS Energy=0.5004 | ZeroCrossingRate=0.0789 | Tempo=187.5 BPM'
  }

  const HEADERS: Record<string, string> = {
    'voice-tone.wav':
      'Audio File: voice-tone.wav (88,244 bytes, audio/wav)\n' +
      'WAV Metrics: Duration=1.00s | SampleRate=44100Hz | Channels=1 | SampleWidth=16-bit',
    'voice-clicks.wav':
      'Audio File: voice-clicks.wav (176,444 bytes, audio/wav)\n' +
      'WAV Metrics: Duration=4.00s | SampleRate=22050Hz | Channels=1 | SampleWidth=16-bit',
    'voice-8bit-stereo.wav':
      'Audio File: voice-8bit-stereo.wav (16,044 bytes, audio/wav)\n' +
      'WAV Metrics: Duration=1.00s | SampleRate=8000Hz | Channels=2 | SampleWidth=8-bit',
    'voice-float32.wav':
      'Audio File: voice-float32.wav (64,044 bytes, audio/wav)\n' +
      'WAV Metrics: Duration=1.00s | SampleRate=16000Hz | Channels=1 | SampleWidth=32-bit'
  }

  for (const name of Object.keys(HEADERS)) {
    it(`voice_analyze reproduces every measured number for ${name}`, async () => {
      const agent = await makeAgent()
      const stub = audioStub(agent)
      const bytes = await readFile(fx(name))
      const staged = await stage(fx(name))
      expect(only(await run(agent, 'voice_analyze', { path: staged }))).toBe(
        `${HEADERS[name]}\nLibrosa Acoustic Profile: ${PROFILES[name]}\n\nAI Voice Analysis:\nspoken words`
      )
      expect(stub.shapes[0]).toBe(
        `[('inline', 'audio/wav', ${bytes.length}), ('text', ${pyRepr(DEFAULT_PROMPT)})]`
      )
    })
  }

  it('a .wav that wave opens but librosa cannot measure keeps only its header', async () => {
    const agent = await makeAgent()
    audioStub(agent)
    expect(
      only(await run(agent, 'voice_analyze', { path: await stage(fx('voice-empty.wav')) }))
    ).toBe(
      'Audio File: voice-empty.wav (44 bytes, audio/wav)\n' +
        'WAV Metrics: Duration=0.00s | SampleRate=8000Hz | Channels=1 | SampleWidth=16-bit\n' +
        '\nAI Voice Analysis:\nspoken words'
    )
  })

  it('a file no reader accepts prints the mime line alone', async () => {
    const agent = await makeAgent()
    audioStub(agent)
    expect(
      only(await run(agent, 'voice_analyze', { path: await stage(fx('voice-broken.wav')) }))
    ).toBe('Audio File: voice-broken.wav (16 bytes, audio/wav)\n\nAI Voice Analysis:\nspoken words')
    expect(only(await run(agent, 'voice_analyze', { path: await stage(fx('voice-noext')) }))).toBe(
      'Audio File: voice-noext (18 bytes, audio/wav)\n\nAI Voice Analysis:\nspoken words'
    )
    expect(
      only(await run(agent, 'voice_analyze', { path: await stage(fx('voice-note.txt')) }))
    ).toBe('Audio File: voice-note.txt (36 bytes, text/plain)\n\nAI Voice Analysis:\nspoken words')
  })

  /** `mimetypes.guess_type()` over the seven containers, all of them 16 junk bytes. */
  const FAKE_MIMES: Record<string, string> = {
    'voice-fake.mp3': 'audio/mpeg',
    'voice-fake.ogg': 'audio/ogg',
    'voice-fake.flac': 'audio/x-flac',
    'voice-fake.m4a': 'audio/mp4',
    'voice-fake.aac': 'audio/vnd.dlna.adts',
    'voice-fake.webm': 'video/webm',
    'voice-fake.opus': 'audio/ogg'
  }

  for (const [name, mime] of Object.entries(FAKE_MIMES)) {
    it(`voice_analyze sends ${name} as ${mime} and measures nothing`, async () => {
      const agent = await makeAgent()
      const stub = audioStub(agent)
      expect(only(await run(agent, 'voice_analyze', { path: await stage(fx(name)) }))).toBe(
        `Audio File: ${name} (16 bytes, ${mime})\n\nAI Voice Analysis:\nspoken words`
      )
      expect(stub.shapes[0]).toBe(
        `[('inline', ${pyRepr(mime)}, 16), ('text', ${pyRepr(DEFAULT_PROMPT)})]`
      )
    })
  }

  /**
   * Divergence, asserted so it stays visible: soundfile decodes a real MP3 and v1.0 prints
   * `Duration=1.97s | SR=24000Hz | RMS Energy=0.0780 | ZeroCrossingRate=0.2241 | Tempo=165.4 BPM`
   * for this fixture, while this runtime has no MP3 decoder.  The header line and the request the
   * model receives are still identical.
   */
  it('a real compressed file loses the profile line v1.0 measured from it', async () => {
    const agent = await makeAgent()
    audioStub(agent)
    expect(
      only(await run(agent, 'voice_analyze', { path: await stage(fx('voice-edge.mp3')) }))
    ).toBe(
      'Audio File: voice-edge.mp3 (11,808 bytes, audio/mpeg)\n\nAI Voice Analysis:\nspoken words'
    )
  })

  it('voice_transcribe builds the prompt from the language hint and reuses the pipeline', async () => {
    const agent = await makeAgent()
    const stub = audioStub(agent)
    const staged = await stage(fx('voice-tone.wav'))
    only(await run(agent, 'voice_transcribe', { path: staged }))
    expect(stub.prompts[0]).toBe(
      'Transcribe every spoken word in this audio accurately (language hint: auto). ' +
        'Include timestamps if multiple sections or speakers exist.'
    )
    only(await run(agent, 'voice_transcribe', { path: staged, language: 'fr' }))
    expect(stub.prompts[1]).toBe(
      'Transcribe every spoken word in this audio accurately (language hint: fr). ' +
        'Include timestamps if multiple sections or speakers exist.'
    )
    expect(only(await run(agent, 'voice_transcribe', { path: staged }))).toContain(
      'Librosa Acoustic Profile: '
    )
  })

  it('a custom prompt reaches the model verbatim, spaces and all', async () => {
    const agent = await makeAgent()
    const stub = audioStub(agent)
    await run(agent, 'voice_analyze', {
      path: await stage(fx('voice-tone.wav')),
      prompt: '  spaced  '
    })
    expect(stub.prompts[0]).toBe('  spaced  ')
  })

  it('an empty model answer leaves the analysis block empty and a raised one becomes the note', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('voice-tone.wav'))
    audioStub(agent, null)
    const empty = only(await run(agent, 'voice_analyze', { path: staged }))
    expect(empty.endsWith('Tempo=0.0 BPM\n\nAI Voice Analysis:\n')).toBe(true)

    const other = await makeAgent()
    const otherStaged = await stage(fx('voice-tone.wav'))
    audioStub(other, null, 'boom')
    const raised = only(await run(other, 'voice_analyze', { path: otherStaged }))
    expect(
      raised.endsWith('Tempo=0.0 BPM\n\nAI Voice Analysis:\nGemini Audio analysis error: boom')
    ).toBe(true)
  })

  it('voice tools report a missing file and a bad signature the way v1.0 does', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'voice_analyze', { path: 'nope.wav' }))).toBe(
      'Audio file not found: nope.wav'
    )
    expect(failure(await run(agent, 'voice_analyze', {}))).toBe(
      "Bad arguments: tool_voice_analyze() missing 1 required positional argument: 'path'"
    )
    expect(failure(await run(agent, 'voice_generate', { text: 'x' }))).toBe(
      "Bad arguments: tool_voice_generate() missing 1 required positional argument: 'output_path'"
    )
    expect(
      failure(await run(agent, 'voice_generate', { text: 'x', output_path: 'y', nope: 1 }))
    ).toBe("Bad arguments: tool_voice_generate() got an unexpected keyword argument 'nope'")
  })

  it('voice_generate names the engine, the file and the byte count it wrote', async () => {
    const agent = await makeAgent()
    tts.chunks = [4, 8]
    const output = only(
      await run(agent, 'voice_generate', { text: 'hello parity', output_path: 'said.mp3' })
    )
    expect(output).toBe(
      'Generated speech audio: said.mp3 (12 bytes) via edge-tts (en-US-GuyNeural)'
    )
    expect(tts.calls[0]).toBe('hello parity|en-US-GuyNeural')
    expect(await readFile(join(root, 'said.mp3'))).toEqual(Buffer.alloc(12))
  })

  it('an empty voice still synthesizes at the default but is printed as empty', async () => {
    const agent = await makeAgent()
    tts.chunks = [1]
    const output = only(
      await run(agent, 'voice_generate', {
        text: 'x',
        output_path: 'said2.mp3',
        voice: '',
        rate: 200
      })
    )
    expect(output).toBe('Generated speech audio: said2.mp3 (1 bytes) via edge-tts ()')
    expect(tts.calls[0]).toBe('x|en-US-GuyNeural')
  })

  it('voice_generate denies without writing, and says no engine succeeded when the rung fails', async () => {
    const no = await makeAgent(false)
    expect(failure(await run(no, 'voice_generate', { text: 'x', output_path: 'never.mp3' }))).toBe(
      'The user denied voice generation.'
    )
    await expect(readFile(join(root, 'never.mp3'))).rejects.toThrow()

    const agent = await makeAgent()
    tts.fail = true
    expect(
      failure(await run(agent, 'voice_generate', { text: 'x', output_path: 'gone.mp3' }))
    ).toBe(
      'No TTS engine succeeded (edge unavailable). Install edge-tts, gTTS, or pyttsx3 via /pip.'
    )
    // Divergence: v1.0 would still have tried gTTS and pyttsx3 here, so its parenthetical carries
    // the pyttsx3 import error instead; neither engine is reachable from Electron without the new
    // native dependencies rule 3 reserves to the user.
    await expect(readFile(join(root, 'gone.mp3'))).rejects.toThrow()
  })
})

describe('video tools', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /**
   * The five lines `tool_video_read()` builds for each fixture, copied out of
   * `.recovered/oracle-video.txt` — the dump of what the OpenCV 5.0 build v1.0 used reports for the
   * same bytes.  `video-broken.mp4` and `video-trunc.mp4` are absent because `isOpened()` is false
   * for them, so v1.0 raises before it prints anything.
   */
  const READS: Record<string, string> = {
    'video-bmp.avi':
      'Video File: video-bmp.avi (582,542 bytes)\n' +
      '- Resolution: 160x120 px\n- Frame Rate: 10.00 FPS\n' +
      '- Total Frames: 10\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-mjpeg.avi':
      'Video File: video-mjpeg.avi (75,288 bytes)\n' +
      '- Resolution: 160x120 px\n- Frame Rate: 15.00 FPS\n' +
      '- Total Frames: 15\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-h264-30fps.mp4':
      'Video File: video-h264-30fps.mp4 (13,088 bytes)\n' +
      '- Resolution: 320x240 px\n- Frame Rate: 30.00 FPS\n' +
      '- Total Frames: 60\n- Duration: 2.00 seconds (0.03 minutes)',
    'video-h264-25fps-640x360.mp4':
      'Video File: video-h264-25fps-640x360.mp4 (11,221 bytes)\n' +
      '- Resolution: 640x360 px\n- Frame Rate: 25.00 FPS\n' +
      '- Total Frames: 25\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-h264-2997fps.mp4':
      'Video File: video-h264-2997fps.mp4 (7,839 bytes)\n' +
      '- Resolution: 176x144 px\n- Frame Rate: 29.97 FPS\n' +
      '- Total Frames: 30\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-h264.mov':
      'Video File: video-h264.mov (8,394 bytes)\n' +
      '- Resolution: 320x240 px\n- Frame Rate: 30.00 FPS\n' +
      '- Total Frames: 30\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-h264.mkv':
      'Video File: video-h264.mkv (7,886 bytes)\n' +
      '- Resolution: 320x240 px\n- Frame Rate: 24.00 FPS\n' +
      '- Total Frames: 24\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-vp8.webm':
      'Video File: video-vp8.webm (29,877 bytes)\n' +
      '- Resolution: 320x240 px\n- Frame Rate: 30.00 FPS\n' +
      '- Total Frames: 30\n- Duration: 1.00 seconds (0.02 minutes)',
    'video-single.mp4':
      'Video File: video-single.mp4 (3,721 bytes)\n' +
      '- Resolution: 320x240 px\n- Frame Rate: 30.00 FPS\n' +
      '- Total Frames: 1\n- Duration: 0.03 seconds (0.00 minutes)',
    'video-many.mp4':
      'Video File: video-many.mp4 (47,260 bytes)\n' +
      '- Resolution: 32x32 px\n- Frame Rate: 30.00 FPS\n' +
      '- Total Frames: 1,020\n- Duration: 34.00 seconds (0.57 minutes)'
  }

  for (const [name, block] of Object.entries(READS)) {
    it(`video_read reproduces every measured number for ${name}`, async () => {
      const agent = await makeAgent()
      expect(only(await run(agent, 'video_read', { path: await stage(fx(name)) }))).toBe(block)
    })
  }

  /**
   * The model call is stood in for: decision 3 pins media at content-equivalence, so what is
   * compared is how many frames reach the request, that each carries a JPEG, and the exact prompt
   * line v1.0 builds from the timestamps.
   */
  function videoStub(
    agent: Agent,
    reply: string | null = 'a timeline'
  ): { parts: string[]; prompt: string } {
    const seen = { parts: [] as string[], prompt: '' }
    agent.client.generateContent = async (_model, contents) => {
      const parts = contents[0]?.parts ?? []
      seen.parts = parts.map((part) =>
        part.inline_data
          ? `jpeg:${Buffer.from(part.inline_data.data ?? '', 'base64')
              .subarray(0, 3)
              .toString('hex')}`
          : 'text'
      )
      seen.prompt = String(parts.at(-1)?.text ?? '')
      return {
        candidates:
          reply === null ? [] : [{ content: { role: 'model', parts: [{ text: reply }] } }],
        text: reply ?? '',
        usage_metadata: null,
        raw_response: null
      }
    }
    return seen
  }

  const DEFAULT_PROMPT =
    'Analyze the video timeline, scenes, actions, UI/text on screen, and key events.'

  /** The two AVI flavours are the ones whose frames are whole BMP/JPEG files, so they decode. */
  for (const [name, stamps] of [
    ['video-bmp.avi', '0.0s, 0.1s, 0.3s, 0.5s, 0.7s, 0.9s'],
    ['video-mjpeg.avi', '0.0s, 0.1s, 0.3s, 0.5s, 0.7s, 0.9s']
  ] as [string, string][]) {
    it(`video_analyze samples ${name} at the oracle indices and sends six frames`, async () => {
      const agent = await makeAgent()
      const stub = videoStub(agent)
      const output = only(await run(agent, 'video_analyze', { path: await stage(fx(name)) }))
      expect(output).toBe(`${READS[name]}\n\nGemini Video Timeline Analysis:\na timeline`)
      expect(stub.parts).toEqual(
        Array.from({ length: 7 }, (_, i) => (i < 6 ? 'jpeg:ffd8ff' : 'text'))
      )
      expect(stub.prompt).toBe(
        `These are 6 keyframes sampled at ${stamps} from ${name}.\n${DEFAULT_PROMPT}`
      )
    })
  }

  it('video_analyze samples the same indices v1.0 prints for a smaller and a larger count', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('video-bmp.avi'))

    const three = videoStub(agent)
    expect(only(await run(agent, 'video_analyze', { path: staged, sample_frames: 3 }))).toContain(
      'Gemini Video Timeline Analysis:\na timeline'
    )
    expect(three.prompt).toBe(
      'These are 3 keyframes sampled at 0.0s, 0.4s, 0.9s from video-bmp.avi.\n' + DEFAULT_PROMPT
    )
    expect(three.parts).toEqual(['jpeg:ffd8ff', 'jpeg:ffd8ff', 'jpeg:ffd8ff', 'text'])

    const asked = videoStub(agent)
    expect(
      only(await run(agent, 'video_analyze', { path: staged, prompt: 'What happens?' }))
    ).toContain('Gemini Video Timeline Analysis:')
    expect(asked.prompt.endsWith('from video-bmp.avi.\nWhat happens?')).toBe(true)

    // `max(2, min(int(sample_frames or 6), 12))`: 0 is falsy so the default re-appears, 20 clamps
    // to 12, and a repeated index re-reads the same frame because `set()` seeks absolutely.
    const zero = videoStub(agent)
    expect(only(await run(agent, 'video_analyze', { path: staged, sample_frames: 0 }))).toContain(
      '- Total Frames: 10\n'
    )
    expect(zero.prompt).toBe(
      'These are 6 keyframes sampled at 0.0s, 0.1s, 0.3s, 0.5s, 0.7s, 0.9s from video-bmp.avi.\n' +
        DEFAULT_PROMPT
    )
    expect(zero.parts.length).toBe(7)

    const twelve = videoStub(agent)
    expect(only(await run(agent, 'video_analyze', { path: staged, sample_frames: 20 }))).toContain(
      '- Total Frames: 10\n'
    )
    expect(twelve.prompt).toBe(
      'These are 12 keyframes sampled at 0.0s, 0.0s, 0.1s, 0.2s, 0.3s, 0.4s, 0.4s, 0.5s, 0.6s, ' +
        '0.7s, 0.8s, 0.9s from video-bmp.avi.\n' +
        DEFAULT_PROMPT
    )
    expect(twelve.parts.length).toBe(13)
  })

  it('a sample count of 1 still sends two keyframes', async () => {
    const agent = await makeAgent()
    const stub = videoStub(agent)
    expect(
      only(
        await run(agent, 'video_analyze', {
          path: await stage(fx('video-bmp.avi')),
          sample_frames: 1
        })
      )
    ).toContain('Gemini Video Timeline Analysis:\na timeline')
    expect(stub.prompt).toBe(
      `These are 2 keyframes sampled at 0.0s, 0.9s from video-bmp.avi.\n${DEFAULT_PROMPT}`
    )
    expect(stub.parts.length).toBe(3)
  })

  it('an empty model answer leaves the analysis block empty', async () => {
    const agent = await makeAgent()
    videoStub(agent, null)
    expect(
      only(await run(agent, 'video_analyze', { path: await stage(fx('video-mjpeg.avi')) }))
    ).toBe(`${READS['video-mjpeg.avi']}\n\nGemini Video Timeline Analysis:\n`)
  })

  /**
   * Divergence: H.264/HEVC/VP8/VP9/AV1 need a video decoder and rule 3 keeps this port from adding
   * one, so every frame tool lands on v1.0's own failure branch instead.  `video-single.mp4` is the
   * one file whose count differs — v1.0 decodes its single frame and reports 1 — which is why it is
   * asserted here rather than folded into the shared text.
   */
  const NO_DECODER = [
    'video-h264-30fps.mp4',
    'video-h264-25fps-640x360.mp4',
    'video-h264-2997fps.mp4',
    'video-h264.mov',
    'video-h264.mkv',
    'video-vp8.webm',
    'video-single.mp4',
    'video-many.mp4'
  ]

  for (const name of NO_DECODER) {
    it(`video_analyze takes v1.0 own decode failure for ${name}`, async () => {
      const agent = await makeAgent()
      const stub = videoStub(agent)
      expect(failure(await run(agent, 'video_analyze', { path: await stage(fx(name)) }))).toBe(
        'Could not decode frames from video.'
      )
      expect(stub.parts).toEqual([])
    })
  }

  it('video_read and video_analyze refuse the files cv2 will not open', async () => {
    const agent = await makeAgent()
    for (const name of ['video-broken.mp4', 'video-trunc.mp4']) {
      const staged = await stage(fx(name))
      expect(failure(await run(agent, 'video_read', { path: staged }))).toBe(
        `Could not open video stream: ${staged}`
      )
      expect(failure(await run(agent, 'video_analyze', { path: staged }))).toBe(
        `Could not open video file: ${staged}`
      )
    }
  })

  it('an audio-only MP4 is the one container this port calls unopenable', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('video-audio-only.mp4'))
    // Divergence: v1.0 opens it and prints `0x0 px / 1.00 FPS / -1 frames / -1.00 seconds` from the
    // audio track's own index (and its read loop never returns), while a container with no video
    // track is simply not openable here.
    expect(failure(await run(agent, 'video_read', { path: staged }))).toBe(
      `Could not open video stream: ${staged}`
    )
  })

  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  function pngSize(data: Buffer): { width: number; height: number } {
    expect(data.subarray(0, 8)).toEqual(PNG_HEAD)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }

  /** `f_idx` per row, straight from the oracle `extract n=8 names=` lines. */
  for (const [name, frames] of [
    ['video-bmp.avi', [0, 1, 2, 3, 5, 6, 7, 9]],
    ['video-mjpeg.avi', [0, 2, 4, 6, 8, 10, 12, 14]]
  ] as [string, number[]][]) {
    it(`video_extract_frames writes the eight PNGs ${name} names`, async () => {
      const agent = await makeAgent()
      const staged = await stage(fx(name))
      const output = only(
        await run(agent, 'video_extract_frames', { path: staged, output_dir: 'frames' })
      )
      const names = frames.map((f, i) => `frame_${String(i + 1).padStart(2, '0')}_f${f}.png`)
      expect(output).toBe(
        `Extracted 8 frame(s) into frames:\n${names.map((n) => `frames/${n}`).join('\n')}`
      )
      for (const file of names) {
        const data = await readFile(join(root, 'frames', file))
        expect(pngSize(data)).toEqual({ width: 160, height: 120 })
      }
    })
  }

  it('video_extract_frames honours the count clamp and its falsy default', async () => {
    const agent = await makeAgent()
    const staged = await stage(fx('video-mjpeg.avi'))
    expect(
      only(
        await run(agent, 'video_extract_frames', { path: staged, output_dir: 'three', count: 3 })
      )
    ).toBe(
      'Extracted 3 frame(s) into three:\nthree/frame_01_f0.png\nthree/frame_02_f7.png\n' +
        'three/frame_03_f14.png'
    )
    expect(
      only(await run(agent, 'video_extract_frames', { path: staged, output_dir: 'one', count: 1 }))
    ).toBe('Extracted 1 frame(s) into one:\none/frame_01_f0.png')
    // `max(1, min(int(count or 8), 30))`: 0 falls back to 8, so the default list comes back.
    expect(
      only(await run(agent, 'video_extract_frames', { path: staged, output_dir: 'zero', count: 0 }))
    ).toContain('Extracted 8 frame(s) into zero:\nzero/frame_01_f0.png')
  })

  it('video_extract_frames makes the directory and reports zero frames without a decoder', async () => {
    const agent = await makeAgent()
    for (const name of NO_DECODER.filter((n) => n !== 'video-single.mp4')) {
      const dir = `out-${name.replace(/[^a-z0-9]/gu, '-')}`
      expect(
        only(
          await run(agent, 'video_extract_frames', { path: await stage(fx(name)), output_dir: dir })
        )
      ).toBe(`Extracted 0 frame(s) into ${dir}:\n`)
      expect(await readdir(join(root, dir))).toEqual([])
    }
    // Parity quirk: this tool never checks `isOpened()`, so an unopenable file still makes its
    // directory and answers zero frames — the same two lines v1.0 prints.
    for (const name of ['video-broken.mp4', 'video-trunc.mp4']) {
      expect(
        only(
          await run(agent, 'video_extract_frames', {
            path: await stage(fx(name)),
            output_dir: 'unopenable'
          })
        )
      ).toBe('Extracted 0 frame(s) into unopenable:\n')
    }
  })

  it('video_extract_frames denies before the directory exists', async () => {
    const agent = await makeAgent(false)
    const staged = await stage(fx('video-bmp.avi'))
    expect(
      failure(await run(agent, 'video_extract_frames', { path: staged, output_dir: 'never' }))
    ).toBe('The user denied frame extraction.')
    await expect(readdir(join(root, 'never'))).rejects.toThrow()
  })

  it('video tools report a missing file and a bad signature the way v1.0 does', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'video_read', { path: 'nope.mp4' }))).toBe(
      'Video file not found: nope.mp4'
    )
    expect(failure(await run(agent, 'video_analyze', { path: 'nope.mp4' }))).toBe(
      'Video file not found: nope.mp4'
    )
    expect(
      failure(await run(agent, 'video_extract_frames', { path: 'nope.mp4', output_dir: 'o' }))
    ).toBe('Video file not found: nope.mp4')
    expect(failure(await run(agent, 'video_read', {}))).toBe(
      "Bad arguments: tool_video_read() missing 1 required positional argument: 'path'"
    )
    expect(failure(await run(agent, 'video_analyze', { path: 'a.mp4', nope: 1 }))).toBe(
      "Bad arguments: tool_video_analyze() got an unexpected keyword argument 'nope'"
    )
    expect(failure(await run(agent, 'video_extract_frames', { path: 'a.mp4' }))).toBe(
      "Bad arguments: tool_video_extract_frames() missing 1 required positional argument: 'output_dir'"
    )
  })
})

/**
 * Every expectation here is copied from `.recovered/oracle-sqlite.txt` (values),
 * `.recovered/oracle-sqlite-scan.txt` (statement boundaries) and
 * `.recovered/oracle-sqlite-errors.txt` (exception classes), which are the dumps of
 * `tool_sqlite_query()` running against `tests/fixtures/data-sample.db`.
 */
describe('sqlite_query', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /** The 100-plus statements all share one header line, so spell it out once. */
  const SELECT_ONE = '1\n---\n1\n[1 row(s)]'

  /**
   * Row-returning statements and the block v1.0 printed for them: the header is
   * `sqlite3_column_name()`, the dashes are one per column, and each cell is Python's `str()` of
   * the value — `None`, `int` without a decimal point, `float` with `repr()`, `bytes` as `b'…'`.
   */
  const ROWS: [string, string][] = [
    [
      'SELECT * FROM users',
      "id | name | score | active | note | payload\n--- | --- | --- | --- | --- | ---\n1 | Ada | 3.5 | 1 | None | b'\\x00\\xff\\x10'\n2 | 鲍思 | 7.0 | 0 | it's ok | b'BM'\n3 | O'Neil | -2.25 | 1 |  | None\n4 | wide  space | 100.0 | 1 | multi\nline | b'\\n'\n5 | None | None | None | None | None\n6 | tab\there | 0.1 | 1 | b\u0000c | b'\\x00\\x01\\x02'\n[6 row(s)]"
    ],
    [
      'SELECT id, name FROM users WHERE active = 1 ORDER BY id',
      "id | name\n--- | ---\n1 | Ada\n3 | O'Neil\n4 | wide  space\n6 | tab\there\n[4 row(s)]"
    ],
    [
      'SELECT n FROM numbers',
      'n\n---\n0.0\n0.0\n1.0\n0.1\n1e+20\n1e-07\n0.3333333333333333\n1.4999999999999998e+300\n-3.75\n123456789.1234567\n[10 row(s)]'
    ],
    ['SELECT n FROM big', 'n\n---\n9223372036854775807\n-9223372036854775808\n0\n[3 row(s)]'],
    ['SELECT * FROM weird', 'a b | quoted | bracket\n--- | --- | ---\nx | y | z\n[1 row(s)]'],
    ['SELECT 1, 1', '1 | 1\n--- | ---\n1 | 1\n[1 row(s)]'],
    ['SELECT "a b" AS x, "quoted" AS x FROM weird', 'x | x\n--- | ---\nx | y\n[1 row(s)]'],
    [
      'SELECT id, score * 2, name FROM users WHERE id = 1',
      'id | score * 2 | name\n--- | --- | ---\n1 | 7.0 | Ada\n[1 row(s)]'
    ],
    [
      "SELECT 1 AS one, 2.0, 'three'",
      "one | 2.0 | 'three'\n--- | --- | ---\n1 | 2.0 | three\n[1 row(s)]"
    ],
    [
      'SELECT NULL, NULL, NULL',
      'NULL | NULL | NULL\n--- | --- | ---\nNone | None | None\n[1 row(s)]'
    ],
    [
      'PRAGMA table_info(users)',
      'cid | name | type | notnull | dflt_value | pk\n--- | --- | --- | --- | --- | ---\n0 | id | INTEGER | 0 | None | 1\n1 | name | TEXT | 0 | None | 0\n2 | score | REAL | 0 | None | 0\n3 | active | INTEGER | 0 | None | 0\n4 | note | TEXT | 0 | None | 0\n5 | payload | BLOB | 0 | None | 0\n[6 row(s)]'
    ],
    ['PRAGMA integrity_check', 'integrity_check\n---\nok\n[1 row(s)]'],
    [
      'EXPLAIN SELECT * FROM users',
      'addr | opcode | p1 | p2 | p3 | p4 | p5 | comment\n--- | --- | --- | --- | --- | --- | --- | ---\n' +
        '0 | Init | 0 | 13 | 0 | None | 0 | None\n1 | OpenRead | 0 | 2 | 0 | 6 | 0 | None\n' +
        '2 | Rewind | 0 | 12 | 0 | None | 0 | None\n3 | Rowid | 0 | 1 | 0 | None | 0 | None\n' +
        '4 | Column | 0 | 1 | 2 | None | 0 | None\n5 | Column | 0 | 2 | 3 | None | 0 | None\n' +
        '6 | RealAffinity | 3 | 0 | 0 | None | 0 | None\n7 | Column | 0 | 3 | 4 | None | 0 | None\n' +
        '8 | Column | 0 | 4 | 5 | None | 0 | None\n9 | Column | 0 | 5 | 6 | None | 0 | None\n' +
        '10 | ResultRow | 1 | 6 | 0 | None | 0 | None\n11 | Next | 0 | 3 | 0 | None | 1 | None\n' +
        '12 | Halt | 0 | 0 | 0 | None | 0 | None\n13 | Transaction | 0 | 0 | 5 | 0 | 1 | None\n' +
        '14 | Goto | 0 | 1 | 0 | None | 0 | None\n[15 row(s)]'
    ],
    ['WITH t AS (SELECT 1 AS x) SELECT * FROM t', 'x\n---\n1\n[1 row(s)]'],
    ['SELECT payload FROM users WHERE id = 1', "payload\n---\nb'\\x00\\xff\\x10'\n[1 row(s)]"],
    ["SELECT X'41', typeof(X'41')", "X'41' | typeof(X'41')\n--- | ---\nb'A' | blob\n[1 row(s)]"],
    ["SELECT 'a' || char(0) || 'b'", "'a' || char(0) || 'b'\n---\na\u0000b\n[1 row(s)]"],
    ['SELECT count(*) FROM many', 'count(*)\n---\n250\n[1 row(s)]'],
    // The `int`/`float` split, which is what `setReadBigInts()` exists to keep.
    ['SELECT -0.0', '-0.0\n---\n-0.0\n[1 row(s)]'],
    ['SELECT 1/0', '1/0\n---\nNone\n[1 row(s)]'],
    ['SELECT 3/2', '3/2\n---\n1\n[1 row(s)]'],
    ['SELECT 1.0*1', '1.0*1\n---\n1.0\n[1 row(s)]'],
    ['SELECT 0.1+0.2', '0.1+0.2\n---\n0.30000000000000004\n[1 row(s)]'],
    ['SELECT abs(-2)', 'abs(-2)\n---\n2\n[1 row(s)]'],
    ['SELECT round(2.5)', 'round(2.5)\n---\n3.0\n[1 row(s)]'],
    ["SELECT hex(x'00ff')", "hex(x'00ff')\n---\n00FF\n[1 row(s)]"],
    ['SELECT sum(i) FROM many', 'sum(i)\n---\n31375\n[1 row(s)]'],
    ['SELECT total(i) FROM many', 'total(i)\n---\n31375.0\n[1 row(s)]'],
    [
      'SELECT max(score), min(score), avg(score) FROM users',
      'max(score) | min(score) | avg(score)\n--- | --- | ---\n100.0 | -2.25 | 21.669999999999998\n[1 row(s)]'
    ],
    [
      'SELECT 9223372036854775807 + 1',
      '9223372036854775807 + 1\n---\n9.223372036854776e+18\n[1 row(s)]'
    ],
    [
      'SELECT 9223372036854775807 / 2',
      '9223372036854775807 / 2\n---\n4611686018427387903\n[1 row(s)]'
    ],
    ['SELECT 1e20', '1e20\n---\n1e+20\n[1 row(s)]'],
    ['SELECT 1e15', '1e15\n---\n1000000000000000.0\n[1 row(s)]'],
    ['SELECT 1e16', '1e16\n---\n1e+16\n[1 row(s)]'],
    ['SELECT 1e-7', '1e-7\n---\n1e-07\n[1 row(s)]'],
    ['SELECT 1e-4', '1e-4\n---\n0.0001\n[1 row(s)]'],
    ['SELECT 10e10', '10e10\n---\n100000000000.0\n[1 row(s)]'],
    ['SELECT 123456789012345678', '123456789012345678\n---\n123456789012345678\n[1 row(s)]'],
    [
      "SELECT CAST('12345678901234567890' AS INTEGER)",
      "CAST('12345678901234567890' AS INTEGER)\n---\n9223372036854775807\n[1 row(s)]"
    ],
    ["SELECT CAST('x' AS REAL)", "CAST('x' AS REAL)\n---\n0.0\n[1 row(s)]"],
    ["SELECT '1' + 1, '1' || 1", "'1' + 1 | '1' || 1\n--- | ---\n2 | 11\n[1 row(s)]"],
    [
      "SELECT typeof(1), typeof(1.0), typeof('1'), typeof(x'01')",
      "typeof(1) | typeof(1.0) | typeof('1') | typeof(x'01')\n--- | --- | --- | ---\ninteger | real | text | blob\n[1 row(s)]"
    ],
    [
      "SELECT quote('a''b'), quote(NULL), quote(1.0), quote(x'00')",
      "quote('a''b') | quote(NULL) | quote(1.0) | quote(x'00')\n--- | --- | --- | ---\n'a''b' | NULL | 1.0 | X'00'\n[1 row(s)]"
    ],
    [
      "SELECT x'4142', CAST(x'4142' AS TEXT), char(65, 66)",
      "x'4142' | CAST(x'4142' AS TEXT) | char(65, 66)\n--- | --- | ---\nb'AB' | AB | AB\n[1 row(s)]"
    ],
    ['SELECT zeroblob(3)', "zeroblob(3)\n---\nb'\\x00\\x00\\x00'\n[1 row(s)]"],
    ['SELECT 1 UNION SELECT 2;', '1\n---\n1\n2\n[2 row(s)]'],
    ['VALUES (1)', 'column1\n---\n1\n[1 row(s)]'],
    // Statements with a tail that is only trivia, which v1.0 accepts.
    ['SELECT 1; ', SELECT_ONE],
    ['SELECT 1; -- hi', SELECT_ONE],
    ['SELECT 1; -- hi\n', SELECT_ONE],
    ['SELECT 1; /* hi */', SELECT_ONE],
    ['SELECT 1; /* x', SELECT_ONE],
    ['SELECT 1; --', SELECT_ONE],
    ['SELECT 1; /*x*/ /*y*/', SELECT_ONE],
    ['  SELECT  1  ;  ', SELECT_ONE],
    [';SELECT 1', SELECT_ONE],
    ['\n\t SELECT 1', SELECT_ONE],
    ['/* c */ SELECT 1', SELECT_ONE],
    ["SELECT 'a;b'", "'a;b'\n---\na;b\n[1 row(s)]"],
    ["SELECT 'a;b';", "'a;b'\n---\na;b\n[1 row(s)]"],
    ["SELECT '; ' ", "'; '\n---\n; \n[1 row(s)]"],
    ['SELECT 1 /* ; */', '1 /* ; */\n---\n1\n[1 row(s)]'],
    ['SELECT 1 /* unterminated', '1 /* unterminated\n---\n1\n[1 row(s)]'],
    ['SELECT 1 --x\n;', '1 --x\n---\n1\n[1 row(s)]']
  ]

  /** Statements without a result set: the success line and whatever `cur.rowcount` held. */
  const SUCCESS: [string, string][] = [
    ['', 'Query executed successfully. Rows affected: -1'],
    [';', 'Query executed successfully. Rows affected: -1'],
    ['; ;', 'Query executed successfully. Rows affected: -1'],
    ['   ;   ', 'Query executed successfully. Rows affected: -1'],
    ['  ', 'Query executed successfully. Rows affected: -1'],
    ['\n\n\t ', 'Query executed successfully. Rows affected: -1'],
    ['-- only comment', 'Query executed successfully. Rows affected: -1'],
    ['-- only comment\n', 'Query executed successfully. Rows affected: -1'],
    ['/* only */', 'Query executed successfully. Rows affected: -1'],
    ['/* unterminated', 'Query executed successfully. Rows affected: -1'],
    ['CREATE TABLE tmp(a)', 'Query executed successfully. Rows affected: -1'],
    ['DROP TABLE users', 'Query executed successfully. Rows affected: -1'],
    ['CREATE INDEX ix ON users(name)', 'Query executed successfully. Rows affected: -1'],
    ['DROP INDEX IF EXISTS nope', 'Query executed successfully. Rows affected: -1'],
    ['CREATE VIEW v AS SELECT 1', 'Query executed successfully. Rows affected: -1'],
    ['BEGIN', 'Query executed successfully. Rows affected: -1'],
    ['SAVEPOINT s', 'Query executed successfully. Rows affected: -1'],
    ['VACUUM', 'Query executed successfully. Rows affected: -1'],
    ['ANALYZE', 'Query executed successfully. Rows affected: -1'],
    // A `WITH` that writes still reports -1: only the four DML keywords fill rowcount in.
    [
      'WITH t AS (SELECT 1 AS x) INSERT INTO big (n) SELECT x FROM t',
      'Query executed successfully. Rows affected: -1'
    ],
    [';INSERT INTO big (n) VALUES (1)', 'Query executed successfully. Rows affected: -1'],
    [
      "INSERT INTO users (id, name) VALUES (99, 'new')",
      'Query executed successfully. Rows affected: 1'
    ],
    [
      'INSERT INTO users (id, name) SELECT id + 1000, name FROM users',
      'Query executed successfully. Rows affected: 6'
    ],
    [
      "INSERT OR IGNORE INTO users (id, name) VALUES (1, 'x')",
      'Query executed successfully. Rows affected: 0'
    ],
    ['INSERT INTO big (n) VALUES (1); ', 'Query executed successfully. Rows affected: 1'],
    [
      "INSERT OR REPLACE INTO users (id, name) VALUES (1, 'replaced')",
      'Query executed successfully. Rows affected: 1'
    ],
    [
      "REPLACE INTO users (id, name) VALUES (1, 'rp')",
      'Query executed successfully. Rows affected: 1'
    ],
    ["UPDATE users SET note = 'x'", 'Query executed successfully. Rows affected: 6'],
    [
      "UPDATE users SET note = 'x' WHERE id = 4242",
      'Query executed successfully. Rows affected: 0'
    ],
    [
      "UPDATE users SET name = 'x' WHERE id IN (SELECT id FROM users)",
      'Query executed successfully. Rows affected: 6'
    ],
    ['DELETE FROM users WHERE id > 3', 'Query executed successfully. Rows affected: 3'],
    ['DELETE FROM users', 'Query executed successfully. Rows affected: 6'],
    // A comment before the keyword is trivia for the rowcount check, a semicolon is not.
    ['-- c\nINSERT INTO big (n) VALUES (1)', 'Query executed successfully. Rows affected: 1'],
    [
      'CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END',
      'Query executed successfully. Rows affected: -1'
    ],
    [
      'CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END;',
      'Query executed successfully. Rows affected: -1'
    ],
    ['DROP TRIGGER IF EXISTS t; ', 'Query executed successfully. Rows affected: -1']
  ]

  /** `type(e).__name__: e`, which is exactly what `execute()` shows for an escaping exception. */
  const FAILURES: [string, string][] = [
    ['SELECT * FROM nope', 'OperationalError: no such table: nope'],
    ['SEL 1', 'OperationalError: near "SEL": syntax error'],
    ['SELECT [a;b]', 'OperationalError: no such column: a;b'],
    ['SELECT `a;b`', 'OperationalError: no such column: a;b'],
    ['SELECT nope(1)', 'OperationalError: no such function: nope'],
    ['SELECT 1 ORDER BY 1 COLLATE nope', 'OperationalError: no such collation sequence: nope'],
    ['CREATE TABLE users (a)', 'OperationalError: table users already exists'],
    ['DROP TABLE nope', 'OperationalError: no such table: nope'],
    ['COMMIT', 'OperationalError: cannot commit - no transaction is active'],
    [
      "INSERT INTO users (id, name) VALUES (1, 'dup')",
      'IntegrityError: UNIQUE constraint failed: users.id'
    ],
    ['INSERT INTO big (n) VALUES (NULL)', 'IntegrityError: NOT NULL constraint failed: big.n'],
    [
      'INSERT INTO users (nonexistent) VALUES (1)',
      'OperationalError: table users has no column named nonexistent'
    ],
    ["INSERT INTO users (rowid, name) VALUES ('text', 'x')", 'IntegrityError: datatype mismatch'],
    ['SELECT zeroblob(9223372036854775807)', 'DataError: string or blob too big'],
    // More than one statement: CPython stops before it runs the first one.
    ['SELECT 1;;', 'ProgrammingError: You can only execute one statement at a time.'],
    ['SELECT 1 ; ;', 'ProgrammingError: You can only execute one statement at a time.'],
    ['SELECT 1; SELECT 2', 'ProgrammingError: You can only execute one statement at a time.'],
    [
      'SELECT 1; SELECT 2; SELECT 3',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    [
      'SELECT 1; /* hi */ SELECT 2',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    ['SELECT 1;--x\nSELECT 2', 'ProgrammingError: You can only execute one statement at a time.'],
    ['SELECT 1;SELECT', 'ProgrammingError: You can only execute one statement at a time.'],
    ['SELECT 1;SELECT 1 FROM (', 'ProgrammingError: You can only execute one statement at a time.'],
    [
      'SELECT 1;PRAGMA user_version',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    [
      'PRAGMA user_version;PRAGMA user_version',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    ['BEGIN; BEGIN', 'ProgrammingError: You can only execute one statement at a time.'],
    [
      'INSERT INTO big (n) VALUES (1); SELECT 1',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    [
      'CREATE TRIGGER t AFTER INSERT ON big BEGIN SELECT 1; END; SELECT 2',
      'ProgrammingError: You can only execute one statement at a time.'
    ],
    // An unterminated quote in the tail is still leftover text, so CPython stops before running.
    ["SELECT 1; '", 'ProgrammingError: You can only execute one statement at a time.'],
    ["SELECT 'unterminated", 'OperationalError: unrecognized token: "\'unterminated"'],
    ['SELECT "unterminated', 'OperationalError: unrecognized token: ""unterminated"'],
    // Python rejects the NUL before it reaches the engine.
    ['SELECT 1\u0000', 'ProgrammingError: the query contains a null character'],
    ['SEL\u0000ECT 1', 'ProgrammingError: the query contains a null character'],
    ["SELECT 'a\u0000b'", 'ProgrammingError: the query contains a null character']
  ]

  for (const [sql, expected] of ROWS) {
    it(`sqlite_query reproduces the row block for ${JSON.stringify(sql)}`, async () => {
      const agent = await makeAgent()
      const db = await stage(fx('data-sample.db'))
      expect(only(await run(agent, 'sqlite_query', { db_path: db, sql }))).toBe(expected)
    })
  }

  for (const [sql, expected] of SUCCESS) {
    it(`sqlite_query reports ${JSON.stringify(sql)} without a result set`, async () => {
      const agent = await makeAgent()
      const db = await stage(fx('data-sample.db'))
      expect(only(await run(agent, 'sqlite_query', { db_path: db, sql }))).toBe(expected)
    })
  }

  for (const [sql, expected] of FAILURES) {
    it(`sqlite_query fails ${JSON.stringify(sql)} the way execute() prints it`, async () => {
      const agent = await makeAgent()
      const db = await stage(fx('data-sample.db'))
      expect(failure(await run(agent, 'sqlite_query', { db_path: db, sql }))).toBe(expected)
    })
  }

  it('caps the row block at fetchmany(200) but counts the table honestly', async () => {
    const agent = await makeAgent()
    const db = await stage(fx('data-sample.db'))
    const lines = ['i | label', '--- | ---', '1 | first']
    for (let i = 2; i <= 200; i++) lines.push(`${i} | row${i}`)
    expect(only(await run(agent, 'sqlite_query', { db_path: db, sql: 'SELECT * FROM many' }))).toBe(
      `${lines.join('\n')}\n[200 row(s)]`
    )
    expect(
      only(await run(agent, 'sqlite_query', { db_path: db, sql: 'SELECT count(*) FROM many' }))
    ).toBe('count(*)\n---\n250\n[1 row(s)]')
  })

  it('asks only for statements that do not start with SELECT, PRAGMA or EXPLAIN', async () => {
    const asked: [string, string][] = []
    const agent = await makeAgent(false)
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    const db = await stage(fx('data-sample.db'))
    // The read keywords never reach the prompt, however the statement is padded.
    for (const sql of [' SELECT 1', 'pragma integrity_check', 'explain select 1'])
      expect(only(await run(agent, 'sqlite_query', { db_path: db, sql }))).toContain('---')
    expect(asked).toEqual([])

    for (const sql of [
      'DELETE FROM users WHERE id = 1',
      'WITH t AS (SELECT 1 AS x) INSERT INTO big (n) SELECT x FROM t',
      '-- SELECT\nSELECT 1'
    ]) {
      expect(failure(await run(agent, 'sqlite_query', { db_path: db, sql }))).toBe(
        'The user denied SQLite write query.'
      )
    }
    expect(asked.map(([tool]) => tool)).toEqual(['sqlite_query', 'sqlite_query', 'sqlite_query'])
    expect(asked[2][1]).toBe(`${db}: -- SELECT\nSELECT 1`)
  })

  it('cuts the prompt detail at the eightieth character of the statement', async () => {
    const agent = await makeAgent(false)
    const asked: string[] = []
    agent.state.onPermission = async (_tool, detail) => {
      asked.push(detail)
      return false
    }
    const db = await stage(fx('data-sample.db'))
    const sql = `INSERT INTO users (id, name) VALUES (${1}, '${'x'.repeat(120)}')`
    expect(failure(await run(agent, 'sqlite_query', { db_path: db, sql }))).toBe(
      'The user denied SQLite write query.'
    )
    expect(asked[0]).toBe(`${db}: ${sql.slice(0, 80)}`)
  })

  it('reproduces the three file shapes v1.0 met', async () => {
    const agent = await makeAgent()
    // A missing path is created empty before the first read, so the error is about the table.
    expect(
      failure(await run(agent, 'sqlite_query', { db_path: 'nope.db', sql: 'SELECT * FROM nope' }))
    ).toBe('OperationalError: no such table: nope')
    const created = await readFile(join(root, 'nope.db'))
    expect(created.length).toBe(0)

    await mkdir(join(root, 'adir'), { recursive: true })
    expect(failure(await run(agent, 'sqlite_query', { db_path: 'adir', sql: 'SELECT 1' }))).toBe(
      'OperationalError: unable to open database file'
    )

    await writeFile(join(root, 'junk.db'), 'this is not a database at all\n')
    expect(failure(await run(agent, 'sqlite_query', { db_path: 'junk.db', sql: 'SELECT 1' }))).toBe(
      'DatabaseError: file is not a database'
    )
    expect(
      failure(await run(agent, 'sqlite_query', { db_path: 'junk.db', sql: 'CREATE TABLE a(b)' }))
    ).toBe('DatabaseError: file is not a database')
  })

  it('keeps the python binding and re.match errors in the Bad arguments line', async () => {
    const agent = await makeAgent()
    const db = await stage(fx('data-sample.db'))
    expect(failure(await run(agent, 'sqlite_query', { sql: 'SELECT 1' }))).toBe(
      "Bad arguments: tool_sqlite_query() missing 1 required positional argument: 'db_path'"
    )
    expect(failure(await run(agent, 'sqlite_query', { db_path: db }))).toBe(
      "Bad arguments: tool_sqlite_query() missing 1 required positional argument: 'sql'"
    )
    expect(failure(await run(agent, 'sqlite_query', { db_path: db, query: 'SELECT 1' }))).toBe(
      "Bad arguments: tool_sqlite_query() got an unexpected keyword argument 'query'"
    )

    // `re.match()` fails before the gate, so the type name is what the model reads.
    for (const [value, name] of [
      [7, 'int'],
      [1.5, 'float'],
      [true, 'bool'],
      [null, 'NoneType'],
      [['SELECT 1'], 'list'],
      [{ a: 1 }, 'dict']
    ] as [unknown, string][]) {
      expect(failure(await run(agent, 'sqlite_query', { db_path: db, sql: value }))).toBe(
        `Bad arguments: expected string or bytes-like object, got '${name}'`
      )
    }
    expect(
      failure(await run(agent, 'sqlite_query', { db_path: db, sql: Buffer.from('SELECT 1') }))
    ).toBe('Bad arguments: cannot use a string pattern on a bytes-like object')
  })

  it('diverges on the two engine settings this build cannot change', async () => {
    const agent = await makeAgent()
    const db = await stage(fx('data-sample.db'))

    // Divergence: v1.0's engine was built with double-quoted string literals enabled, so
    // `SELECT "a;b"` printed `a;b`.  Node's SQLite sets SQLITE_DQS=0 and answers with its own hint.
    expect(failure(await run(agent, 'sqlite_query', { db_path: db, sql: 'SELECT "a;b"' }))).toBe(
      'OperationalError: no such column: "a;b" - should this be a string literal in single-quotes?'
    )

    // Divergence: the bundled engine is newer, so the version string is the one thing in the row
    // block that cannot match; the shape around it still has to.
    const version = only(
      await run(agent, 'sqlite_query', { db_path: db, sql: 'SELECT sqlite_version()' })
    )
    expect(version.split('\n')[0]).toBe('sqlite_version()')
    expect(version.split('\n')[1]).toBe('---')
    expect(version.split('\n')[3]).toBe('[1 row(s)]')
    expect(/^\d+\.\d+\.\d+$/.test(version.split('\n')[2] as string)).toBe(true)

    // Divergence: a TEXT column holding bytes that are not valid UTF-8 is an error for Python's
    // decoder and replacement characters for node's.
    const setup = await stage(fx('data-sample.db'))
    expect(
      only(await run(agent, 'sqlite_query', { db_path: setup, sql: 'CREATE TABLE bad (a TEXT)' }))
    ).toBe('Query executed successfully. Rows affected: -1')
    expect(
      only(
        await run(agent, 'sqlite_query', {
          db_path: setup,
          sql: "INSERT INTO bad (a) VALUES (CAST(x'ffff' AS TEXT))"
        })
      )
    ).toBe('Query executed successfully. Rows affected: 1')
    // v1.0 raised `OperationalError: Could not decode to UTF-8 column 'a' with text ''`.
    expect(
      only(await run(agent, 'sqlite_query', { db_path: setup, sql: 'SELECT a FROM bad' }))
    ).toBe('a\n---\n\uFFFD\uFFFD\n[1 row(s)]')

    // Divergence: 3.50.4 parsed this float literal one unit in the last place low, so `str()`
    // showed the long form.  The engine shipped here rounds the literal correctly.
    expect(only(await run(agent, 'sqlite_query', { db_path: db, sql: 'SELECT 1.5e300' }))).toBe(
      '1.5e300\n---\n1.5e+300\n[1 row(s)]'
    )
  })
})

describe('csv_analyze', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  it('is the excel analyzer under its own name', async () => {
    const agent = await makeAgent()
    const path = await stage(fx('oracle-sample.csv'))
    expect(only(await run(agent, 'csv_analyze', { path }))).toBe(
      only(await run(agent, 'excel_analyze', { path }))
    )
    expect(only(await run(agent, 'csv_analyze', { path }))).toContain(
      'Spreadsheet Analysis: oracle-sample.csv'
    )
  })

  it('reports a missing file with the delegated wording and its own signature', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'csv_analyze', { path: 'nope.csv' }))).toBe(
      'Spreadsheet not found: nope.csv'
    )
    expect(failure(await run(agent, 'csv_analyze', {}))).toBe(
      "Bad arguments: tool_csv_analyze() missing 1 required positional argument: 'path'"
    )
    expect(failure(await run(agent, 'csv_analyze', { path: 'a.csv', sep: ',' }))).toBe(
      "Bad arguments: tool_csv_analyze() got an unexpected keyword argument 'sep'"
    )
  })
})

/**
 * `tool_archive_manage()` and `tool_qr_generate()`.  Everything these two answer with comes out of
 * `zipfile`, `tarfile` and `qrcode`/`Pillow`, so the expectations below are the frozen output of
 * `tools/parity/probe-archive-qr.py`, `probe-archive-qr2.py`, `probe-archive-edge.py` and
 * `make-archive-fixtures.py` — including the quirks that read like bugs: zipping a path that does
 * not exist writes an empty archive and calls it a success, the tar path carries every ignored
 * directory the zip path drops, and `data[:80]` is only reached after the PNG has been written.
 */

/** Every path under `base`, relative, POSIX, with a trailing slash on a directory. */
async function treeOf(base: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        out.push(`${rel}/`)
        await walk(join(dir, entry.name), `${rel}/`)
      } else out.push(rel)
    }
  }
  await walk(base, '')
  return out.sort()
}

/** The names an archive holds, in stored order. */
async function zipNames(path: string): Promise<string[]> {
  return Object.keys((await JSZip.loadAsync(await readFile(path))).files)
}

describe('archive_manage', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /** `src/` with two files, a nested file and three directories `IGNORED` covers. */
  async function stageTree(): Promise<string> {
    await writeAt(join(root, 'src', 'a.txt'), 'a\n')
    await writeAt(join(root, 'src', 'm.txt'), 'm\n')
    await writeAt(join(root, 'src', 'sub', 'b.txt'), 'b\n')
    await writeAt(join(root, 'src', '.git', 'config'), 'git\n')
    await writeAt(join(root, 'src', 'node_modules', 'dep.json'), '{}\n')
    await writeAt(join(root, 'src', 'sub', '.gemibot', 'session.json'), '{}\n')
    await writeAt(join(root, 'src', 'keep', 'env.txt'), 'env\n')
    return 'src'
  }

  it('zips a tree in walk order with posix names and no directory entries', async () => {
    const agent = await makeAgent()
    const src = await stageTree()
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: src,
          destination: 'out/dir.zip'
        })
      )
    ).toBe('Created ZIP archive out/dir.zip')
    const names = await zipNames(join(root, 'out', 'dir.zip'))
    // `.git`, `node_modules` and `.gemibot` are matched against every component of the absolute
    // path, while `keep/env.txt` and `dist-like` are not: only a component spelled exactly as an
    // `IGNORED` member counts.
    expect(new Set(names)).toEqual(new Set(['a.txt', 'm.txt', 'keep/env.txt', 'sub/b.txt']))
    // `Path.rglob('*')` yields a directory's own entries before it descends into it, so the nested
    // member is last rather than sorted next to its parent.
    expect(names.at(-1)).toBe('sub/b.txt')
    expect(names).not.toContain('sub/')
    const zip = await JSZip.loadAsync(await readFile(join(root, 'out', 'dir.zip')))
    expect(await zip.file('keep/env.txt')?.async('string')).toBe('env\n')
  })

  it('accepts the casing and padding of the four action names', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'one.txt'), 'one\n')
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: ' ZIP ',
          source: 'one.txt',
          destination: 'one.zip'
        })
      )
    ).toBe('Created ZIP archive one.zip')
    expect(new Set(await zipNames(join(root, 'one.zip')))).toEqual(new Set(['one.txt']))
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'UnZip',
          source: 'one.zip',
          destination: 'out'
        })
      )
    ).toBe('Extracted one.zip to out')
    expect(await treeOf(join(root, 'out'))).toEqual(['one.txt'])
  })

  it('writes an empty archive for a source that does not exist', async () => {
    const agent = await makeAgent()
    // `src.is_file()` is false and `rglob()` over a missing directory yields nothing, so the tool
    // reports success for an archive that holds no member at all.
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'nope',
          destination: 'miss.zip'
        })
      )
    ).toBe('Created ZIP archive miss.zip')
    expect((await stat(join(root, 'miss.zip'))).size).toBe(22)
    expect(await zipNames(join(root, 'miss.zip'))).toEqual([])
  })

  it('keeps a member for a single file named after its base name', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'deep', 'one.txt'), 'one\n')
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'deep/one.txt',
          destination: 'd/one.zip'
        })
      )
    ).toBe('Created ZIP archive d/one.zip')
    expect(await zipNames(join(root, 'd', 'one.zip'))).toEqual(['one.txt'])
  })

  it('names the colliding component when a mkdir is blocked by a file', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'block.txt'), 'x\n')
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'block.txt',
          destination: 'block.txt/z.zip'
        })
      )
    ).toBe(
      `FileExistsError: [WinError 183] Cannot create a file when that file already exists: '${join(root, 'block.txt')}'`
    )
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'unzip',
          source: 'block.txt',
          destination: 'block.txt'
        })
      )
    ).toBe(
      `FileExistsError: [WinError 183] Cannot create a file when that file already exists: '${join(root, 'block.txt')}'`
    )
  })

  it('refuses the timestamps a zip header cannot carry and leaves the partial archive', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'old.txt'), 'old\n')
    // The DOS field is built from the *local* year, so these dates are made in local time too — the
    // same instant read in another zone would cross the boundary on one side and not the other.
    await utimes(join(root, 'old.txt'), 0, new Date(1979, 5, 1).getTime() / 1000)
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'old.txt',
          destination: 'old.zip'
        })
      )
    ).toBe('ValueError: ZIP does not support timestamps before 1980')
    // `ZipFile(dst, 'w')` had already made the file and `close()` ran on the way out, so what is
    // left is the archive the accepted members add up to — here, an empty one.
    expect((await stat(join(root, 'old.zip'))).size).toBe(22)

    // The largest mtime the file system will take here, which is the last one under the 32-bit
    // seconds the platform stores — see the DOS year gate test below for the ceiling above it.
    await utimes(join(root, 'old.txt'), 0, new Date(2106, 1, 1).getTime() / 1000)
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'old.txt',
          destination: 'last.zip'
        })
      )
    ).toBe('Created ZIP archive last.zip')
    expect(await zipNames(join(root, 'last.zip'))).toEqual(['old.txt'])
  })

  it('runs out of the DOS year bits one year past the readable ceiling', () => {
    // Reaching this through `execute()` needs a member whose mtime reads as 2108 or later, and
    // `fs.utimes()` truncates the seconds it is handed to 32 bits on Windows, so the file system
    // cannot be given one — 2106-02-07 is the last mtime it accepts.  `zipfile` still meets the
    // case, so the gate is asserted on the year field it packs.
    const gate = (year: number): string => {
      try {
        checkZipDate(new Date(year, 5, 1))
        return 'none'
      } catch (error) {
        return `${(error as PythonError).name}: ${(error as PythonError).message}`
      }
    }
    expect(gate(1979)).toBe('ValueError: ZIP does not support timestamps before 1980')
    expect(gate(1980)).toBe('none')
    expect(gate(2107)).toBe('none')
    expect(gate(2108)).toBe("error: 'H' format requires 0 <= number <= 65535")
  })

  it('extracts the tree the v1.0 zipfile wrote, in stored order', async () => {
    const agent = await makeAgent()
    const zip = await stage(fx('v1-tree.zip'))
    expect(
      only(await run(agent, 'archive_manage', { action: 'unzip', source: zip, destination: 'u' }))
    ).toBe('Extracted v1-tree.zip to u')
    expect(await treeOf(join(root, 'u'))).toEqual([
      'alpha.txt',
      'dist-like/',
      'dist-like/x.txt',
      'empty_dir/',
      'empty_dir/.keep',
      'keep/',
      'keep/env.txt',
      'sub/',
      'sub/alpha.txt',
      'sub/beta.txt',
      'sub/deep/',
      'sub/deep/gamma.txt',
      'zulu.txt',
      'ünīcode.txt'
    ])
    expect(await readFile(join(root, 'u', 'sub', 'deep', 'gamma.txt'), 'utf8')).toBe('gamma\n')
  })

  it('maps every hostile stored name into the destination the way extractall does', async () => {
    const agent = await makeAgent()
    const zip = await stage(fx('v1-hostile.zip'))
    expect(
      only(await run(agent, 'archive_manage', { action: 'unzip', source: zip, destination: 'h' }))
    ).toBe('Extracted v1-hostile.zip to h')
    // Drive letters, leading roots, `.` and `..` are dropped component-wise — so `a/../../kept.txt`
    // lands in `a/kept.txt`, never above the destination — and Windows-illegal characters become
    // `_`, while a trailing dot or space is trimmed by the file system.
    expect(await treeOf(join(root, 'h'))).toEqual([
      'a/',
      'a/kept.txt',
      'abs.txt',
      'back/',
      'back/slash.txt',
      'bad',
      'dirpart/',
      'drive.txt',
      'sub/',
      'sub/beta.txt',
      'trail',
      'up.txt',
      'win_illegal_.txt'
    ])
    expect(await readFile(join(root, 'h', 'a', 'kept.txt'), 'utf8')).toBe('a/../../kept.txt')
  })

  it('stops at an empty stored name with the members before it already written', async () => {
    const agent = await makeAgent()
    const zip = await stage(fx('v1-empty.zip'))
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 'unzip', source: zip, destination: 'e' })
      )
    ).toBe('ValueError: Empty filename.')
    expect(await treeOf(join(root, 'e'))).toEqual(['before.txt'])
  })

  it('reports a member that would overwrite a directory as the file system does', async () => {
    const agent = await makeAgent()
    const zip = await stage(fx('v1-collide.zip'))
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 'unzip', source: zip, destination: 'c' })
      )
    ).toBe(`PermissionError: [Errno 13] Permission denied: '${join(root, 'c', 'd')}'`)
    expect(await treeOf(join(root, 'c'))).toEqual(['d/', 'd/f.txt'])
  })

  it('answers the zipfile failures for a source that is not an archive', async () => {
    const agent = await makeAgent()
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'unzip',
          source: 'nope.zip',
          destination: 'x'
        })
      )
    ).toBe(`FileNotFoundError: [Errno 2] No such file or directory: '${join(root, 'nope.zip')}'`)
    await writeAt(join(root, 'text.zip'), 'not a zip at all\n')
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'unzip',
          source: 'text.zip',
          destination: 'x'
        })
      )
    ).toBe('BadZipFile: File is not a zip file')
    await mkdir(join(root, 'adir'))
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 'unzip', source: 'adir', destination: 'x' })
      )
    ).toBe(`PermissionError: [Errno 13] Permission denied: '${join(root, 'adir')}'`)
  })

  it('writes the tar member list tarfile produces, ignored directories and all', async () => {
    const agent = await makeAgent()
    const src = await stageTree()
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'tar',
          source: src,
          destination: 'out/dir.tar.gz'
        })
      )
    ).toBe('Created TAR.GZ archive out/dir.tar.gz')
    // `tarfile.add()` takes `sorted(os.listdir())` at every level and writes the directory members
    // too; nothing here consults `IGNORED`, which is why the tar carries what the zip dropped.
    const members = await readTarMembers(join(root, 'out', 'dir.tar.gz'))
    expect(members.map((m) => m.name)).toEqual([
      'src',
      'src/.git',
      'src/.git/config',
      'src/a.txt',
      'src/keep',
      'src/keep/env.txt',
      'src/m.txt',
      'src/node_modules',
      'src/node_modules/dep.json',
      'src/sub',
      'src/sub/.gemibot',
      'src/sub/.gemibot/session.json',
      'src/sub/b.txt'
    ])
    expect(members.map((m) => m.typeflag)).toEqual([
      '5',
      '5',
      '0',
      '0',
      '5',
      '0',
      '0',
      '5',
      '0',
      '5',
      '5',
      '0',
      '0'
    ])
  })

  it('extracts the tree the v1.0 tarfile wrote and resolves its pax names', async () => {
    const agent = await makeAgent()
    const archive = await stage(fx('v1-tree.tar.gz'))
    expect(
      only(
        await run(agent, 'archive_manage', { action: 'untar', source: archive, destination: 't' })
      )
    ).toBe('Extracted v1-tree.tar.gz to t')
    expect(await treeOf(join(root, 't'))).toEqual([
      'src/',
      'src/.git/',
      'src/.git/config',
      'src/alpha.txt',
      'src/dist-like/',
      'src/dist-like/x.txt',
      'src/empty_dir/',
      'src/empty_dir/.keep',
      'src/keep/',
      'src/keep/env.txt',
      'src/node_modules/',
      'src/node_modules/dep.txt',
      'src/sub/',
      'src/sub/.gemibot/',
      'src/sub/.gemibot/session.json',
      'src/sub/alpha.txt',
      'src/sub/beta.txt',
      'src/sub/deep/',
      'src/sub/deep/gamma.txt',
      'src/zulu.txt',
      'src/ünīcode.txt'
    ])

    // A name longer than the 99-byte ustar field arrives through a PaxHeader member, which
    // `getmembers()` hides behind the name it declares.
    const long = await stage(fx('v1-long.tar.gz'))
    expect(
      only(await run(agent, 'archive_manage', { action: 'untar', source: long, destination: 'l' }))
    ).toBe('Extracted v1-long.tar.gz to l')
    expect(await treeOf(join(root, 'l'))).toEqual([
      'deep/',
      'deep/directory-number-00/',
      'deep/directory-number-00/directory-number-01/',
      'deep/directory-number-00/directory-number-01/directory-number-02/',
      'deep/directory-number-00/directory-number-01/directory-number-02/directory-number-03/',
      'deep/directory-number-00/directory-number-01/directory-number-02/directory-number-03/directory-number-04/',
      'deep/directory-number-00/directory-number-01/directory-number-02/directory-number-03/directory-number-04/directory-number-05/',
      'deep/directory-number-00/directory-number-01/directory-number-02/directory-number-03/directory-number-04/directory-number-05/long-name.txt',
      'deep/top.txt'
    ])
  })

  it('reads an uncompressed tar through the same r:* entry point', async () => {
    const agent = await makeAgent()
    const archive = await stage(fx('v1-tree.tar'))
    expect(
      only(
        await run(agent, 'archive_manage', { action: 'untar', source: archive, destination: 'p' })
      )
    ).toBe('Extracted v1-tree.tar to p')
    expect(await treeOf(join(root, 'p'))).toContain('src/alpha.txt')
  })

  it('keeps the tar member names untouched, which is how the traversal escapes', async () => {
    const members = await readTarMembers(fx('v1-hostile.tar'))
    expect(
      members.map((m) => [m.name, m.typeflag, m.data.toString()] as [string, string, string])
    ).toEqual([
      ['../escaped.txt', '0', 'escaped\n'],
      ['/abs.txt', '0', 'abs\n'],
      ['./current.txt', '0', 'current\n'],
      ['a/../../kept.txt', '0', 'kept\n'],
      ['dir', '5', ''],
      ['dangling.txt', '0', 'dangling\n']
    ])
    // `tarfile.extractall()` joins the name onto the destination and hands it to the file system
    // unchanged, so these land outside it: v1.0's path-traversal behaviour, reproduced not fixed.
    // The shapes are the frozen `os.path.join(dst, name)` results from `probe-archive-qr3.py`: no
    // normalisation, so `..` is resolved by the file system when the path is opened, and a rooted
    // name keeps the destination's drive but not its directory.
    const dst = join(root, 'x')
    expect(ntJoin(dst, '../escaped.txt')).toBe(`${dst}\\../escaped.txt`)
    expect(ntJoin(dst, '/abs.txt')).toBe(`${/^[a-zA-Z]:/.exec(dst)?.[0] ?? ''}/abs.txt`)
    expect(ntJoin(dst, './current.txt')).toBe(`${dst}\\./current.txt`)
    expect(ntJoin(dst, 'dir')).toBe(`${dst}\\dir`)
    expect(ntJoin(dst, '')).toBe(`${dst}\\`)
  })

  it('reports a hard link whose target the archive never wrote', async () => {
    const members = await readTarMembers(fx('v1-links.tar'))
    expect(
      members.map((m) => [m.name, m.typeflag, m.linkName] as [string, string, string])
    ).toEqual([
      ['.', '5', ''],
      ['./hard.txt', '0', ''],
      ['./real.txt', '1', './hard.txt'],
      ['./sub', '5', ''],
      ['./sub/inner.txt', '0', ''],
      ['./sym.txt', '2', 'real.txt']
    ])
  })

  it('answers the tarfile open failures with its four-probe ladder', async () => {
    const agent = await makeAgent()
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'nope.tar.gz',
          destination: 'x'
        })
      )
    ).toBe(`FileNotFoundError: [Errno 2] No such file or directory: '${join(root, 'nope.tar.gz')}'`)

    const ladder = (tar: string): string =>
      'ReadError: file could not be opened successfully:\n' +
      "- method gz: ReadError('not a gzip file')\n" +
      "- method bz2: ReadError('not a bzip2 file')\n" +
      "- method xz: ReadError('not an lzma file')\n" +
      `- method tar: ReadError('${tar}')`
    await writeAt(join(root, 'empty.tar.gz'), '')
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'empty.tar.gz',
          destination: 'x'
        })
      )
    ).toBe(
      'ReadError: file could not be opened successfully:\n' +
        "- method gz: ReadError('empty file')\n" +
        "- method bz2: ReadError('not a bzip2 file')\n" +
        "- method xz: ReadError('not an lzma file')\n" +
        "- method tar: ReadError('empty file')"
    )
    await writeAt(join(root, 'short.tar'), 'tarfil')
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'short.tar',
          destination: 'x'
        })
      )
    ).toBe(ladder('truncated header'))
    // A zip is a file whose first block is not a tar header at all: the bytes that land on the
    // checksum field are not ASCII octal, which `tarfile` reports as the header being invalid.
    await writeFile(join(root, 'zip.tar'), await readFile(fx('v1-tree.zip')))
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 'untar', source: 'zip.tar', destination: 'x' })
      )
    ).toBe(ladder('invalid header'))
    // Breaking the first digit of the checksum field makes it a non-octal number, so that is the
    // same `invalid header`; only a field that still reads as octal reaches the checksum test.
    const good = await readFile(fx('v1-tree.tar'))
    good[148] = 0x39
    await writeFile(join(root, 'badck.tar'), good)
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'badck.tar',
          destination: 'x'
        })
      )
    ).toBe(ladder('invalid header'))
    // A byte outside the checksum field moves the sum without breaking the number: `bad checksum`.
    // `tarfile` never looks at the `ustar` magic, however much a reader might expect it to.
    const magic = await readFile(fx('v1-tree.tar'))
    magic[257] = 0x20
    await writeFile(join(root, 'nomagic.tar'), magic)
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'nomagic.tar',
          destination: 'x'
        })
      )
    ).toBe(ladder('bad checksum'))
    // A file shorter than one block is truncated before anything else can be checked.
    await writeFile(join(root, 'tiny.tar'), good.subarray(0, 100))
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'tiny.tar',
          destination: 'x'
        })
      )
    ).toBe(ladder('truncated header'))

    await stage(fx('v1-cut.tar.gz'))
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'v1-cut.tar.gz',
          destination: 'x'
        })
      )
    ).toBe('EOFError: Compressed file ended before the end-of-stream marker was reached')
  })

  it('cannot read a bz2 or xz stream the way the v1.0 standard library could', async () => {
    // Divergence: v1.0 opened both (its build ships `bz2` and `lzma`) and extracted `top.txt`;
    // Node has neither codec, so `readTarMembers()` answers with the probe ladder instead.
    const agent = await makeAgent()
    await writeAt(join(root, 'fake.tar.bz2'), '')
    const bytes = Buffer.concat([Buffer.from([0x42, 0x5a, 0x68]), Buffer.alloc(600)])
    await writeFile(join(root, 'fake.tar.bz2'), bytes)
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'untar',
          source: 'fake.tar.bz2',
          destination: 'x'
        })
      )
    ).toBe(
      'ReadError: file could not be opened successfully:\n' +
        "- method gz: ReadError('not a gzip file')\n" +
        "- method bz2: ReadError('not a bzip2 file')\n" +
        "- method xz: ReadError('not an lzma file')\n" +
        "- method tar: ReadError('truncated header')"
    )
  })

  it('answers an unknown or unusable action after the permission prompt', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'one.txt'), 'one\n')
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 'rar', source: 'one.txt', destination: 'x' })
      )
    ).toBe('Unknown archive action: rar')
    expect(
      failure(
        await run(agent, 'archive_manage', { action: '', source: 'one.txt', destination: 'x' })
      )
    ).toBe('Unknown archive action: ')
    // `bytes` answers both `.lower()` and `.strip()`, then matches none of the four names, and the
    // message prints the value it was given — so the b'' spelling is part of the line.
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: Buffer.from('zip'),
          source: 'one.txt',
          destination: 'x'
        })
      )
    ).toBe("Unknown archive action: b'zip'")
    expect(
      failure(
        await run(agent, 'archive_manage', { action: null, source: 'one.txt', destination: 'x' })
      )
    ).toBe("AttributeError: 'NoneType' object has no attribute 'lower'")
    expect(
      failure(
        await run(agent, 'archive_manage', { action: 7, source: 'one.txt', destination: 'x' })
      )
    ).toBe("AttributeError: 'int' object has no attribute 'lower'")
  })

  it('asks with the action and both relative paths, then refuses in v1.0 words', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    await writeAt(join(root, 'one.txt'), 'one\n')
    expect(
      failure(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'one.txt',
          destination: 'out/one.zip'
        })
      )
    ).toBe('The user denied archive operation.')
    expect(asked).toEqual([['archive_manage', 'zip: one.txt -> out/one.zip']])
  })

  it('records no file change for an archive action', async () => {
    const agent = await makeAgent()
    await writeAt(join(root, 'one.txt'), 'one\n')
    expect(
      only(
        await run(agent, 'archive_manage', {
          action: 'zip',
          source: 'one.txt',
          destination: 'one.zip'
        })
      )
    ).toBe('Created ZIP archive one.zip')
    const event = agent.state.turnTimelineEvents.at(-1)
    expect((event?.file_changes as unknown[] | undefined) ?? []).toEqual([])
  })

  it('keeps the python signature in the binding line', async () => {
    const agent = await makeAgent()
    // CPython puts a comma before the `and` of a three-name list and not before a two-name one.
    for (const [args, message] of [
      [{}, "missing 3 required positional arguments: 'action', 'source', and 'destination'"],
      [{ action: 'zip' }, "missing 2 required positional arguments: 'source' and 'destination'"],
      [{ action: 'zip', source: 'a' }, "missing 1 required positional argument: 'destination'"],
      [{ act: 'zip', source: 'a', destination: 'b' }, "got an unexpected keyword argument 'act'"]
    ] as [Record<string, unknown>, string][])
      expect(failure(await run(agent, 'archive_manage', args))).toBe(
        `Bad arguments: tool_archive_manage() ${message}`
      )
  })
})

describe('qr_generate', () => {
  const fx = (name: string): string => join(__dirname, '../fixtures', name)

  /** The pixels the tool wrote and the pixels Pillow wrote for the same payload. */
  async function pixels(
    bytes: Buffer
  ): Promise<{ info: { width: number; height: number }; data: Buffer }> {
    return (await sharp(bytes)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })) as unknown as {
      info: { width: number; height: number }
      data: Buffer
    }
  }

  it('writes the symbol the frozen oracle drew and returns the payload line', async () => {
    const agent = await makeAgent()
    expect(
      only(await run(agent, 'qr_generate', { data: 'hello world', output_path: 'qr.png' }))
    ).toBe('Generated QR code at qr.png for payload: hello world')
    const mine = await readFile(join(root, 'qr.png'))
    expect(mine.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    const oracle = JSON.parse(await readFile(fx('v1-qr.json'), 'utf8')) as {
      pngs: { payload: string; size: number[]; pngB64: string }[]
    }
    const entry = oracle.pngs.find((p) => p.payload === 'hello world')
    expect(entry).toBeDefined()
    const a = await pixels(mine)
    const b = await pixels(Buffer.from(entry!.pngB64, 'base64'))
    expect([a.info.width, a.info.height]).toEqual([290, 290])
    expect(a.data.equals(b.data)).toBe(true)
  })

  it('records the file change the way a binary artifact is recorded', async () => {
    const agent = await makeAgent()
    expect(only(await run(agent, 'qr_generate', { data: 'x', output_path: 'out/x.png' }))).toBe(
      'Generated QR code at out/x.png for payload: x'
    )
    const event = agent.state.turnTimelineEvents.at(-1)
    expect((event?.file_changes as unknown[]).at(-1)).toMatchObject({
      action: 'created',
      path: 'out/x.png'
    })
  })

  it('truncates the payload in the summary to 80 characters', async () => {
    const agent = await makeAgent()
    const payload = 'x'.repeat(80)
    expect(only(await run(agent, 'qr_generate', { data: payload, output_path: 'q.png' }))).toBe(
      `Generated QR code at q.png for payload: ${payload}`
    )
    const long = 'y'.repeat(200)
    expect(only(await run(agent, 'qr_generate', { data: long, output_path: 'q.png' }))).toBe(
      `Generated QR code at q.png for payload: ${'y'.repeat(80)}`
    )
  })

  it('writes the file before it tries to slice the payload, so a non-subscriptable one is left behind', async () => {
    const agent = await makeAgent()
    // `qrcode.make()` takes `str(data)`, so these all draw a symbol; only the `data[:80]` in the
    // summary line fails, and it fails after `img.save()`.  The `TypeError` is raised *inside* the
    // tool, but `execute()` catches `TypeError` around the whole call, so it is reported with the
    // argument-binding wording — v1.0's quirk, reproduced: `probe-archive-qr6.py`.
    for (const [value, name] of [
      [7, 'int'],
      [1.5, 'float'],
      [null, 'NoneType'],
      [true, 'bool']
    ] as [unknown, string][]) {
      expect(
        failure(await run(agent, 'qr_generate', { data: value, output_path: `n${name}.png` }))
      ).toBe(`Bad arguments: '${name}' object is not subscriptable`)
      expect((await stat(join(root, `n${name}.png`))).size).toBeGreaterThan(0)
    }
    // A mapping is subscriptable by key only, so the slice object is what the KeyError names — and
    // the symbol it drew is the one for `str(data)`, which is how `qrcode.make()` took the payload.
    expect(failure(await run(agent, 'qr_generate', { data: { a: 1 }, output_path: 'd.png' }))).toBe(
      'KeyError: slice(None, 80, None)'
    )
    expect(only(await run(agent, 'qr_generate', { data: "{'a': 1}", output_path: 's.png' }))).toBe(
      "Generated QR code at s.png for payload: {'a': 1}"
    )
    expect(await readFile(join(root, 'd.png'))).toEqual(await readFile(join(root, 's.png')))
  })

  it('prints a list and a bytes payload through their python spellings', async () => {
    const agent = await makeAgent()
    expect(only(await run(agent, 'qr_generate', { data: ['a'], output_path: 'l.png' }))).toBe(
      "Generated QR code at l.png for payload: ['a']"
    )
    expect(
      only(await run(agent, 'qr_generate', { data: Buffer.from('hi'), output_path: 'b.png' }))
    ).toBe("Generated QR code at b.png for payload: b'hi'")
  })

  it('ignores the extension it is given and always writes a png', async () => {
    const agent = await makeAgent()
    let first: Buffer | null = null
    for (const name of ['a.png', 'A.JPG', 'b.gif', 'c.txt', 'd', 'e.png.zip', 'f']) {
      expect(
        only(await run(agent, 'qr_generate', { data: 'hello world', output_path: name }))
      ).toBe(`Generated QR code at ${name} for payload: hello world`)
      const bytes = await readFile(join(root, name))
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
      first ??= bytes
      expect(bytes).toEqual(first)
    }
  })

  it('answers the file system failures around the save', async () => {
    const agent = await makeAgent()
    // `img.save()` opens the target with `wb`, and Windows reports a directory as `Errno 13`
    // rather than as `IsADirectoryError` — measured with `probe-archive-qr6.py`.
    await mkdir(join(root, 'adir'))
    expect(failure(await run(agent, 'qr_generate', { data: 'x', output_path: 'adir' }))).toBe(
      `PermissionError: [Errno 13] Permission denied: '${join(root, 'adir')}'`
    )
  })

  it('refuses an unencodable payload before it writes anything', async () => {
    const agent = await makeAgent()
    expect(
      failure(await run(agent, 'qr_generate', { data: '\ud800', output_path: 'sur.png' }))
    ).toBe(
      "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 0: surrogates not allowed"
    )
    expect(await readdir(root)).not.toContain('sur.png')
    expect(
      failure(await run(agent, 'qr_generate', { data: 'z'.repeat(5000), output_path: 'big.png' }))
    ).toBe('ValueError: Invalid version (was 41, expected 1 to 40)')
    expect(await readdir(root)).not.toContain('big.png')
  })

  it('asks with the relative path and refuses in v1.0 words', async () => {
    const agent = await makeAgent(false)
    const asked: [string, string][] = []
    agent.state.onPermission = async (tool, detail) => {
      asked.push([tool, detail])
      return false
    }
    expect(failure(await run(agent, 'qr_generate', { data: 'x', output_path: 'out/q.png' }))).toBe(
      'The user denied QR generation.'
    )
    expect(asked).toEqual([['qr_generate', 'out/q.png']])
  })

  it('keeps the python signature in the binding line', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'qr_generate', {}))).toBe(
      "Bad arguments: tool_qr_generate() missing 2 required positional arguments: 'data' and 'output_path'"
    )
    expect(failure(await run(agent, 'qr_generate', { data: 'x' }))).toBe(
      "Bad arguments: tool_qr_generate() missing 1 required positional argument: 'output_path'"
    )
    expect(failure(await run(agent, 'qr_generate', { payload: 'x', output_path: 'q.png' }))).toBe(
      "Bad arguments: tool_qr_generate() got an unexpected keyword argument 'payload'"
    )
  })
})

/**
 * `tool_system_diagnostics()` reads the machine, so its two live counters (free RAM, free disk)
 * cannot be pinned to a number.  What parity fixes here is the shape of every line — the eight
 * header lines, the three `psutil` lines with their `//` floors and `,` groupings, the blank line
 * the `"\nInstalled …"` literal leaves behind, and the sixteen library rows in `mod_checks` order —
 * plus the values that do not move: the CPU count, the volume's total bytes, and the totals the
 * counters are divided by.
 */
describe('system_diagnostics', () => {
  /** `'{n:,}'` done independently of the port, so the grouping rule is checked, not assumed. */
  const grouped = (value: number): string =>
    Math.floor(value)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/gu, ',')

  /** The block as v1.0's venv answered it on a machine that has all sixteen except the six v2.0 bundles no counterpart for. */
  const LIBRARY_ROWS = [
    '  [OK]      google-genai',
    '  [OK]      pillow',
    '  [OK]      python-docx',
    '  [OK]      openpyxl',
    '  [OK]      pandas',
    '  [OK]      pypdf',
    '  [OK]      pymupdf',
    '  [OK]      reportlab',
    '  [OK]      python-pptx',
    '  [MISSING] opencv-python',
    '  [MISSING] librosa',
    '  [MISSING] soundfile',
    '  [OK]      edge-tts',
    '  [MISSING] gTTS',
    '  [MISSING] pyttsx3',
    '  [OK]      qrcode'
  ]

  /** The tool's answer, split the way `"\n'.join(lines)` puts it back together. */
  async function diagnostics(agent: Agent): Promise<string[]> {
    return only(await run(agent, 'system_diagnostics', {})).split('\n')
  }

  it('answers with the eight header lines in v1.0 order', async () => {
    const agent = await makeAgent()
    const lines = await diagnostics(agent)
    expect(lines[0]).toBe('System Diagnostics - Gemibot.py')
    // `platform.version()` is the `major.minor.build` number, which is what `os.release()` carries,
    // and `platform.machine()` takes the WMI architecture — falling back to the processor
    // environment variables — where `os.machine()` would say `x86_64` instead of `AMD64`.
    expect(lines[1]).toMatch(/^- OS: .+ \(.+\)$/u)
    expect(lines[1]).toContain(`(${osRelease()})`)
    expect(lines[2]).toBe(
      `- Architecture: ${process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE}`
    )
    // v2.0 has no Python: the two interpreter slots name the runtime that is running the tool, the
    // same decision the Environment block's `Runtime:` line already makes.
    expect(lines[3]).toBe(`- Python Executable: ${process.execPath}`)
    expect(lines[4]).toBe(`- Python Version: ${process.versions.node}`)
    expect(lines[5]).toBe(`- Virtual Env (.venv) Active: False (${dirname(process.execPath)})`)
    expect(lines[6]).toBe(`- Project Root: ${root}`)
    expect(lines[7]).toBe('- Memory Store: conversation database')
  })

  it('floors and groups the memory, disk and cpu lines the way the f-strings do', async () => {
    const agent = await makeAgent()
    const lines = await diagnostics(agent)
    expect(lines[8]).toBe(`- CPU Cores: ${cpus().length} logical`)

    const ram = /^- RAM: ([\d,]+) MB \/ ([\d,]+) MB \((\d+(?:\.\d+)?)%\)$/u.exec(lines[9])
    expect(ram).not.toBeNull()
    expect(ram?.[2]).toBe(grouped(totalmem() / 1024 ** 2))
    const used = Number(ram?.[1].replace(/,/gu, ''))
    const total = Number(ram?.[2].replace(/,/gu, ''))
    expect(used).toBeLessThanOrEqual(total)
    expect(Number(ram?.[3])).toBeGreaterThanOrEqual(0)
    expect(Number(ram?.[3])).toBeLessThanOrEqual(100)

    const info = await statfs(root)
    const disk = /^- Disk Free: ([\d,]+) GB \/ ([\d,]+) GB$/u.exec(lines[10])
    expect(disk).not.toBeNull()
    expect(disk?.[2]).toBe(grouped((Number(info.blocks) * Number(info.frsize)) / 1024 ** 3))
    const free = Number(disk?.[1].replace(/,/gu, ''))
    expect(
      Math.abs(free - (Number(info.bavail) * Number(info.frsize)) / 1024 ** 3)
    ).toBeLessThanOrEqual(1)
  })

  it('prints the blank line, the library header and the sixteen rows in v1.0 order', async () => {
    const agent = await makeAgent()
    const lines = await diagnostics(agent)
    expect(lines).toHaveLength(29)
    expect(lines[11]).toBe('')
    expect(lines[12]).toBe('Installed Multimodal & Office Libraries:')
    expect(lines.slice(13)).toEqual(LIBRARY_ROWS)
  })

  it('asks no permission, prints nothing and records no file change', async () => {
    const agent = await makeAgent(false)
    let asked = 0
    agent.state.onPermission = async () => {
      asked++
      return true
    }
    const before = raw
    expect((await diagnostics(agent))[0]).toBe('System Diagnostics - Gemibot.py')
    expect(asked).toBe(0)
    expect(raw).toBe(before)
    const event = agent.state.turnTimelineEvents.at(-1)
    expect((event?.file_changes as unknown[] | undefined) ?? []).toEqual([])
  })

  it('answers in plan and read modes, which gate only the write tools', async () => {
    const agent = await makeAgent()
    for (const mode of ['plan', 'read']) {
      agent.state.mode = mode
      expect((await diagnostics(agent))[0]).toBe('System Diagnostics - Gemibot.py')
    }
  })

  it('keeps the python signature in the binding line', async () => {
    const agent = await makeAgent()
    expect(failure(await run(agent, 'system_diagnostics', { verbose: true }))).toBe(
      "Bad arguments: tool_system_diagnostics() got an unexpected keyword argument 'verbose'"
    )
  })

  it('reports a project root that is no longer on disk the way psutil does', async () => {
    const agent = await makeAgent()
    const gone = join(root, 'gone')
    agent.paths.setRoot(gone)
    expect(failure(await run(agent, 'system_diagnostics', {}))).toBe(
      `FileNotFoundError: [WinError 3] The system cannot find the path specified: '${gone}'`
    )
  })
})
