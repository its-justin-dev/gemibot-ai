import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateContentConfig } from '@google/genai'

import { buildAgentPrompt } from '../../src/shared/prompts/system-prompt'
import { DEFAULT_BEHAVIOR_SETTINGS } from '../../src/shared/types/behavior-settings'
import {
  MAX_BEHAVIOR_STEPS,
  MIN_BEHAVIOR_STEPS,
  behaviorSettingsFromDict,
  behaviorSettingsToDict,
  normalizeBehaviorSettings,
  stepsValue
} from '../../src/shared/utils/behavior-settings'
import { assessTaskComplexity, stepBudgetFor } from '../../src/shared/utils/task-complexity'
import { actionSummary } from '../../src/renderer/src/state/card-model'
import { Agent } from '../../src/main/services/agent.service'
import type { ToolExecutor } from '../../src/main/services/agent-turn.service'
import type { EngineResponse, UsageCounts } from '../../src/main/services/ai-client.service'
import type { AssistantDelta } from '../../src/main/models/agent-state'
import type { Content, Part } from '../../src/main/models/content'

const network = vi.hoisted(() => ({ online: true }))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => network.online
}))

type Call = { model: string; contents: Content[]; config?: GenerateContentConfig }

function response(parts: Part[], usage: UsageCounts | null = null): EngineResponse {
  return {
    candidates: [{ content: { role: 'model', parts } }],
    text: parts.map((part) => part.text ?? '').join(''),
    usage_metadata: usage,
    raw_response: null
  }
}

let root = ''
const roots: string[] = []

async function makeAgent(
  options: {
    execute?: ToolExecutor
    advancedAgent?: boolean
    pinned?: boolean
    model?: string
    streamResponses?: boolean
  } = {}
): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-intelligence-'))
  roots.push(root)
  return await Agent.create({
    root,
    model: options.model ?? 'gemini-3.5-flash-lite',
    apiKey: 'intelligence-test-placeholder',
    ...(options.execute !== undefined ? { execute: options.execute } : {}),
    advancedAgent: options.advancedAgent === true,
    pinned: options.pinned === true,
    streamResponses: options.streamResponses === true
  })
}

