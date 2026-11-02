import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { C } from '../../src/shared/constants/colors'
import { ChangeType } from '../../src/shared/models/file-change'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { choose } from '../../src/main/utils/choose'
import { Agent } from '../../src/main/services/agent.service'
import type { ChooseHook } from '../../src/main/services/agent-session.service'
import { fixture } from './load-fixture'

/**
 * Byte-level replay of every slash command v1.0 prints into the console.
 *
 * `tests/fixtures/v1-cli-commands.json` was captured by `tools/parity/probe-cli-commands.py`,
 * which drove `views/window_app.py::Agent.command()` with a scripted `input()` so the pickers
 * (`choose()`, 417) could be replayed here through the injected `ReadLine`.  Each case runs
 * against its own fresh temp folder, exactly like the probe did, and both transcripts pass
 * through the same scrub so the wall clock and the random folder name cannot leak in.
 *
 * The `/pip` cases are compared as far as the port reaches: v1.0 asks `[y/N]` and then shells
 * out to `sys.executable -m pip`, which an Electron app cannot do (UNKNOWN, Phase 6).  Both
 * sides still have to agree on every byte printed before that prompt.
 */

interface CliCase {
  label: string
  line: string
  answers: string[]
  prompts: string[]
  out: string
  result: 'exit' | null
  error: string | null
  state: {
    mode: string
    active_function: string
    model: string
    pinned: boolean
    effort_level: string | null
    root: string
    pending: number
  }
}

const CASES = fixture<{ width: number; cases: CliCase[] }>('v1-cli-commands.json').cases

/** The three cases whose transcript continues past the pip prompt v2.0 does not ask. */
const PIP_CASES = new Map<string, string>([
  ['pip_eof', ''],
  ['pip_no', `  ${C.DIM}Skipped pip installation.${C.RESET}\n`],
  ['function_pip_entry', '']
])

const STAMP_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g
const TIME_RE = /\d{2}:\d{2}:\d{2}/g
const INTERPRETER_RE = /(- Python Interpreter: )[^\n]*\n/

