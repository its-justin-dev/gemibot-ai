import { describe, expect, it } from 'vitest'

import {
  COMPACTION_DEFAULTS,
  DEFAULT_CONTEXT_WINDOW,
  MAX_REQUEST_TOKENS,
  SUMMARY_TRANSCRIPT_MAX_CHARS,
  clampPercent,
  clampRecentMessages,
  modelContextWindow,
  requestTokenBudget
} from '../../src/shared/constants/context-windows'
import type {
  CompactionSettings,
  CompactionStartInfo,
  CompactionResult
} from '../../src/shared/types/compaction'
import { AgentState } from '../../src/main/models/agent-state'
import type { Content } from '../../src/main/models/content'
import type { AiClient } from '../../src/main/services/ai-client.service'
import type { AgentSystem } from '../../src/main/services/agent-system.service'
import type { CompactionRow } from '../../src/main/services/conversation-repository.service'
import {
  ConversationCompactor,
  buildSummaryPrompt,
  buildSummaryTranscript,
  chunkSummaryTranscript,
  dedupeOldToolOutputs,
  hardTrimContents,
  planCompactionSplit,
  recentBoundaryIndex,
  redactSecrets,
  trimOldToolOutputs,
  type CompactionCallbacks,
  type CompactionStore
} from '../../src/main/services/conversation-compaction.service'
import {
  estimateContentsTokens,
  estimateTextTokens
} from '../../src/main/services/conversation-history.service'

const SUMMARY = '## User Goal\nKeep the compaction tests green.'

function user(text: string): Content {
  return { role: 'user', parts: [{ text }] }
}

function model(text: string): Content {
  return { role: 'model', parts: [{ text }] }
}

function toolResult(output: string, name = 'read_file'): Content {
  return { role: 'user', parts: [{ function_response: { name, response: { output } } }] }
}

function outputOf(content: Content): string {
  const response = content.parts?.[0]?.function_response?.response
  return String(response?.['output'] ?? '')
}

function longConversation(turns = 12, size = 50_000): Content[] {
  const contents: Content[] = []
  for (let index = 0; index < turns; index++) {
    contents.push(
      user(
        `Active Function Suite: all | Active Mode: build\nUser Request:\nTurn ${index} ${'x'.repeat(size)}`
      )
    )
    contents.push(model(`done ${index}`))
  }
  return contents
}

function fakeSystem(overhead: number | ((model: string) => number)): AgentSystem {
  return {
    requestOverheadTokens: (_state: AgentState, model: string) =>
      typeof overhead === 'function' ? overhead(model) : overhead
  } as unknown as AgentSystem
}

interface HarnessInput {
  contents: Content[]
  model?: string
  historySummary?: string | null
  overhead?: number | ((model: string) => number)
  settings?: Partial<CompactionSettings>
  generate?: (model: string, prompt: string) => string | Promise<string>
}

interface Harness {
  state: AgentState
  compactor: ConversationCompactor
  storeRows: CompactionRow[]
  settings: CompactionSettings
  starts: CompactionStartInfo[]
  finishes: CompactionResult[]
  notices: Array<{ text: string; isError: boolean }>
  calls: Array<{ model: string; prompt: string }>
}

const DEFAULT_SETTINGS: CompactionSettings = {
  enabled: true,
  thresholdPercent: 80,
  targetPercent: 40,
  recentMessages: 2,
  summarizerModel: 'gemini-3.5-flash-lite'
}

