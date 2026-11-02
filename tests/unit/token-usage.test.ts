import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Content } from '../../src/main/models/content'
import { closeDatabase, getDatabase } from '../../src/main/services/database.service'
import {
  estimateRequestBreakdown,
  tokenUsageRepository
} from '../../src/main/services/token-usage.service'

function tokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function jsonTokens(value: unknown): number {
  return tokens(JSON.stringify(value))
}

function seedConversation(id: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run(id, id, 1, 1)
}

beforeEach(() => {
  closeDatabase()
  getDatabase()
})

afterEach(() => {
  closeDatabase()
})

describe('token_usage schema', () => {
  it('migrates to v11 with the usage table and indexes', () => {
    const db = getDatabase()
    expect(db.pragma('user_version', { simple: true })).toBe(11)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_usage'")
      .get() as { name: string } | undefined
    expect(table?.name).toBe('token_usage')
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'token_usage'"
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_token_usage_conversation',
        'idx_token_usage_created',
        'idx_token_usage_model'
      ])
    )
  })
})

describe('estimateRequestBreakdown', () => {
  it('splits system, memory, summary, history, tools and the new message', () => {
    const systemInstruction = 'S'.repeat(400)
    const toolDeclarations = [{ name: 'read_file', description: 'Read a file.' }]
    const functionCall = { name: 'read_file', args: { path: 'src/app.ts' } }
    const toolOutput = '0123456789'.repeat(5)
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'old question' }] },
      { role: 'model', parts: [{ text: 'old answer' }] },
      { role: 'user', parts: [{ text: 'new question' }] },
      {
        role: 'model',
        parts: [
          { function_call: functionCall },
          { inline_data: { mime_type: 'image/png', data: 'x' } }
        ]
      },
      {
        role: 'user',
        parts: [{ function_response: { name: 'read_file', response: { output: toolOutput } } }]
      },
      { role: 'model', parts: [{ executable_code: { language: 'python', code: 'print(1)' } }] }
    ]

    const breakdown = estimateRequestBreakdown({
      systemInstruction,
      toolDeclarations,
      contents,
      memoryChars: 200,
      summaryChars: 80
    })

    expect(breakdown.memory).toBe(50)
    expect(breakdown.summary).toBe(20)
    expect(breakdown.system).toBe(100 - 50 - 20)
    expect(breakdown.toolDefinitions).toBe(jsonTokens(toolDeclarations))
    expect(breakdown.history).toBe(tokens('old question') + tokens('old answer'))
    expect(breakdown.newMessage).toBe(tokens('new question'))
    expect(breakdown.toolCalls).toBe(jsonTokens(functionCall))
    expect(breakdown.toolResults).toBe(tokens(toolOutput))
    expect(breakdown.media).toBe(258)
    expect(breakdown.other).toBe(jsonTokens({ language: 'python', code: 'print(1)' }))
  })

  it('does not split memory beyond the measured system prompt', () => {
    const breakdown = estimateRequestBreakdown({
      systemInstruction: 'S'.repeat(40),
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      memoryChars: 10_000,
      summaryChars: 10_000
    })
    expect(breakdown.memory).toBe(10)
    expect(breakdown.summary).toBe(0)
    expect(breakdown.system).toBe(0)
  })
})

describe('TokenUsageRepository', () => {
  it('stores counts, clamps cached input and groups by conversation, model and sender', () => {
    seedConversation('c1')
    seedConversation('c2')
    tokenUsageRepository.record({
      conversationId: 'c1',
      sender: 'main',
      kind: 'chat',
      label: 'turn',
      model: 'model-a',
      requestedModel: 'model-a',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      thoughtTokens: 5,
      totalTokens: 155,
      estimated: false,
      breakdown: null
    })
    tokenUsageRepository.record({
      conversationId: 'c1',
      sender: 'sub-agent 1',
      kind: 'chat',
      label: 'sub-task',
      model: 'model-b',
      requestedModel: 'model-b',
      inputTokens: 200,
      outputTokens: 10,
      cachedTokens: 999,
      thoughtTokens: 0,
      totalTokens: 0,
      estimated: true,
      breakdown: null
    })
    tokenUsageRepository.record({
      conversationId: 'c2',
      sender: 'compaction',
      kind: 'compaction',
      label: 'summarizer',
      model: 'model-a',
      requestedModel: 'model-a',
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      thoughtTokens: 0,
      totalTokens: 600,
      estimated: false,
      breakdown: null
    })

    const c1 = tokenUsageRepository.summary('c1', 5)
    expect(c1.requests).toBe(2)
    expect(c1.estimatedRequests).toBe(1)
    expect(c1.inputTokens).toBe(300)
    expect(c1.outputTokens).toBe(60)
    expect(c1.cachedTokens).toBe(220)
    expect(c1.thoughtTokens).toBe(5)
    expect(c1.totalTokens).toBe(155 + 210)
    expect(c1.byModel.map((group) => group.key)).toEqual(['model-b', 'model-a'])
    expect(c1.bySender.map((group) => group.key)).toEqual(['sub-agent 1', 'main'])
    expect(c1.biggest).toHaveLength(2)
    expect(c1.biggest[0].inputTokens).toBe(200)

    const all = tokenUsageRepository.totals(null)
    expect(all.requests).toBe(3)
    expect(all.inputTokens).toBe(800)

    const other = tokenUsageRepository.totals('c2')
    expect(other.requests).toBe(1)
    expect(other.totalTokens).toBe(600)
  })

  it('recomputes a missing total and drops usage with its conversation', () => {
    seedConversation('c1')
    tokenUsageRepository.record({
      conversationId: 'c1',
      sender: 'main',
      kind: 'chat',
      label: 'turn',
      model: 'model-a',
      requestedModel: null,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 250,
      thoughtTokens: 0,
      totalTokens: 0,
      estimated: false,
      breakdown: null
    })
    const [row] = tokenUsageRepository.summary('c1', 1).biggest
    expect(row.cachedTokens).toBe(100)
    expect(row.totalTokens).toBe(120)

    getDatabase().prepare('DELETE FROM conversations WHERE id = ?').run('c1')
    expect(tokenUsageRepository.totals('c1').requests).toBe(0)
  })

  it('keeps only counts and labels, never prompt text', () => {
    seedConversation('c1')
    tokenUsageRepository.record({
      conversationId: 'c1',
      sender: 'main',
      kind: 'chat',
      label: 'turn',
      model: 'model-a',
      requestedModel: 'model-a',
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      thoughtTokens: 0,
      totalTokens: 15,
      estimated: false,
      breakdown: {
        system: 1,
        memory: 2,
        summary: 3,
        history: 4,
        toolDefinitions: 5,
        toolResults: 6,
        toolCalls: 7,
        newMessage: 8,
        media: 0,
        other: 0
      }
    })
    const row = getDatabase()
      .prepare('SELECT * FROM token_usage LIMIT 1')
      .get() as Record<string, unknown>
    const serialized = JSON.stringify(row)
    expect(serialized).not.toMatch(/system prompt|user message|function_response/)
    expect(Object.keys(JSON.parse(String(row.breakdown_json)) as object).sort()).toEqual([
      'history',
      'media',
      'memory',
      'newMessage',
      'other',
      'summary',
      'system',
      'toolCalls',
      'toolDefinitions',
      'toolResults'
    ])
  })
})