/** The two cases that open the `/effort` menu, i.e. the only transcript that lists the levels. */
const EFFORT_MENU_CASES = new Set(['effort_cancel', 'effort_pick_3'])
/* eslint-disable no-control-regex */
const SAVING_MENU_ROW = /^ {2}\u001b\[96m *\d+\.\u001b\[0m \u001b\[1msaving\u001b\[0m[^\n]*\n/m
/* eslint-enable no-control-regex */

/**
 * v2.0 appends a sixth effort level, so the menu carries one row more than v1.0 captured and the
 * prompt range grows with it. Dropping the added row and the wider range leaves the five rows
 * v1.0 wrote to be compared byte-for-byte; the numbers of those rows are untouched because the
 * new level trails the list.
 */
function withoutSavingLevel(text: string): string {
  return text.replace(SAVING_MENU_ROW, '').replaceAll('Enter number (1-6)', 'Enter number (1-5)')
}

/** Mirrors the probe's `scrub()`: the temp folder and cwd become `<TMP>`, the clock `<TIME>`. */
function scrub(text: string, tmp: string): string {
  const variants = [tmp, resolve(tmp), tmp.replaceAll('\\', '/'), basename(tmp), process.cwd()]
  let clean = text
  for (const variant of variants.filter(Boolean).sort((a, b) => b.length - a.length)) {
    clean = clean.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<TMP>')
  }
  return clean.replace(STAMP_RE, '<STAMP>').replace(TIME_RE, '<TIME>')
}

/** Drops the one line that can never match: v1.0 names its venv python, v2.0 names Node. */
function normalizeInterpreter(text: string): string {
  return text.replace(INTERPRETER_RE, '$1<EXE>\n')
}

/* eslint-disable no-control-regex */
/**
 * v2.0 keeps settings and the memory journal in SQLite, so `/settings` and `/memory` print the
 * database and scope/key instead of a markdown path, and three help lines name that store. It also
 * adds the compaction and token-efficiency help lines. The transcript is otherwise still v1.0
 * byte for byte.
 */
function normalizeStorageTranscript(text: string): string {
  return text
    .replace(
      'view /memory/settings.md saved user preferences',
      'view saved user preferences from the conversation database'
    )
    .replace(
      'show /memory/memory.md logs and interaction history',
      'show memory logs and interaction history from the conversation database'
    )
    .replace(
      'clear active chat context and reset /memory/memory.md',
      'clear active chat context and reset memory'
    )
    .replace(
      'Active chat and /memory/memory.md cleared.',
      'Active chat and conversation memory cleared.'
    )
    .replace(
      /( {2}\u001b\[90m- )Path:( {12})<TMP>\\memory\\settings\.md/,
      '$1Database:        <TMP>\\gemibot.db\n$1Scope:           settings:<TMP>'
    )
    .replace(
      /( {2}\u001b\[90m- )Path:( {4})<TMP>\\memory\\memory\.md/,
      '$1Database: <TMP>\\gemibot.db\n$1Key:      memory:<TMP>'
    )
    .replace(/( {2}\u001b\[90m- Size:( {4}))\d+ characters/, '$1<N> characters')
    .split('\n')
    .filter(
      (line) =>
        !/\/compact(?:ion)?\b/.test(line) &&
        !/\/token\b/.test(line) &&
        !/\/style\b/.test(line) &&
        !/\/deep\b/.test(line) &&
        !/\/steps\b/.test(line) &&
        !/\/stream\b/.test(line) &&
        !/\/buildmode\b/.test(line) &&
        !line.includes('Behavior:')
    )
    .join('\n')
}
/* eslint-enable no-control-regex */

let root = ''
const roots: string[] = []
let raw = ''
let mirrored: string[] = []
let detach: (() => void) | null = null

beforeEach(() => {
  raw = ''
  mirrored = []
  // The mirror pane is Stage 4's copy of stdout, so the replay can prove the two never drift.
  detach = onConsoleOutput((text) => mirrored.push(text))
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    raw += String(chunk)
    return true
  }) as never)
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.restoreAllMocks()
  const pending = roots.splice(0)
  if (root) pending.push(root)
  root = ''
  await Promise.all(
    pending.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        /* leftover temp folder */
      }
    })
  )
})

/** `prepare_plain` in the probe: two entries so `/target` has something to point at. */
async function preparePlain(root: string): Promise<void> {
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'afile.txt'), 'plain\n', 'utf8')
}

