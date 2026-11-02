import { describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { buildMemoryEntry, type MemoryTurn } from '../../src/shared/utils/memory-entry'
import { buildMemoryHistoryReport } from '../../src/shared/utils/memory-report'

const FIRST: MemoryTurn = {
  timestamp: '2026-10-24 10:00:00 (Saturday, October 24, 2026 10:00:00 AM)',
  mode: 'chat',
  activeFunction: 'all',
  model: 'gemini-3.1-flash-lite',
  userPrompt: 'Explain the memory journal format',
  aiResponses: ['The journal stores each turn with its prompt, response, tools and diffs.'],
  turnToolLogs: [{ tool: 'read_file', args: { path: 'README.md' }, raw_output: 'read ok' }],
  turnFileChanges: []
}

const SECOND: MemoryTurn = {
  timestamp: '2026-10-24 16:03:27 (Saturday, October 24, 2026 04:03:27 PM)',
  mode: 'build',
  activeFunction: 'pip_installer',
  model: 'qwen3-coder-plus',
  userPrompt: 'Fix the login bug in src/auth.ts\nmake it robust',
  aiResponses: ['Fixed the guard and reran the tests.'],
  turnToolLogs: [
    { tool: 'read_file', args: { path: 'src/auth.ts' }, raw_output: 'read ok' },
    {
      tool: 'write_file',
      args: { path: 'src/auth.ts' },
      raw_output: 'permission denied',
      is_error: true
    },
    { tool: 'write_file', args: { path: 'src/auth.ts' }, raw_output: 'written' }
  ],
  turnFileChanges: [
    {
      action: 'update',
      path: 'src/auth.ts',
      diff: '- if (token) {\n+ if (token && user) {',
      new_content: 'export const guard = true\n',
      old_content: 'export const guard = false\n'
    }
  ]
}

describe('buildMemoryHistoryReport', () => {
  it('turns the journal into organized markdown with storage, totals and the latest turn', () => {
    const text = AppConstants.MEMORY_HEADER + buildMemoryEntry(FIRST) + buildMemoryEntry(SECOND)
    const report = buildMemoryHistoryReport({
      text,
      database: 'C:\\data\\gemibot.db',
      documentKey: 'app_demo'
    })

    expect(report).toContain('# Memory History')
    expect(report).not.toContain('**')
    expect(report).not.toContain('`')
    expect(report).toContain('## Storage')
    expect(report).toContain('- Database: C:\\data\\gemibot.db')
    expect(report).toContain('- Document key: app_demo')
    expect(report).toContain('- Backend: SQLite conversation database')
    expect(report).toMatch(/- Journal size: [\d,]+ chars across [\d,]+ lines/)

    expect(report).toContain('## Journal')
    expect(report).toContain('- Logged Interactions: 2')
    expect(report).toContain('- Oldest entry: 2026-10-24 10:00:00')
    expect(report).toContain('- Newest entry: 2026-10-24 16:03:27')
    expect(report).toMatch(/- Average entry: [\d,]+ chars/)
    expect(report).toContain('- Tool executions: 4 · failed: write_file')
    expect(report).toContain('- File changes: 1 · 1 update')

    expect(report).toContain('## Latest interaction')
    expect(report).toContain('- Logged at: 2026-10-24 16:03:27')
    expect(report).toContain('- Mode: BUILD')
    expect(report).toContain('- Function suite: pip_installer')
    expect(report).toContain('- Model: qwen3-coder-plus')
    expect(report).toContain('- Prompt: Fix the login bug in src/auth.ts make it robust')
    expect(report).toContain(
      '- Tools: 3 executions · read_file, write_file ×2 · failed: write_file'
    )
    expect(report).toContain('- Files: 1 change · update src/auth.ts')

    expect(report).toContain('## Recent interactions')
    expect(report).toContain(
      '- 2026-10-24 16:03:27 · BUILD · pip_installer · ' +
        'Fix the login bug in src/auth.ts make it robust'
    )
    expect(report).toContain(
      '- 2026-10-24 10:00:00 · CHAT · all · Explain the memory journal format'
    )
  })

  it('keeps the empty journal readable', () => {
    const report = buildMemoryHistoryReport({
      text: AppConstants.MEMORY_HEADER,
      database: '/tmp/gemibot.db',
      documentKey: 'app_empty'
    })

    expect(report).toContain('- Logged Interactions: 0')
    expect(report).toContain(
      '- No interactions logged yet. Each completed turn is appended automatically.'
    )
    expect(report).not.toContain('## Latest interaction')
    expect(report).not.toContain('## Recent interactions')
  })

  it('reads prompts that start with a fenced code block without leaking fence markers', () => {
    const turn: MemoryTurn = {
      ...FIRST,
      timestamp: '2026-10-24 12:00:00 (Saturday, October 24, 2026 12:00:00 PM)',
      userPrompt: '```ts\nconst answer = 42\n```'
    }
    const report = buildMemoryHistoryReport({
      text: AppConstants.MEMORY_HEADER + buildMemoryEntry(turn),
      database: '/tmp/gemibot.db',
      documentKey: 'app_prompt'
    })

    expect(report).toContain('- Prompt: const answer = 42')
    expect(report).not.toContain('```')
  })

  it('ignores entry markers pasted inside a fenced user prompt', () => {
    const decoy: MemoryTurn = {
      ...FIRST,
      timestamp: '2026-10-22 11:00:00 (Thursday, October 22, 2026 11:00:00 AM)',
      userPrompt:
        'What does this format mean?\n## Interaction Log - 1999-01-01 00:00:00\n- **Mode:** `FAKE`'
    }
    const report = buildMemoryHistoryReport({
      text: AppConstants.MEMORY_HEADER + buildMemoryEntry(decoy) + buildMemoryEntry(SECOND),
      database: '/tmp/gemibot.db',
      documentKey: 'app_decoy'
    })

    expect(report).toContain('- Logged Interactions: 2')
    expect(report).toContain('- Oldest entry: 2026-10-22 11:00:00')
    expect(report).not.toContain('- Oldest entry: 1999')
    expect(report).toContain('- Newest entry: 2026-10-24 16:03:27')
    expect(report).toContain('- Mode: BUILD')
  })

  it('shortens a long prompt and skips the recent list for a single entry', () => {
    const turn: MemoryTurn = {
      ...FIRST,
      timestamp: '2026-10-24 12:00:00 (Saturday, October 24, 2026 12:00:00 PM)',
      userPrompt: 'a'.repeat(300)
    }
    const report = buildMemoryHistoryReport({
      text: AppConstants.MEMORY_HEADER + buildMemoryEntry(turn),
      database: '/tmp/gemibot.db',
      documentKey: 'app_long'
    })

    expect(report).toContain(`- Prompt: ${'a'.repeat(159)}…`)
    expect(report).not.toContain('- Prompt: ' + 'a'.repeat(300))
    expect(report).not.toContain('## Recent interactions')
  })
})
