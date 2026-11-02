import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { out, outRaw, sleep } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'
import {
  AI_HEADER,
  CHAT_HEADER,
  CONSOLE_HEADER,
  ConversationJournal,
  nextConversationId,
  stripForPrompt,
  type JournalMeta
} from '../../src/main/services/conversation-journal.service'
import { DatabaseMemoryIO } from '../../src/main/services/memory-store.service'
import { memoryRepository } from '../../src/main/services/long-term-repository.service'
import type { EngineResponse, UsageCounts } from '../../src/main/services/ai-client.service'
import type { Part } from '../../src/main/models/content'

/**
 * The app-written conversation journal: one four-part block per turn, rewritten live at the
 * tail of the database memory document, with whatever the model appends behind it absorbed
 * into part 4.
 *
 * The v1 `## Interaction Log` block is asserted to survive *below* the journal block, because
 * that ordering is what stops the live rewrite from eating the recorded history.
 */

const network = vi.hoisted(() => ({ online: true }))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => network.online
}))

const META: JournalMeta = { model: 'gemini-3.5-flash-lite', effort: 'High', mode: 'build' }
const END_RE = /<!-- gemibot:conversation:end CONV-\d+ -->/

let key = ''
let seq = 0

function journalIO(): DatabaseMemoryIO {
  return new DatabaseMemoryIO([key])
}

function readDoc(documentKey = key): string {
  return memoryRepository.get(documentKey) ?? ''
}

function appendDoc(text: string, documentKey = key): void {
  memoryRepository.write(documentKey, readDoc(documentKey) + text)
}

function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to)
  expect(start, `${from} missing`).toBeGreaterThanOrEqual(0)
  expect(end, `${to} missing`).toBeGreaterThanOrEqual(0)
  return text.slice(start, end)
}

function endIndex(text: string): number {
  const match = END_RE.exec(text)
  expect(match, 'end sentinel missing').not.toBeNull()
  return text.indexOf(match![0])
}

async function open(journal: ConversationJournal, prompt = 'fix the bug'): Promise<void> {
  await journal.begin(META, prompt)
}

describe('ConversationJournal — the four-part block', () => {
  beforeEach(async () => {
    seq += 1
    key = `memory:test:journal:${process.pid}:${seq}:${Date.now()}`
    await journalIO().write('# Existing memory\n')
    network.online = true
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('appends header, chat, console and AI-written parts below the untouched history', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    journal.record('GemiBot AI', 'On it, bro.')
    out('a console line')
    await journal.end()

    const text = readDoc()
    expect(text.startsWith('# Existing memory\n')).toBe(true)
    expect(text).toContain('Conversation ID: CONV-00000000000001')
    expect(text).toContain('Model: gemini-3.5-flash-lite')
    expect(text).toContain('Effort: High')
    expect(text).toContain('Mode: BUILD')
    expect(/^Date: \d{4}-\d{2}-\d{2}$/m.test(text)).toBe(true)
    expect(/^Time: \d{2}:\d{2}:\d{2}$/m.test(text)).toBe(true)
    expect(/^Duration: \d+\.\ds$/m.test(text)).toBe(true)

    const chat = slice(text, CHAT_HEADER, CONSOLE_HEADER)
    expect(chat).toContain('fix the bug')
    expect(chat).toContain('On it, bro.')
    expect(slice(text, CONSOLE_HEADER, AI_HEADER)).toContain('a console line')
    expect(text.slice(text.indexOf(AI_HEADER))).toContain('(Nothing written by the model yet.)')
  })

  it('renders tool timeline events as plain, indented text', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    journal.recordEvent({
      type: 'action',
      tool: 'edit_file',
      args: { path: 'src/a.ts', old_string: 'one' },
      output: 'Updated src/a.ts',
      is_error: false,
      status: 'Success',
      duration: 0.123,
      timestamp: '10:00:01',
      file_changes: [{ action: 'modified', path: 'src/a.ts' }]
    })
    await journal.end()

    const chat = slice(readDoc(), CHAT_HEADER, CONSOLE_HEADER)
    expect(chat).toContain('[10:00:01] edit_file [Success] 0.123s')
    expect(chat).toContain('\n    args:\n      path: src/a.ts\n      old_string: one')
    expect(chat).toContain('\n    output: Updated src/a.ts')
    expect(chat).toContain('\n    MODIFIED src/a.ts')
  })

  it('stays plain text: fenced, no markdown headings, long values collapsed', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    journal.recordEvent({
      tool: 'write_file',
      args: { path: 'theme.css', content: `:root {\n${'  --v: 1;\n'.repeat(60)}\n}` },
      output: 'Created theme.css',
      is_error: false,
      status: 'Success',
      timestamp: '10:00:02'
    })
    await journal.end()

    const text = readDoc()
    expect(text).toContain('```text')
    expect(text).not.toContain('### ')
    expect(text).toContain('    content:')
    expect(text).toContain('... 39 more line(s)')
    expect(text.match(/--v: 1;/g)).toHaveLength(23)
  })

  it('keeps console lines but drops spinner repaints', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    out('printed line')
    outRaw('Thinking... [repainted]')
    await journal.end()

    const consolePart = slice(readDoc(), CONSOLE_HEADER, AI_HEADER)
    expect(consolePart).toContain('printed line')
    expect(consolePart).not.toContain('repainted')
  })

  it('rewrites the live block about once a second instead of on every event', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)

    journal.record('first', 'the first entry')
    journal.record('second', 'the trailing entry')
    expect(readDoc()).not.toContain('the trailing entry')

    await sleep(1.3)
    const text = readDoc()
    expect(text).toContain('the first entry')
    expect(text).toContain('the trailing entry')
    // One block only: a throttled flush rewrites in place rather than appending a new one.
    expect(text.match(/Conversation ID: CONV-/g)).toHaveLength(1)
  })

  it('absorbs what the model appends past the block into part 4 and clears the tail', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    appendDoc('\nThe model noted its own lesson.\n')
    await journal.end()

    const text = readDoc()
    expect(text.slice(text.indexOf(AI_HEADER), endIndex(text))).toContain(
      'The model noted its own lesson.'
    )
    expect(text.slice(endIndex(text)).replace(END_RE, '').trim()).toBe('')
    expect(text.match(/The model noted its own lesson\./g)).toHaveLength(1)
  })

  it('stops recording once the turn ends and freezes the duration', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal)
    await journal.end()
    const closed = readDoc()

    out('ignored after end')
    journal.record('ignored', 'also ignored')
    await journal.end()

    expect(readDoc()).toBe(closed)
    expect(closed).not.toContain('ignored')
  })

  it('increments the conversation id and leaves finished blocks alone', async () => {
    const journal = new ConversationJournal(journalIO())
    await open(journal, 'first turn')
    await journal.end()
    await open(journal, 'second turn')
    await journal.end()

    const text = readDoc()
    expect(text).toContain('CONV-00000000000001')
    expect(text).toContain('CONV-00000000000002')
    expect(text.indexOf('first turn')).toBeLessThan(text.indexOf('second turn'))
    expect(nextConversationId(text)).toBe('CONV-00000000000003')
  })
})