/** `stage_change` in the probe: one change of every type plus the reads `/changes` lists. */
async function stageChange(agent: Agent, root: string): Promise<void> {
  const at = (name: string): string => join(root, name)
  const wide = 'wide-filename-that-overflows-the-column-padding-rule.txt'

  await writeFile(at('kept.txt'), 'hello\n', 'utf8')
  await agent.changeTracker.recordChange('kept.txt', at('kept.txt'), ChangeType.ADDED, 'fresh file')

  await writeFile(at('gone.txt'), 'bye\n', 'utf8')
  await agent.changeTracker.recordChange('gone.txt', at('gone.txt'), ChangeType.DELETED, 'removed')

  await writeFile(at('notes.md'), '# notes\n', 'utf8')
  await agent.changeTracker.recordChange(
    'notes.md',
    at('notes.md'),
    ChangeType.DOCX_EDITED,
    'docx touched'
  )

  await writeFile(at('art.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await agent.changeTracker.recordChange(
    'art.png',
    at('art.png'),
    ChangeType.GENERATED,
    'image',
    true
  )

  await writeFile(at(wide), 'x\n', 'utf8')
  await agent.changeTracker.recordChange(wide, at(wide), ChangeType.MODIFIED, 'edit')

  for (const name of ['kept.txt', 'gone.txt', 'notes.md', 'art.png', wide]) {
    await agent.changeTracker.recordRead(name)
  }
  await writeFile(at('extra.txt'), 'y\n', 'utf8')
  await agent.changeTracker.recordRead('extra.txt')

  await mkdir(join(root, 'sub'))
  await writeFile(at('afile.txt'), 'plain\n', 'utf8')
}

/** The probe's `stage_change` cases, i.e. everything except `prepare_plain`. */
const STAGED = new Set([
  'accept_staged',
  'accept_all_alias',
  'reject_staged',
  'reject_all_alias',
  'changes_staged',
  'pending_alias',
  'clear_staged'
])

/** One case's outcome: the transcript, its mirror, the return word and the engine state. */
interface Replay {
  out: string
  mirror: string
  result: 'exit' | null
  prompts: string[]
  state: CliCase['state']
}

async function replay(c: CliCase): Promise<Replay> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-cli-'))
  roots.push(root)

  const prompts: string[] = []
  const queue = c.answers.map((answer) => answer.replaceAll('<TMP>', root))
  const hook: ChooseHook = (title, items, options) =>
    choose(title, items, options ?? {}, async (prompt) => {
      prompts.push(prompt)
      return queue.length > 0 ? (queue.shift() as string) : null
    })

  const agent = await Agent.create({
    root,
    // The probe built every agent on `AppConstants.MODELS[0]`, which is what a fresh
    // `settings.md` is seeded with too.
    model: AppConstants.MODELS[0],
    apiKey: 'parity-test-placeholder',
    execute: async () => ({ ok: true }),
    choose: hook
  })
  // The probe replaced `ModelCatalog.refresh_async` with a no-op: the list v1.0 prints is the
  // cache it was seeded from, never whatever a live catalog call might return.
  agent.modelController!.catalog.refreshAsync = async () => {}

  if (STAGED.has(c.label)) await stageChange(agent, root)
  else await preparePlain(root)

  raw = ''
  mirrored = []
  const result = await agent.command(c.line.replaceAll('<TMP>', root))
  return {
    out: raw,
    mirror: mirrored.join('\n'),
    result,
    prompts,
    state: {
      mode: agent.state.mode,
      active_function: agent.state.activeFunction,
      model: agent.model,
      pinned: agent.state.pinned,
      effort_level: agent.effortLevel.value,
      root: scrub(agent.state.root, root),
      pending: agent.changeTracker.getSummary().total_changes
    }
  }
}

describe('Agent.command() — v1.0 slash-command transcript', () => {
  for (const c of CASES) {
    it(
      c.label,
      async () => {
        const run = await replay(c)
        const pipTail = PIP_CASES.get(c.label)

        if (pipTail === undefined) {
          const effort = EFFORT_MENU_CASES.has(c.label)
          const mine = effort ? withoutSavingLevel(scrub(run.out, root)) : scrub(run.out, root)
          expect(normalizeStorageTranscript(mine)).toBe(normalizeStorageTranscript(c.out))
          expect(effort ? run.prompts.map(withoutSavingLevel) : run.prompts).toEqual(c.prompts)
        } else {
          const mine = normalizeInterpreter(scrub(run.out, root))
          const theirs = normalizeInterpreter(c.out)
          expect(mine).toBe(theirs.slice(0, mine.length))
          expect(theirs.slice(mine.length)).toBe(pipTail)
          expect(run.prompts).toEqual(c.prompts.filter((p) => p.startsWith('Enter number')))
        }

        expect(run.result).toBe(c.result)
        expect(run.state).toEqual(c.state)
        // Stage 4's console pane is a copy of this transcript, so a message that reaches stdout
        // without also reaching the sink would be a regression the fixture cannot see.
        expect(run.mirror).toBe(run.out.replace(/\n$/, ''))
      },
      30_000
    )
  }
})