function harness(input: HarnessInput): Harness {
  const state = {
    contents: input.contents,
    model: input.model ?? 'gemini-3.1-flash-lite',
    historySummary: input.historySummary ?? null,
    compactionSplitIndex: 0,
    requestDigest: null,
    cancelRequested: false
  } as unknown as AgentState

  const settings: CompactionSettings = { ...DEFAULT_SETTINGS, ...input.settings }
  const storeRows: CompactionRow[] = []
  const rowFrom = (row: CompactionRow): CompactionRow => row
  const store: CompactionStore = {
    saveCompaction(save) {
      const id = storeRows.length + 1
      const row: CompactionRow = {
        id,
        conversation_id: 'conv',
        created_at: Date.now(),
        summary: save.summary,
        covers_up_to_message_id: id,
        first_kept_message_id: id + 1,
        split_content_index: save.splitContentIndex,
        messages_summarized_count: save.messagesSummarizedCount,
        messages_kept_count: save.messagesKeptCount,
        tokens_before: save.tokensBefore,
        tokens_after: save.tokensAfter,
        model_used: save.modelUsed,
        trigger: save.trigger,
        status: save.status,
        duration_ms: save.durationMs,
        error: save.error ?? null
      }
      storeRows.push(row)
      return rowFrom(row)
    },
    latestCompaction() {
      return [...storeRows].reverse().find((row) => row.status === 'success') ?? null
    },
    listCompactions() {
      return [...storeRows]
    }
  }

  const starts: CompactionStartInfo[] = []
  const finishes: CompactionResult[] = []
  const notices: Array<{ text: string; isError: boolean }> = []
  const callbacks: CompactionCallbacks = {
    onStart: (info) => starts.push(info),
    onFinish: (result) => finishes.push(result),
    onNotice: (text, isError) => notices.push({ text, isError })
  }

  const calls: Array<{ model: string; prompt: string }> = []
  const generate = input.generate ?? (() => SUMMARY)
  const client = {
    async generateContent(model: string, contents: Content[]) {
      const prompt = contents[0]?.parts?.[0]?.text ?? ''
      calls.push({ model, prompt })
      return { text: await generate(model, prompt) }
    }
  } as unknown as AiClient

  const compactor = new ConversationCompactor({
    state,
    client,
    system: fakeSystem(input.overhead ?? 100),
    settings: () => settings,
    store: () => store,
    callbacks
  })

  return { state, compactor, storeRows, settings, starts, finishes, notices, calls }
}