describe('stripForPrompt', () => {
  it('leaves memory without journal blocks byte-for-byte intact', () => {
    const plain = `${AppConstants.MEMORY_HEADER}\n## Interaction Log - 2026\n`
    expect(stripForPrompt(plain)).toBe(plain)
  })

  it('keeps only part 4 of every block', async () => {
    const blockKey = `memory:test:strip:${process.pid}:${Date.now()}`
    const io = new DatabaseMemoryIO([blockKey])
    await io.write('# Existing memory\n')
    const journal = new ConversationJournal(io)
    await journal.begin(META, 'a secret transcript line')
    journal.recordEvent({ tool: 'read_file', args: { path: 'x' }, output: 'contents' })
    appendDoc('\nthe model kept this note\n', blockKey)
    await journal.end()

    const stripped = stripForPrompt(readDoc(blockKey))
    expect(stripped).toContain('the model kept this note')
    expect(stripped).not.toContain('a secret transcript line')
    expect(stripped).not.toContain(CHAT_HEADER)
    expect(stripped).not.toContain(CONSOLE_HEADER)
    expect(stripped).not.toContain('gemibot:conversation')
    expect(stripped).not.toContain('```')
    expect(stripped).toContain('# Existing memory\n')
  })
})

describe('Agent.turn() journal wiring', () => {
  const roots: string[] = []

  function response(parts: Part[], usage: UsageCounts | null = null): EngineResponse {
    return {
      candidates: [{ content: { role: 'model', parts } }],
      text: parts.map((p) => p.text ?? '').join(''),
      usage_metadata: usage,
      raw_response: null
    }
  }

  beforeEach(() => {
    network.online = true
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const pending = roots.splice(0)
    await Promise.all(
      pending.map(async (d) => {
        try {
          await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {
          /* leftover temp folder */
        }
      })
    )
  })

  it('records the turn live and keeps the v1 interaction log below the block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gemibot-journal-turn-'))
    roots.push(root)
    await writeFile(join(root, 'a.txt'), 'alpha contents\n', 'utf8')
    const agent = await Agent.create({
      root,
      model: 'gemini-3.5-flash-lite',
      apiKey: 'parity-test-placeholder',
      choose: async () => null
    })
    let step = 0
    agent.client.generateContent = async () => {
      step += 1
      if (step === 1) {
        return response([
          { text: 'planning silently', thought: true },
          {
            text: 'Let me read that. ',
            function_call: { id: 'c1', name: 'read_file', args: { path: 'a.txt' } }
          }
        ])
      }
      return response([{ text: 'Done, bro.' }])
    }

    await agent.turn('check a.txt')

    const text = await agent.readMemoryContent()
    const block = slice(text, CHAT_HEADER, CONSOLE_HEADER)
    expect(block).toContain('check a.txt')
    expect(block).toContain('planning silently')
    expect(block).toContain('read_file [Success]')
    expect(block).toContain('alpha contents')
    expect(block).toContain('Done, bro.')

    // The console part saw the memory-read banner the turn printed.
    expect(slice(text, CONSOLE_HEADER, AI_HEADER)).toContain('memory_read')

    // v1 parity: the interaction log still lands, and only after the journal block closes.
    const logAt = text.indexOf('## Interaction Log')
    const endAt = endIndex(text)
    expect(logAt).toBeGreaterThan(-1)
    expect(logAt).toBeGreaterThan(endAt)
  })
})