function stubClient(
  agent: Agent,
  respond: (index: number, call: Call) => EngineResponse | Promise<EngineResponse>
): Call[] {
  const calls: Call[] = []
  agent.client.generateContent = async (model, contents, config) => {
    const call: Call = { model, contents: contents.map((content) => ({ ...content })), config }
    calls.push(call)
    return await respond(calls.length - 1, call)
  }
  return calls
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

interface TimelineRow {
  replies: string[]
  events: Array<{ tool: string; args?: Record<string, unknown> }>
}

function lastTurn(agent: Agent): TimelineRow {
  return agent.timelineHistory[0] as unknown as TimelineRow
}

beforeEach(() => {
  network.online = true
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
})

afterEach(async () => {
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

describe('buildAgentPrompt()', () => {
  const build = buildAgentPrompt({ mode: 'build', responseStyle: 'balanced' })

  it('keeps every numbered behavior section exactly once', () => {
    for (let section = 1; section <= 10; section += 1) {
      expect(occurrences(build, `# ${section}.`), `section ${section}`).toBe(1)
    }
  })

  it('names GemiBot and stores no other vendor prompt', () => {
    expect(build).toContain('You are "GemiBot AI"')
    for (const vendor of ['Claude', 'Anthropic', 'OpenAI', 'Codex', 'Qoder', 'Antigravity']) {
      expect(build).not.toContain(vendor)
    }
  })

  it('tells the agent how to handle a vague request', () => {
    expect(build).toContain('state the assumption')
    expect(build).toContain('Ask one focused question only when a wrong guess would be expensive')
  })

  it('swaps execution and verification for the read-only modes', () => {
    for (const mode of ['plan', 'read']) {
      const prompt = buildAgentPrompt({ mode, responseStyle: 'balanced' })
      expect(prompt).toContain('# 4. Investigate completely')
      expect(prompt).toContain('# 5. Verify the investigation')
      expect(prompt).not.toContain('# 4. Do the whole job')
      expect(prompt).not.toContain('# 5. Verify before you claim success')
    }
  })

  it('adds exactly one response style section', () => {
    for (const [style, marker] of [
      ['concise', '## Response style: Concise'],
      ['balanced', '## Response style: Balanced'],
      ['thorough', '## Response style: Thorough']
    ] as const) {
      const prompt = buildAgentPrompt({ mode: 'build', responseStyle: style })
      expect(prompt).toContain(marker)
      expect(occurrences(prompt, '## Response style:')).toBe(1)
    }
  })

  it('adds deep guidance only for a routed deep task, otherwise simple guidance only', () => {
    expect(build).not.toContain('## Deep mode for this task')
    expect(build).not.toContain('## Task size')

    const deep = buildAgentPrompt({ mode: 'build', responseStyle: 'balanced', deepActive: true })
    expect(deep).toContain('## Deep mode for this task')
    expect(deep).not.toContain('## Task size')

    const simple = buildAgentPrompt({
      mode: 'build',
      responseStyle: 'balanced',
      complexity: 'simple'
    })
    expect(simple).toContain('## Task size')
    expect(simple).not.toContain('## Deep mode for this task')

    // Deep wins when a caller passes both: the request was classified complex.
    const both = buildAgentPrompt({
      mode: 'build',
      responseStyle: 'balanced',
      deepActive: true,
      complexity: 'simple'
    })
    expect(both).toContain('## Deep mode for this task')
    expect(both).not.toContain('## Task size')
  })
})

describe('assessTaskComplexity()', () => {
  it('keeps a short question and a one-liner simple', () => {
    expect(assessTaskComplexity('what does this function do?').level).toBe('simple')
    expect(assessTaskComplexity('hello').level).toBe('simple')
    expect(assessTaskComplexity('add a logout button').level).toBe('simple')
  })

  it('sends multi-file, multi-action work to deep mode', () => {
    const request =
      'Refactor the authentication module across several files: update the routes, navigation, ' +
      'imports and tests, then verify the build and fix any failures.'
    const assessment = assessTaskComplexity(request)
    expect(assessment.level).toBe('complex')
    expect(assessment.score).toBeGreaterThanOrEqual(4)
    expect(assessment.reasons.length).toBeGreaterThan(0)
  })

  it('keeps a two-part change in the middle band', () => {
    const assessment = assessTaskComplexity(
      'Add a route for the settings page and update the navigation menu.'
    )
    expect(assessment.level).toBe('medium')
  })

  it('gives only complex deep work the extra verification budget', () => {
    expect(stepBudgetFor('complex', 40, true)).toBe(60)
    expect(stepBudgetFor('complex', 40, false)).toBe(40)
    expect(stepBudgetFor('simple', 40, true)).toBe(40)
    expect(stepBudgetFor('complex', MAX_BEHAVIOR_STEPS, true)).toBe(MAX_BEHAVIOR_STEPS)
    expect(stepBudgetFor('complex', 10, true)).toBe(20)
  })
})

describe('behavior settings', () => {
  it('maps aliases and clamps numbers', () => {
    const settings = behaviorSettingsFromDict({
      response_style: 'detailed',
      deep_mode: 'off',
      max_steps: '900',
      stream_responses: 'yes'
    })
    expect(settings).toEqual({
      responseStyle: 'thorough',
      deepMode: false,
      maxSteps: MAX_BEHAVIOR_STEPS,
      streamResponses: true
    })
  })

  it('falls back safely on missing or malformed values', () => {
    expect(behaviorSettingsFromDict({})).toEqual(DEFAULT_BEHAVIOR_SETTINGS)
    expect(
      normalizeBehaviorSettings({
        responseStyle: 'verbose' as never,
        deepMode: 'maybe' as never,
        maxSteps: Number.NaN
      })
    ).toEqual(DEFAULT_BEHAVIOR_SETTINGS)
    expect(stepsValue(1)).toBe(MIN_BEHAVIOR_STEPS)
  })

  it('round-trips through the persisted dictionary keys', () => {
    const settings = normalizeBehaviorSettings({
      responseStyle: 'concise',
      deepMode: false,
      maxSteps: 25,
      streamResponses: false
    })
    expect(behaviorSettingsFromDict(behaviorSettingsToDict(settings))).toEqual(settings)
  })

  it('persists the settings and rebuilds the system prompt', async () => {
    const agent = await makeAgent()
    const saved = await agent.updateBehaviorSettings({
      responseStyle: 'thorough',
      deepMode: false,
      maxSteps: 999,
      streamResponses: false
    })
    expect(saved.maxSteps).toBe(MAX_BEHAVIOR_STEPS)
    expect(agent.behaviorConfig()).toEqual(saved)
    expect(agent.state.system).toContain('## Response style: Thorough')
    const stored = await agent.settings.readSettingsDict()
    expect(stored).toMatchObject({
      response_style: 'thorough',
      deep_mode: 'false',
      max_steps: String(MAX_BEHAVIOR_STEPS),
      stream_responses: 'false'
    })
  })
})

describe('timeline summaries for the new rows', () => {
  it('summarizes mode, final check, loop stop and step limit', () => {
    expect(
      actionSummary({
        tool: 'agent_mode',
        args: { level: 'complex', deep: true, steps: 60, model: 'gemini-3.1-pro-preview' }
      })
    ).toBe('Deep mode · gemini-3.1-pro-preview · 60 steps')
    expect(
      actionSummary({
        tool: 'agent_mode',
        args: { level: 'medium', deep: false, steps: 40 }
      })
    ).toBe('Medium mode · 40 steps')
    expect(actionSummary({ tool: 'final_check' })).toContain('before finishing')
    expect(actionSummary({ tool: 'loop_stop', args: { tool: 'read_file', repeats: 3 } })).toBe(
      'Stopped a repeated failing call: read_file (3x)'
    )
    expect(actionSummary({ tool: 'step_limit', args: { steps: 60 } })).toBe(
      'Reached the 60-step limit'
    )
  })
})

describe('complexity routing', () => {
  it('moves a complex task to a pro model and high effort, then restores the user choice', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    const original = agent.state.model
    const effortBefore = agent.modelController?.effectiveEffort()

    const route = agent.routeTask('complex')
    expect(route).not.toBeNull()
    expect(agent.state.model).toMatch(/pro/iu)
    expect(agent.state.routedFromModel).toBe(original)
    expect(agent.modelController?.effectiveEffort().value).toBe('high')

    agent.restoreTaskRoute()
    expect(agent.state.model).toBe(original)
    expect(agent.state.routedFromModel).toBeNull()
    expect(agent.modelController?.effectiveEffort()).toEqual(effortBefore)
  })

  it('never routes a simple request or a pinned model', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    expect(agent.routeTask('simple')).toBeNull()
    expect(agent.routeTask('medium')).toBeNull()

    const pinned = await makeAgent({ advancedAgent: true, pinned: true })
    expect(pinned.routeTask('complex')).toBeNull()
    expect(pinned.state.routedFromModel).toBeNull()
  })

  it('falls back when the auto-routed model is not enabled for the key', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    const calls = stubClient(agent, (_index, call) => {
      if (/pro/iu.test(call.model)) {
        throw new Error('403 PERMISSION_DENIED: this model is not enabled for the key')
      }
      return response([{ text: 'Finished on the fallback model.' }])
    })

    await agent.turn(
      'Refactor the authentication module across several files: update the routes, navigation, ' +
        'imports and tests, then verify the build and fix any failures.'
    )

    expect(calls[0].model).toMatch(/pro/iu)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[1].model).not.toMatch(/pro/iu)
    expect(lastTurn(agent).replies).toEqual(['Finished on the fallback model.'])
    expect(agent.state.model).toBe('gemini-3.5-flash-lite')
    expect(agent.state.routedFromModel).toBeNull()
    expect(agent.state.lastTurnSucceeded).toBe(true)
  })
})

