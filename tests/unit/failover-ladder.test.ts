import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { KeyboardInterrupt } from '../../src/shared/utils/exceptions'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'
import type { EngineResponse } from '../../src/main/services/ai-client.service'
import type { Part } from '../../src/main/models/content'

/**
 * What the ladder does when the model the user picked cannot answer. The v1.0 routing order is
 * pinned in parity-engine.test.ts; this file covers the v2 behaviour layered on top of it: keep
 * walking the picker instead of showing a quota card, and do it without paying for dead models.
 */

const network = vi.hoisted(() => ({ online: true }))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => network.online
}))

const PRIMARY = 'gemini-3.6-flash'
const NEXT = 'gemini-3.5-flash-lite'

let root = ''
let detach: (() => void) | null = null

function response(parts: Part[]): EngineResponse {
  return {
    candidates: [{ content: { role: 'model', parts } }],
    text: parts.map((p) => p.text ?? '').join(''),
    usage_metadata: null,
    raw_response: null
  }
}

async function makeAgent(): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-ladder-'))
  await writeFile(join(root, 'a.txt'), 'alpha\n')
  return await Agent.create({
    root,
    model: PRIMARY,
    autoYes: true,
    apiKey: 'parity-test-placeholder',
    choose: async () => null
  })
}

/** Every request fails with `message`, and the walk is recorded. */
function stubAllFailing(agent: Agent, message: string): string[] {
  const asked: string[] = []
  agent.client.generateContent = async (model: string) => {
    asked.push(model)
    throw new Error(message)
  }
  return asked
}

/** The primary always rate-limits; everything else answers, tool call first then prose. */
function stubPrimaryDead(agent: Agent): string[] {
  const asked: string[] = []
  let served = 0
  agent.client.generateContent = async (model: string) => {
    asked.push(model)
    if (model === PRIMARY) throw new Error('429 RESOURCE_EXHAUSTED')
    served += 1
    return served === 1
      ? response([{ function_call: { id: null, name: 'read_file', args: { path: 'a.txt' } } }])
      : response([{ text: 'That is the file, bro.' }])
  }
  return asked
}

function failoverNotices(agent: Agent): Record<string, unknown>[] {
  return agent.state.turnTimelineEvents
    .filter((ev) => (ev as Record<string, unknown>).tool === 'model_failover')
    .map((ev) => ({ ...ev }))
}

beforeEach(() => {
  detach = onConsoleOutput(() => undefined)
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never)
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.restoreAllMocks()
  const pending = root
  root = ''
  await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined
  )
})

describe('walking the picker on a quota error', () => {
  it('tries every listed model before it reports anything', async () => {
    const agent = await makeAgent()
    const onError = vi.fn()
    agent.state.onError = onError
    const asked = stubAllFailing(agent, '429 RESOURCE_EXHAUSTED')

    await agent.turn('hello')

    expect(asked[0], 'the model the user picked is always asked first').toBe(PRIMARY)
    for (const id of AppConstants.MODELS) {
      expect(asked, `${id} is part of the walk`).toContain(AppConstants.resolveModelId(id))
    }
    expect(new Set(asked).size, 'no model is asked twice in one walk').toBe(asked.length)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('reports the error of the picked model, not of whichever candidate answered last', async () => {
    const agent = await makeAgent()
    const onError = vi.fn()
    agent.state.onError = onError
    const asked = stubAllFailing(agent, '429 RESOURCE_EXHAUSTED')

    await agent.turn('hello')

    const [, rawError] = onError.mock.calls[0] as [string, string]
    expect(rawError).toBe('429 RESOURCE_EXHAUSTED')
    expect(onError.mock.calls[0][0]).toContain(PRIMARY)
    expect(asked[asked.length - 1]).not.toBe(PRIMARY)
  })

  it('stays silent and keeps working when a later model answers', async () => {
    const agent = await makeAgent()
    const onError = vi.fn()
    agent.state.onError = onError
    const asked = stubPrimaryDead(agent)

    await agent.turn('read a.txt and tell me')

    expect(onError).not.toHaveBeenCalled()
    expect(asked).toEqual([PRIMARY, NEXT, NEXT])
  })

  it('announces the routing once per model, not once per step', async () => {
    const agent = await makeAgent()
    stubPrimaryDead(agent)

    await agent.turn('read a.txt and tell me')

    const notices = failoverNotices(agent)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ args: { requested: PRIMARY, routed_to: NEXT } })
  })

  it('gives the picked model another chance on the next turn', async () => {
    const agent = await makeAgent()
    const asked = stubPrimaryDead(agent)

    await agent.turn('read a.txt')
    const afterFirst = asked.length
    await agent.turn('and again')

    expect(asked[afterFirst]).toBe(PRIMARY)
  })

  it('stops the walk on an auth error, because every model rejects a bad key the same way', async () => {
    const agent = await makeAgent()
    const onError = vi.fn()
    agent.state.onError = onError
    const asked = stubAllFailing(agent, '401 UNAUTHENTICATED: API_KEY_INVALID')

    await agent.turn('hello')

    expect(asked).toEqual([PRIMARY])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('a reply that lands after a stop cannot route or notice in the next turn', async () => {
    const agent = await makeAgent()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    agent.client.generateContent = async () => {
      await gate
      return response([{ text: 'too late' }])
    }

    agent.generate.beginTurn()
    const late = agent.generate.generateSync()
    // The user pressed Stop, then sent a new message before the dead request returned.
    agent.state.cancelRequested = true
    agent.generate.beginTurn()
    agent.state.cancelRequested = false
    release()

    await expect(late).rejects.toBeInstanceOf(KeyboardInterrupt)
    expect(agent.state.lastRoutedModel).toBeNull()
    expect(failoverNotices(agent)).toEqual([])
  })

  it('does not re-upload an invalid request to every model', async () => {
    const agent = await makeAgent()
    const onError = vi.fn()
    agent.state.onError = onError
    const asked = stubAllFailing(agent, '400 INVALID_ARGUMENT: the request is malformed')

    await agent.turn('hello')

    expect(asked, 'a 400 is the request, not the model').toEqual([PRIMARY])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('aborts the request in flight when the user stops', async () => {
    const agent = await makeAgent()
    let signal: AbortSignal | undefined
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    agent.client.generateContent = async (_model, _contents, config) => {
      signal = config?.abortSignal as AbortSignal | undefined
      started()
      return await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted by user')))
      })
    }

    const turn = agent.turn('hello')
    await began
    agent.cancel()
    await turn

    expect(signal?.aborted).toBe(true)
    expect(agent.state.lastTurnCancelled).toBe(true)
  })
})
