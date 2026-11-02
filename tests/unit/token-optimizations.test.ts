import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ALL_DECLARATIONS } from '../../src/shared/constants/tool-definitions'
import { normalizeTokenSettings } from '../../src/shared/utils/token-settings'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { fitToolOutput } from '../../src/main/utils/tool-output'
import { Agent } from '../../src/main/services/agent.service'
import { AgentSystem } from '../../src/main/services/agent-system.service'
import type { AgentState } from '../../src/main/models/agent-state'
import type { AgentMemory } from '../../src/main/services/agent-memory.service'
import type { AgentPaths } from '../../src/main/services/agent-paths.service'

/**
 * The parts of the token-efficiency layer that reshape a request: relevant memory, slim tool
 * schemas, the stable prompt order, bounded tool output, repeated-read reuse and the loop guard.
 * None of this may change the transcript, the timeline or a direct tool dispatch.
 */

let roots: string[] = []
let detach: (() => void) | null = null

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-opt-'))
  roots.push(dir)
  return dir
}

function systemWith(memoryText: string): AgentSystem {
  const memory = {
    memoryPath: async () => join('memory', 'memory.md'),
    readMemoryContent: async () => memoryText
  } as unknown as AgentMemory
  return new AgentSystem({
    paths: {} as unknown as AgentPaths,
    memory,
    modelController: () => null
  })
}

function optimizedState(dir: string): AgentState {
  return {
    root: dir,
    appRoot: dir,
    mode: 'build',
    activeFunction: 'all',
    tokenSettings: normalizeTokenSettings({})
  } as unknown as AgentState
}

beforeEach(() => {
  detach = onConsoleOutput(() => undefined)
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.restoreAllMocks()
  const pending = roots
  roots = []
  for (const dir of pending) await rm(dir, { recursive: true, force: true })
})

describe('memory relevance', () => {
  function memoryWith(sections: number, relevantAt: number): string {
    const blocks: string[] = []
    for (let i = 0; i < sections; i++) {
      const subject = i === relevantAt ? 'refactor_widget_pipeline' : `routine entry ${i}`
      blocks.push(
        `## Interaction Log - 2026-01-${String((i % 28) + 1).padStart(2, '0')}\n` +
          `User Request:\n${subject}\n` +
          'x'.repeat(500)
      )
    }
    return `# System Development Progress\n\n${blocks.join('\n')}`
  }

  it('keeps an older section that matches the request and names what it omitted', async () => {
    const dir = await workspace()
    const state = optimizedState(dir)
    state.tokenSettings = normalizeTokenSettings({ maxMemoryChars: 4_000, memoryRelevance: true })
    const memory = memoryWith(40, 2)

    const system = await systemWith(memory).buildSystem(
      state,
      'Please fix refactor_widget_pipeline in the widget module'
    )

    expect(system).toContain('refactor_widget_pipeline')
    expect(system).toContain('routine entry 39')
    expect(system).toMatch(/older memory sections? omitted/)
    expect(state.memoryPromptChars).toBeGreaterThan(0)
    expect(state.memoryPromptChars).toBeLessThan(5_000)
  })

  it('keeps the newest characters when relevance is turned off', async () => {
    const dir = await workspace()
    const state = optimizedState(dir)
    state.tokenSettings = normalizeTokenSettings({
      maxMemoryChars: 4_000,
      memoryRelevance: false
    })
    const memory = `OLDEST\n${'entry line\n'.repeat(4000)}NEWEST LINE`

    const system = await systemWith(memory).buildSystem(state, 'anything')

    expect(system).toContain('NEWEST LINE')
    expect(system).not.toContain('OLDEST')
    expect(system).toContain('older characters omitted')
  })

  it('puts the changing date after the cacheable blocks and the memory feed', async () => {
    const dir = await workspace()
    const state = optimizedState(dir)
    const system = await systemWith('a note').buildSystem(state, 'hello')

    expect(system).not.toContain('- Today:')
    expect(system).toContain('Current date: ')
    expect(system.indexOf('Current date: ')).toBeGreaterThan(
      system.indexOf('System Development Progress')
    )
  })
})

describe('slim tool declarations', () => {
  function declarationsOf(system: AgentSystem, state: AgentState): Record<string, unknown>[] {
    const config = system.configFor(state, 'gemini-3.5-flash')
    const first = (config.tools ?? [])[0] as {
      functionDeclarations?: Record<string, unknown>[]
    }
    return first.functionDeclarations ?? []
  }

  it('keeps every tool name and shortens the documentation blocks', async () => {
    const dir = await workspace()
    const state = optimizedState(dir)
    const system = systemWith('')
    const declarations = declarationsOf(system, state)

    expect(declarations.map((entry) => entry.name)).toEqual(
      ALL_DECLARATIONS.map((declaration) => declaration.name)
    )
    expect(JSON.stringify(declarations).length).toBeLessThan(JSON.stringify(ALL_DECLARATIONS).length)
    for (const entry of declarations) {
      expect(String(entry.description).length).toBeLessThanOrEqual(160)
    }
  })

  it('leaves the full declarations alone without token settings', async () => {
    const dir = await workspace()
    const state = { ...optimizedState(dir), tokenSettings: null } as AgentState
    const declarations = declarationsOf(systemWith(''), state)
    const image = declarations.find((entry) => entry.name === 'image_generate_uhd') as {
      description: string
    }
    const original = ALL_DECLARATIONS.find((entry) => entry.name === 'image_generate_uhd')
    expect(image.description).toBe(original?.description)
  })

  it('applies the configured output ceiling to the request', async () => {
    const dir = await workspace()
    const state = optimizedState(dir)
    state.tokenSettings = normalizeTokenSettings({ maxOutputTokens: 2048 })
    expect(systemWith('').configFor(state, 'gemini-3.5-flash').maxOutputTokens).toBe(2048)
    state.tokenSettings = normalizeTokenSettings({ maxOutputTokens: 0 })
    expect(systemWith('').configFor(state, 'gemini-3.5-flash').maxOutputTokens).toBeUndefined()
  })
})