describe('slash commands for the behavior settings', () => {
  it('applies /style, /deep, /steps and /stream and rebuilds the prompt', async () => {
    const agent = await makeAgent()

    await agent.command('/style concise')
    expect(agent.behaviorConfig().responseStyle).toBe('concise')
    expect(agent.state.system).toContain('## Response style: Concise')

    await agent.command('/deep off')
    expect(agent.behaviorConfig().deepMode).toBe(false)

    await agent.command('/steps 25')
    expect(agent.behaviorConfig().maxSteps).toBe(25)
    await agent.command('/steps 2')
    expect(agent.behaviorConfig().maxSteps).toBe(MIN_BEHAVIOR_STEPS)

    await agent.command('/stream off')
    expect(agent.behaviorConfig().streamResponses).toBe(false)
  })
})

describe('the advanced loop', () => {
  const COMPLEX_REQUEST =
    'Refactor the authentication module across several files: update the routes, navigation, ' +
    'imports and tests, then verify the build and fix any failures.'

  it('answers a one-line question without planning or a final check', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    const calls = stubClient(agent, () => response([{ text: 'It returns the parsed value.' }]))

    await agent.turn('what does this function do?')

    expect(calls).toHaveLength(1)
    const row = lastTurn(agent)
    expect(row.events).toHaveLength(0)
    expect(row.replies).toEqual(['It returns the parsed value.'])
    expect(agent.state.deepActive).toBe(false)
    expect(agent.state.taskComplexity).toBeNull()
  })

  it('does not final-check a simple answer because an older todo is still open', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    agent.state.todos = [{ content: 'old pending task', status: 'pending' }]
    const calls = stubClient(agent, () => response([{ text: 'Hello.' }]))

    await agent.turn('hello')

    expect(calls).toHaveLength(1)
    expect(lastTurn(agent).events).toHaveLength(0)
  })

  it('runs one final check on a deep turn and answers only after it', async () => {
    const agent = await makeAgent({ advancedAgent: true })
    const calls = stubClient(agent, (index) => {
      if (index === 0) {
        return response([{ function_call: { name: 'list_files', args: { path: '.' } } }])
      }
      if (index === 1) return response([{ text: 'The refactor is done.' }])
      return response([{ text: 'Verified: routes, navigation, imports and tests agree.' }])
    })

    await agent.turn(COMPLEX_REQUEST)

    expect(calls).toHaveLength(3)
    const injected = calls[2].contents.at(-1)?.parts?.[0]?.text ?? ''
    expect(injected).toMatch(/^Final check before finishing:/u)
    expect(agent.state.deepActive).toBe(false)
    expect(agent.state.routedFromModel).toBeNull()
    expect(agent.state.model).toBe('gemini-3.5-flash-lite')

    const row = lastTurn(agent)
    const tools = row.events.map((event) => event.tool)
    expect(tools).toContain('agent_mode')
    expect(tools).toContain('final_check')
    const mode = row.events.find((event) => event.tool === 'agent_mode')
    expect(mode?.args).toMatchObject({ level: 'complex', deep: true, steps: 60 })
    expect(row.replies).toEqual(['Verified: routes, navigation, imports and tests agree.'])
    expect(agent.state.lastTurnSucceeded).toBe(true)
    expect(agent.state.lastTurnError).toBeNull()
  })

  it('stops after the same failing call repeats and reports the real error', async () => {
    const agent = await makeAgent({
      advancedAgent: true,
      execute: async () => ({ error: 'ENOENT: no such file or directory' })
    })
    const calls = stubClient(agent, () =>
      response([{ function_call: { name: 'read_file', args: { path: 'missing.ts' } } }])
    )

    await agent.turn('read missing.ts')

    expect(calls).toHaveLength(3)
    const failure = calls[1].contents.at(-1)?.parts?.[0]?.function_response?.response
    expect(failure).toMatchObject({ error: 'ENOENT: no such file or directory' })

    const row = lastTurn(agent)
    const loop = row.events.find((event) => event.tool === 'loop_stop')
    expect(loop).toBeDefined()
    expect(loop?.args).toMatchObject({ tool: 'read_file', repeats: 3 })
    expect(row.replies.at(-1)).toContain('same error 3 times')
    expect(agent.state.lastTurnSucceeded).toBe(false)
    expect(agent.state.lastTurnError).toContain('ENOENT: no such file or directory')
  })

  it('ends at the configured step limit with a clear message', async () => {
    const agent = await makeAgent({
      advancedAgent: true,
      execute: async () => ({ output: 'ok' })
    })
    await agent.updateBehaviorSettings({ maxSteps: 10 })
    const calls = stubClient(agent, (index) =>
      response([{ function_call: { name: 'list_files', args: { path: `.`, index } } }])
    )

    await agent.turn('check files')

    expect(calls).toHaveLength(10)
    const row = lastTurn(agent)
    const limit = row.events.find((event) => event.tool === 'step_limit')
    expect(limit?.args).toMatchObject({ steps: 10 })
    expect(row.events.filter((event) => event.tool === 'agent_mode')).toHaveLength(0)
    expect(agent.state.lastTurnSucceeded).toBe(false)
    expect(agent.state.lastTurnError).toBe('Reached the 10-step limit.')
  })
})

