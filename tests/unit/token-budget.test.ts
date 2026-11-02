import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { EffortLevel } from '../../src/shared/models/effort-level'
import { pyFormatThousands } from '../../src/shared/utils/pyformat'
import { AgentSystem } from '../../src/main/services/agent-system.service'
import { compactHistory } from '../../src/main/services/agent-generate.service'
import type { AgentState } from '../../src/main/models/agent-state'
import type { Content, Part } from '../../src/main/models/content'
import type { AgentMemory } from '../../src/main/services/agent-memory.service'
import type { AgentPaths } from '../../src/main/services/agent-paths.service'
import type { ModelController } from '../../src/main/controllers/model-controller.service'

/**
 * What one request costs before the model says anything. The memory feed and the tool results a
 * turn drags behind it are the two parts that grow without the user noticing, so both are bounded
 * here. The v1.0 prompt strings themselves stay byte-identical — only how much of them is sent.
 */

let roots: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-budget-'))
  roots.push(dir)
  return dir
}

function systemWith(memoryText: string, effort: EffortLevel | null = null): AgentSystem {
  const memory = {
    memoryPath: async () => join('memory', 'memory.md'),
    readMemoryContent: async () => memoryText
  } as unknown as AgentMemory
  const controller = effort ? ({ currentEffort: effort } as unknown as ModelController) : null
  return new AgentSystem({
    paths: {} as unknown as AgentPaths,
    memory,
    modelController: () => controller
  })
}

function stateFor(dir: string): AgentState {
  return {
    root: dir,
    appRoot: dir,
    mode: 'build',
    activeFunction: 'all'
  } as unknown as AgentState
}

function toolResult(text: string): Content {
  const parts: Part[] = [{ function_response: { name: 'read_file', response: { output: text } } }]
  return { role: 'user', parts }
}

function outputOf(content: Content): string {
  const part = content.parts?.[0] as
    { function_response?: { response?: Record<string, unknown> } } | undefined
  return String(part?.function_response?.response?.output ?? '')
}

function totalOutput(contents: Content[]): number {
  return contents.reduce((sum, content) => sum + outputOf(content).length, 0)
}

afterEach(async () => {
  const pending = roots
  roots = []
  for (const dir of pending) await rm(dir, { recursive: true, force: true })
})

describe('the memory feed', () => {
  it('sends the recent end of a long memory file and says what it left out', async () => {
    const dir = await workspace()
    const memory = `OLDEST ENTRY\n${'entry\n'.repeat(20000)}NEWEST LINE`
    const system = await systemWith(memory).buildSystem(stateFor(dir))
    const omitted = memory.length - AppConstants.MEMORY_PROMPT_CHARS

    expect(system).toContain('NEWEST LINE')
    expect(system).not.toContain('OLDEST ENTRY')
    expect(system).toContain(`[... ${pyFormatThousands(omitted)} older characters omitted ...]`)
  })

  it('keeps a short memory file whole with no omission note', async () => {
    const dir = await workspace()
    const system = await systemWith('just a note').buildSystem(stateFor(dir))
    expect(system).toContain('just a note')
    expect(system).not.toContain('older characters omitted')
  })

  it('caps the feed at the budget instead of the 60k characters v1.0 uploaded', async () => {
    const dir = await workspace()
    const system = await systemWith('x'.repeat(200000)).buildSystem(stateFor(dir))
    expect(system).toContain(`\n${'x'.repeat(AppConstants.MEMORY_PROMPT_CHARS)}`)
    expect(system).not.toContain(`\n${'x'.repeat(AppConstants.MEMORY_PROMPT_CHARS + 1)}`)
    // The whole prompt, memory feed included, stays under half of what v1.0's memory feed alone
    // uploaded on every step.
    expect(system.length).toBeLessThan(30000)
  })

  it('feeds Saving effort a fifth of the memory the other efforts get', async () => {
    const dir = await workspace()
    const memory = 'x'.repeat(200000)
    const saving = await systemWith(memory, EffortLevel.SAVING).buildSystem(stateFor(dir))
    const balanced = await systemWith(memory, EffortLevel.MEDIUM).buildSystem(stateFor(dir))

    expect(saving).toContain(`\n${'x'.repeat(AppConstants.SAVING_MEMORY_PROMPT_CHARS)}`)
    expect(saving.length).toBeLessThan(balanced.length)
  })

  it('keeps the wide window for every other effort', async () => {
    const dir = await workspace()
    for (const level of [EffortLevel.TURBO, EffortLevel.LOW, EffortLevel.EXTRA_HIGH]) {
      const system = await systemWith('x'.repeat(200000), level).buildSystem(stateFor(dir))
      expect(system, level.value).toContain(`\n${'x'.repeat(AppConstants.MEMORY_PROMPT_CHARS)}`)
    }
  })
})

describe('the tool results a turn drags along', () => {
  it('leaves a short turn completely alone', () => {
    const contents = [toolResult('y'.repeat(30000)), toolResult('z'.repeat(30000))]
    expect(compactHistory(contents)).toBe(contents)
  })

  it('shrinks an old oversized result but keeps its head and tail', () => {
    const big = `${'HEAD'.padEnd(2000, 'a')}${'MIDDLE'.repeat(4000)}${'b'.repeat(2000)}`
    const contents: Content[] = []
    for (let i = 0; i < 20; i++) contents.push(toolResult(i === 0 ? big : 'small'))

    const compacted = compactHistory(contents)
    const output = outputOf(compacted[0])

    expect(output).toContain('characters of an older tool result')
    expect(output.startsWith('HEAD')).toBe(true)
    expect(output.endsWith('bb')).toBe(true)
    expect(output.length).toBeLessThan(1000)
    expect(totalOutput(compacted)).toBeLessThan(totalOutput(contents) / 2)
  })

  it('never shortens the live tail of the turn', () => {
    const contents: Content[] = Array.from({ length: 14 }, () => toolResult('q'.repeat(30000)))

    const compacted = compactHistory(contents)

    for (const content of compacted.slice(-12)) expect(outputOf(content)).toHaveLength(30000)
  })

  it('shortens the live tail to six entries under Saving effort', () => {
    const contents: Content[] = Array.from({ length: 14 }, () => toolResult('q'.repeat(30000)))

    const saving = compactHistory(contents, AppConstants.SAVING_HISTORY_KEEP_ENTRIES)
    const normal = compactHistory(contents)

    for (const content of saving.slice(-6)) expect(outputOf(content)).toHaveLength(30000)
    expect(outputOf(saving[0])).toContain('elided')
    expect(totalOutput(saving)).toBeLessThan(totalOutput(normal))
  })

  it('hands the API a copy and leaves the saved history untouched', () => {
    const contents: Content[] = Array.from({ length: 20 }, () => toolResult('w'.repeat(30000)))

    const compacted = compactHistory(contents)

    expect(totalOutput(compacted)).toBeLessThan(totalOutput(contents))
    expect(totalOutput(contents)).toBe(30000 * 20)
    expect(contents[0]).not.toBe(compacted[0])
  })

  it('ignores parts that are not a tool result', () => {
    const prose: Content = { role: 'model', parts: [{ text: 'x'.repeat(30000) }] }
    const contents: Content[] = Array.from({ length: 20 }, (_, i) =>
      i === 0 ? prose : toolResult('small')
    )

    const compacted = compactHistory(contents)

    expect(outputOf(compacted[0])).toBe('')
    expect(compacted[0].parts?.[0].text).toHaveLength(30000)
  })
})