describe('bounded tool output', () => {
  it('keeps whole read_file lines and names the offset that continues the read', () => {
    const lines = Array.from(
      { length: 300 },
      (_, index) => `${String(index + 1).padStart(5)}| ${'a'.repeat(80)}`
    )
    const raw = `${lines.join('\n')}\n[lines 1-300 of 300]`

    const output = fitToolOutput('read_file', raw, 2_000)

    expect(output.length).toBeLessThan(2_200)
    expect(output).toContain('call read_file with offset=')
    const body = output.split('\n[truncated:')[0]
    expect(body.split('\n').every((line) => /^\s*\d+\| /u.test(line))).toBe(true)
  })

  it('keeps the head and the tail of terminal output', () => {
    const raw = `HEAD LINE\n${'m'.repeat(20_000)}\nTAIL LINE`
    const output = fitToolOutput('run_command', raw, 2_000)

    expect(output.startsWith('HEAD LINE')).toBe(true)
    expect(output.endsWith('TAIL LINE')).toBe(true)
    expect(output).toContain('characters;')
    expect(output.length).toBeLessThan(2_200)
  })

  it('leaves a result that already fits untouched', () => {
    expect(fitToolOutput('read_file', 'small', 1_000)).toBe('small')
  })
})

describe('per-turn tool reuse and the loop guard', () => {
  async function makeAgent(overrides: Record<string, unknown> = {}): Promise<Agent> {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'alpha\n')
    const agent = await Agent.create({
      root,
      model: 'gemini-3.5-flash',
      autoYes: true,
      apiKey: 'parity-test-placeholder',
      choose: async () => null
    })
    agent.state.tokenSettings = normalizeTokenSettings(overrides)
    agent.state.toolTurnSerial = 1
    return agent
  }

  it('answers an identical read with a short note while its result is still present', async () => {
    const agent = await makeAgent()
    const first = await agent.tools.execute('read_file', { path: 'a.txt' })
    expect(String(first.output)).toContain('alpha')

    const second = await agent.tools.execute('read_file', { path: 'a.txt' })
    expect(String(second.output)).toContain('Reused the identical read_file result')

    const third = await agent.tools.execute('read_file', { path: 'a.txt' })
    expect(String(third.error)).toContain('Blocked a repeated read_file call')

    agent.state.toolTurnSerial = 2
    const fourth = await agent.tools.execute('read_file', { path: 'a.txt' })
    expect(String(fourth.output)).toContain('alpha')
  })

  it('blocks a third identical call when reuse is off', async () => {
    const agent = await makeAgent({ reuseReadResults: false })
    const args = { path: 'a.txt' }

    expect(String((await agent.tools.execute('read_file', args)).output)).toContain('alpha')
    expect(String((await agent.tools.execute('read_file', args)).output)).toContain('alpha')

    const blocked = await agent.tools.execute('read_file', args)
    expect(String(blocked.error)).toContain('Blocked a repeated read_file call')
  })

  it('keeps a sub-agent from reusing another agent read', async () => {
    const agent = await makeAgent()
    const args = { path: 'a.txt' }
    const childA = { contents: [] } as unknown as AgentState
    const childB = { contents: [] } as unknown as AgentState

    const first = await agent.tools.executeFor('sub-agent 1', childA, 'read_file', args)
    expect(String(first.output)).toContain('alpha')

    const other = await agent.tools.executeFor('sub-agent 2', childB, 'read_file', args)
    expect(String(other.output)).toContain('alpha')
    expect(String(other.output)).not.toContain('Reused')

    const again = await agent.tools.executeFor('sub-agent 1', childA, 'read_file', args)
    expect(String(again.output)).toContain('Reused the identical read_file result')
  })

  it('keeps direct dispatch outside a turn on the v1 path', async () => {
    const agent = await makeAgent()
    agent.state.toolTurnSerial = 0
    const args = { path: 'a.txt' }
    expect(String((await agent.tools.execute('read_file', args)).output)).toContain('alpha')
    expect(String((await agent.tools.execute('read_file', args)).output)).toContain('alpha')
    expect(String((await agent.tools.execute('read_file', args)).output)).toContain('alpha')
  })
})