describe('per-model context windows', () => {
  it('caps every window at the app request ceiling', () => {
    expect(modelContextWindow('gemini-3.1-flash-lite')).toBe(1_048_576)
    expect(requestTokenBudget('gemini-3.1-flash-lite')).toBe(MAX_REQUEST_TOKENS)
    expect(requestTokenBudget('gemini-2.5-pro')).toBe(MAX_REQUEST_TOKENS)
  })

  it('gives media and embedding models their smaller real windows', () => {
    expect(modelContextWindow('text-embedding-004')).toBe(2_048)
    expect(modelContextWindow('gemini-2.5-flash-image')).toBe(32_768)
    expect(modelContextWindow('gemma-3-27b')).toBe(131_072)
    expect(requestTokenBudget('gemini-2.5-flash-image')).toBe(32_768)
  })

  it('falls back to a conservative window for unknown models', () => {
    expect(modelContextWindow('some-new-model')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(modelContextWindow('')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(requestTokenBudget('some-new-model')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('clamps the settings into their allowed ranges', () => {
    expect(clampPercent(10)).toBe(50)
    expect(clampPercent(99)).toBe(95)
    expect(clampPercent(Number.NaN)).toBe(COMPACTION_DEFAULTS.thresholdPercent)
    expect(clampRecentMessages(1)).toBe(2)
    expect(clampRecentMessages(500)).toBe(50)
    expect(clampRecentMessages(Number.NaN)).toBe(COMPACTION_DEFAULTS.recentMessages)
  })
})

describe('Step A: trimming old tool output', () => {
  it('keeps the head and tail of an old oversized result and marks the cut', () => {
    const big = `${'H'.repeat(5_000)}${'T'.repeat(5_000)}`
    const contents = [toolResult(big), user('live request'), toolResult('recent')]

    const trimmed = trimOldToolOutputs(contents, 1)
    const output = outputOf(trimmed[0])

    expect(output.startsWith('H'.repeat(1_200))).toBe(true)
    expect(output.endsWith('T'.repeat(400))).toBe(true)
    expect(output).toContain('[output trimmed]')
    expect(output.length).toBeLessThan(2_000)
  })

  it('leaves the recent side, short results and the stored rows untouched', () => {
    const big = 'x'.repeat(10_000)
    const contents = [toolResult(big), user('live request'), toolResult(big)]

    const trimmed = trimOldToolOutputs(contents, 2)

    expect(outputOf(trimmed[0])).toContain('[output trimmed]')
    expect(outputOf(contents[0])).toBe(big)
    expect(trimmed[1]).toBe(contents[1])
    expect(outputOf(trimmed[2])).toBe(big)
  })
})

describe('Step A: removing duplicate old results', () => {
  it('replaces a repeated old result with a note naming the earlier tool', () => {
    const output = 'd'.repeat(500)
    const contents = [toolResult(output), model('again'), toolResult(output)]

    const deduped = dedupeOldToolOutputs(contents, 3)

    expect(outputOf(deduped[0])).toBe(output)
    expect(outputOf(deduped[2])).toContain('duplicate output removed')
    expect(outputOf(deduped[2])).toContain('read_file')
  })

  it('never touches short results or the recent side', () => {
    const short = 'small output'
    const repeated = 'r'.repeat(500)
    const contents = [
      toolResult(short),
      user('q'),
      toolResult(short),
      toolResult(repeated),
      toolResult(repeated)
    ]

    const deduped = dedupeOldToolOutputs(contents, 3)

    expect(outputOf(deduped[0])).toBe(short)
    expect(outputOf(deduped[2])).toBe(short)
    expect(outputOf(deduped[4])).toBe(repeated)
    expect(outputOf(contents[4])).toBe(repeated)
  })
})

describe('the recent side boundary', () => {
  it('counts real user requests, not function-response entries', () => {
    const contents = [
      user('one'),
      model('a'),
      toolResult('r'),
      model('b'),
      user('two'),
      model('c'),
      toolResult('r2'),
      user('three'),
      model('d')
    ]

    expect(recentBoundaryIndex(contents, 1)).toBe(7)
    expect(recentBoundaryIndex(contents, 2)).toBe(4)
    expect(recentBoundaryIndex(contents, 10)).toBe(0)
    expect(recentBoundaryIndex([model('only'), toolResult('r')], 2)).toBe(0)
  })
})

describe('building the split for Step B', () => {
  const conversation = [
    user('turn one'),
    model('a'),
    toolResult('r1'),
    user('turn two'),
    model('b'),
    toolCallContent(),
    toolResult('r2'),
    model('c'),
    user('turn three'),
    model('d')
  ]

  function toolCallContent(): Content {
    return { role: 'model', parts: [{ function_call: { name: 'read_file', args: {} } }] }
  }

  it('always lands on a user request and never separates a call from its result', () => {
    const split = planCompactionSplit(conversation, 0, 1, 100_000, 100)

    expect(split).not.toBeNull()
    expect(conversation[split as number].role).toBe('user')
    expect(conversation[split as number].parts?.[0].text).toBe('turn three')
    expect(conversation[5].parts?.[0].function_call?.name).toBe('read_file')
    expect(conversation[6].parts?.[0].function_response?.name).toBe('read_file')
  })

  it('keeps the requested number of recent turns when they fit the target', () => {
    expect(planCompactionSplit(conversation, 0, 2, 100_000, 100)).toBe(3)
  })

  it('summarizes further turns when the kept side is still over target', () => {
    const split = planCompactionSplit(conversation, 0, 2, 1, 100)
    expect(split).toBe(8)
  })

  it('refuses a split when there is only one request to work with', () => {
    expect(
      planCompactionSplit([user('one'), model('a'), toolResult('r')], 0, 1, 100, 100)
    ).toBeNull()
    expect(planCompactionSplit([], 0, 1, 100, 100)).toBeNull()
  })

  it('never moves backwards past the previous split', () => {
    const split = planCompactionSplit(conversation, 3, 5, 100_000, 100)
    expect(split).toBe(8)
  })
})

describe('the summary request', () => {
  it('strips the turn framing and describes calls and results', () => {
    const contents: Content[] = [
      user('Active Function Suite: all | Active Mode: build\nUser Request:\nFix the parser'),
      {
        role: 'model',
        parts: [
          { text: 'Reading the file.' },
          { function_call: { name: 'read_file', args: { path: 'src/parser.ts' } } }
        ]
      },
      toolResult('export function parse() {}'),
      user('Active Function Suite: all | Active Mode: build\nUser Request:\nNow add a test')
    ]

    const transcript = buildSummaryTranscript(contents)

    expect(transcript).toContain('User:\nFix the parser')
    expect(transcript).not.toContain('Active Function Suite')
    expect(transcript).toContain('Tool call read_file')
    expect(transcript).toContain('src/parser.ts')
    expect(transcript).toContain('Tool results:')
    expect(transcript).toContain('export function parse')
    expect(transcript).toContain('Now add a test')
  })

  it('caps the transcript and says the oldest lines were omitted', () => {
    const contents = Array.from({ length: 3_000 }, (_, index) =>
      user(`Request ${index} ${'y'.repeat(200)}`)
    )
    const transcript = buildSummaryTranscript(contents)

    expect(transcript.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_MAX_CHARS + 200)
    expect(transcript.startsWith('[... earliest messages omitted')).toBe(true)
  })

  it('batches an oversized region in order instead of dropping its oldest messages', () => {
    const contents = Array.from({ length: 600 }, (_, index) =>
      user(`Request ${index} ${'y'.repeat(200)}`)
    )
    const chunks = chunkSummaryTranscript(contents, SUMMARY_TRANSCRIPT_MAX_CHARS)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= SUMMARY_TRANSCRIPT_MAX_CHARS)).toBe(true)
    expect(chunks[0]).toContain('Request 0')
    expect(chunks[chunks.length - 1]).toContain('Request 599')
  })

  it('redacts common secrets before they reach a summary', () => {
    const text = [
      'key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123',
      'sk-abcdefghijklmnop123456',
      'Authorization: Bearer abcdefghijklmnop',
      'password: hunter2hunter2'
    ].join('\n')

    const clean = redactSecrets(text)

    expect(clean).not.toContain('AIzaSy')
    expect(clean).not.toContain('sk-abcdefghijklmnop')
    expect(clean).not.toContain('abcdefghijklmnop')
    expect(clean).not.toContain('hunter2hunter2')
    expect(clean).toContain('[redacted')
  })

  it('asks for one merged structured summary and includes the previous one', () => {
    const prompt = buildSummaryPrompt('PREVIOUS SUMMARY', 'NEW MESSAGES')

    for (const section of [
      '## User Goal',
      '## Current Task',
      '## Decisions & Preferences',
      '## Files (created / edited / deleted)',
      '## Commands & Results',
      '## Errors & Fixes',
      '## Current State',
      '## Unfinished Tasks / Next Steps'
    ]) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain('Merge, do not stack')
    expect(prompt).toContain('Never invent')
    expect(prompt).toContain('API keys')
    expect(prompt).toContain('PREVIOUS SUMMARY')
    expect(prompt).toContain('NEW MESSAGES')
    expect(buildSummaryPrompt(null, 'MESSAGES')).toContain('(none yet)')
  })
})

describe('the last-resort hard trim', () => {
  it('shortens an oversized result copy to fit the budget', () => {
    const contents = [toolResult('q'.repeat(40_000))]
    const trimmed = hardTrimContents(contents, 1_000)

    expect(outputOf(trimmed[0])).toContain('trimmed to fit the model context window')
    expect(estimateContentsTokens(trimmed)).toBeLessThanOrEqual(1_000)
    expect(contents[0].parts?.[0].function_response?.response?.['output']).toBe('q'.repeat(40_000))
  })

  it('shortens the latest message instead of dropping it', () => {
    const contents = [user('important latest request ' + 'z'.repeat(50_000))]
    const trimmed = hardTrimContents(contents, 2_000)

    expect(trimmed).toHaveLength(1)
    expect(trimmed[0].parts?.[0].text).toContain('important latest request')
    expect(trimmed[0].parts?.[0].text).toContain('message trimmed to fit the model context window')
    expect(estimateContentsTokens(trimmed)).toBeLessThanOrEqual(2_000)
    expect(contents[0].parts?.[0].text).toHaveLength(50_025)
  })
})

describe('the compaction engine', () => {
  it('does nothing below the threshold', async () => {
    const run = harness({
      contents: [user('hello'), model('hi'), user('again'), model('sure')]
    })

    const result = await run.compactor.prepareBeforeTurn()

    expect(result).toBeNull()
    expect(run.storeRows).toHaveLength(0)
    expect(run.calls).toHaveLength(0)
    expect(run.starts).toHaveLength(0)
  })

  it('compacts automatically, keeps the recent turns and saves one transaction', async () => {
    const run = harness({ contents: longConversation() })

    const result = await run.compactor.prepareBeforeTurn()

    expect(result?.status).toBe('success')
    expect(run.state.historySummary).toBe(SUMMARY)
    expect(run.state.compactionSplitIndex).toBe(20)
    expect(run.state.contents).toHaveLength(24)
    expect(run.storeRows).toHaveLength(1)
    expect(run.storeRows[0]).toMatchObject({
      trigger: 'auto',
      status: 'success',
      summary: SUMMARY,
      split_content_index: 20,
      model_used: 'gemini-3.5-flash-lite'
    })
    expect(run.storeRows[0].tokens_before).toBeGreaterThan(run.storeRows[0].tokens_after)
    expect(run.starts[0].beforePercent).toBeGreaterThanOrEqual(80)
    expect(run.finishes[0].status).toBe('success')
    expect(run.finishes[0].afterPercent).toBeLessThan(run.finishes[0].beforePercent)

    await run.compactor.prepareBeforeTurn()
    expect(run.storeRows).toHaveLength(1)
  })

  it('rolls the previous summary into the new one instead of stacking summaries', async () => {
    const run = harness({
      contents: longConversation(),
      historySummary: 'PREVIOUS SUMMARY'
    })

    const result = await run.compactor.prepareBeforeTurn()

    expect(result?.status).toBe('success')
    expect(run.calls[0].prompt).toContain('PREVIOUS SUMMARY')
    expect(run.calls[0].prompt).toContain('Turn 0')
    expect(run.state.historySummary).toBe(SUMMARY)
    expect(run.storeRows).toHaveLength(1)
  })

  it('falls back to the next summarizer model when the configured one fails', async () => {
    const run = harness({
      contents: longConversation(),
      settings: { summarizerModel: 'summarizer-a' },
      generate: (model) => {
        if (model === 'summarizer-a' || model === 'gemini-3.5-flash-lite') {
          throw new Error('quota exceeded')
        }
        return SUMMARY
      }
    })

    const result = await run.compactor.prepareBeforeTurn()

    expect(result?.status).toBe('success')
    expect(result?.modelUsed).toBe('gemini-3.1-flash-lite')
    expect(run.calls.map((call) => call.model)).toEqual([
      'summarizer-a',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite'
    ])
    expect(run.storeRows[0].model_used).toBe('gemini-3.1-flash-lite')
  })

  it('keeps the original history when every summarizer model fails', async () => {
    const contents = longConversation()
    const run = harness({
      contents,
      settings: { summarizerModel: 'summarizer-a' },
      generate: () => {
        throw new Error('model down')
      }
    })

    const result = await run.compactor.prepareBeforeTurn()

    expect(result?.status).toBe('failed')
    expect(result?.summary).toBeNull()
    expect(run.state.historySummary).toBeNull()
    expect(run.state.compactionSplitIndex).toBe(0)
    expect(run.state.contents).toHaveLength(24)
    expect(run.storeRows).toHaveLength(1)
    expect(run.storeRows[0]).toMatchObject({ status: 'failed', error: 'model down' })
    expect(run.notices).toHaveLength(1)
    expect(run.notices[0].isError).toBe(true)
    expect(run.notices[0].text).toContain('original history is untouched')
  })

  it('reports a manual compaction with nothing older to summarize', async () => {
    const run = harness({ contents: [user('only request'), model('answer')] })

    const result = await run.compactor.compactNow('manual')

    expect(result).toBeNull()
    expect(run.storeRows).toHaveLength(0)
    expect(run.notices[0].text).toContain('Nothing older to compact yet')
  })

  it('runs only one compaction when two are requested at once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = harness({
      contents: longConversation(),
      generate: async () => {
        await gate
        return SUMMARY
      }
    })

    const first = run.compactor.compactNow('manual')
    const second = run.compactor.compactNow('manual')

    expect(run.calls).toHaveLength(1)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a).toBe(b)
    expect(run.storeRows).toHaveLength(1)
    expect(run.starts).toHaveLength(1)
  })

  it('lets Step A avoid a summary when trimming alone brings the old side under target', async () => {
    const duplicate = 'z'.repeat(5_000)
    const contents = [
      user('turn one'),
      model('a'),
      toolResult(duplicate),
      user('turn two'),
      model('b'),
      toolResult(duplicate),
      user('turn three'),
      model('c')
    ]
    const run = harness({
      contents,
      model: 'text-embedding-004'
    })

    const result = await run.compactor.compactNow('auto')

    expect(result).toBeNull()
    expect(run.calls).toHaveLength(0)
    expect(run.storeRows).toHaveLength(0)
    expect(run.starts).toHaveLength(0)
  })

  it('compacts further before a fallback model with a smaller window', async () => {
    const contents: Content[] = []
    for (let index = 0; index < 6; index++) {
      contents.push(
        user(`Active Function Suite: all | Active Mode: build\nUser Request:\n${'w'.repeat(4_000)}`)
      )
      contents.push(model('done'))
    }
    const run = harness({
      contents,
      overhead: (model) => (model === 'gemini-2.5-flash-image' ? 30_000 : 100)
    })

    const primary = await run.compactor.prepareRequest('gemini-3.1-flash-lite')
    expect(primary.contents).toHaveLength(12)
    expect(run.storeRows).toHaveLength(0)

    const fallback = await run.compactor.prepareRequest('gemini-2.5-flash-image')

    expect(run.storeRows).toHaveLength(1)
    expect(run.starts[0].trigger).toBe('auto')
    expect(fallback.budget).toBe(32_768)
    expect(fallback.contents).toHaveLength(2)
    expect(fallback.tokens).toBeLessThanOrEqual(fallback.budget)
    expect(run.state.compactionSplitIndex).toBe(10)
  })

  it('measures the transient digest and never reports more than the budget', () => {
    const contents: Content[] = []
    for (let index = 0; index < 60; index++) {
      contents.push(user(`Request ${index} ${'v'.repeat(300)}`))
      contents.push(model('ok'))
    }
    const run = harness({
      contents,
      model: 'gemini-2.5-flash-image',
      overhead: 28_000
    })

    const usage = run.compactor.contextUsage('gemini-2.5-flash-image')

    expect(usage.budgetTokens).toBe(32_768)
    expect(usage.limitTokens).toBe(32_768)
    expect(usage.usedTokens).toBeLessThanOrEqual(usage.budgetTokens)
    expect(usage.thresholdPercent).toBe(80)
  })

  it('estimates the summary prompt itself', () => {
    const transcript = buildSummaryTranscript([user('hello')])
    expect(estimateTextTokens(buildSummaryPrompt(null, transcript))).toBeGreaterThan(0)
  })
})