describe('streamed replies', () => {
  it('sends text deltas and finishes with the complete reply', async () => {
    const agent = await makeAgent({ streamResponses: true })
    const deltas: AssistantDelta[] = []
    agent.state.onAssistantDelta = (delta) => deltas.push({ ...delta })
    const chunks = ['The answer ', 'is 42.']
    agent.client.generateContentStream = async (_model, _contents, _cfg, _usage, onText) => {
      for (const chunk of chunks) onText(chunk)
      return response([{ text: chunks.join('') }])
    }
    const fallback = vi
      .spyOn(agent.client, 'generateContent')
      .mockResolvedValue(response([{ text: 'The answer is 42.' }]))

    await agent.turn('what is the answer?')

    expect(fallback).not.toHaveBeenCalled()
    expect(deltas).toEqual([{ text: '', reset: true }, { text: 'The answer ' }, { text: 'is 42.' }])
    expect(lastTurn(agent).replies).toEqual(['The answer is 42.'])
    expect(agent.state.lastTurnSucceeded).toBe(true)
  })

  it('falls back to one normal request when the model cannot stream', async () => {
    const agent = await makeAgent({ streamResponses: true })
    const deltas: AssistantDelta[] = []
    agent.state.onAssistantDelta = (delta) => deltas.push({ ...delta })
    agent.client.generateContentStream = async () => {
      throw new Error('this proxy cannot stream responses')
    }
    const fallback = vi
      .spyOn(agent.client, 'generateContent')
      .mockResolvedValue(response([{ text: 'Hello there.' }]))

    await agent.turn('hello')

    expect(fallback).toHaveBeenCalledTimes(1)
    expect(lastTurn(agent).replies).toEqual(['Hello there.'])
    // Two resets: one before the attempt, one before the discarded stream row is reused.
    expect(deltas).toEqual([
      { text: '', reset: true },
      { text: '', reset: true }
    ])
    expect(agent.state.lastTurnSucceeded).toBe(true)
  })

  it('does not stream when the user turned it off', async () => {
    const agent = await makeAgent({ streamResponses: true })
    await agent.updateBehaviorSettings({ streamResponses: false })
    const onDelta = vi.fn()
    agent.state.onAssistantDelta = onDelta
    const streamed = vi.fn(async () => response([{ text: 'unused' }]))
    agent.client.generateContentStream = streamed
    stubClient(agent, () => response([{ text: 'Done.' }]))

    await agent.turn('hello')

    expect(streamed).not.toHaveBeenCalled()
    expect(onDelta).not.toHaveBeenCalled()
  })
})