describe('rolling history back across a split', () => {
  const contents = (count: number): Content[] =>
    Array.from({ length: count }, () => ({})) as Content[]

  it('clears the summary when the rollback removes entries the split kept', () => {
    const state = new AgentState('C:/workspace/demo', 'gemini-3.5-flash')
    state.contents = contents(4)
    state.historySummary = 'SUMMARY'
    state.compactionSplitIndex = 3
    state.requestDigest = 'digest'
    const callback: Array<{ length: number; reset: boolean }> = []
    state.onContentsTruncated = (length, reset) => callback.push({ length, reset })

    state.truncateContents(2)

    expect(state.contents).toHaveLength(2)
    expect(state.historySummary).toBeNull()
    expect(state.compactionSplitIndex).toBe(0)
    expect(state.requestDigest).toBeNull()
    expect(callback).toEqual([{ length: 2, reset: true }])
  })

  it('keeps a split that still has all of its kept entries', () => {
    const state = new AgentState('C:/workspace/demo', 'gemini-3.5-flash')
    state.contents = contents(4)
    state.historySummary = 'SUMMARY'
    state.compactionSplitIndex = 2
    const callback: Array<{ length: number; reset: boolean }> = []
    state.onContentsTruncated = (length, reset) => callback.push({ length, reset })

    state.truncateContents(3)

    expect(state.historySummary).toBe('SUMMARY')
    expect(state.compactionSplitIndex).toBe(2)
    expect(callback).toEqual([{ length: 3, reset: false }])
  })
})
