import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerateContentConfig } from '@google/genai'

import { AppConstants } from '../../src/shared/constants/app-constants'
import { C } from '../../src/shared/constants/colors'
import { ALL_DECLARATIONS, FUNCTION_TOOL_MAP } from '../../src/shared/constants/tool-definitions'
import { pyFormatThousands } from '../../src/shared/utils/pyformat'
import { wrap } from '../../src/shared/utils/textwrap'
import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'
import type { ChooseHook } from '../../src/main/services/agent-session.service'
import type { ToolExecutor } from '../../src/main/services/agent-turn.service'
import type { EngineResponse, UsageCounts } from '../../src/main/services/ai-client.service'
import type { Content, Part } from '../../src/main/models/content'

/**
 * Byte-level parity tests for the v2.0 conversation engine — `Agent.turn()`,
 * `Agent._generate_sync()` and the helpers around them — against recorded AI responses.
 *
 * Every expectation is the v1.0 f-string from `views/window_app.py`, quirks included: the
 * stray `-'` in front of `memory_read`, the `┃` gutter on failures, the empty-reply break
 * that skips the step-limit line, and the `Bro!` rewrite that only happens when the turn
 * made no tool call.  The model ladder is asserted through the ids handed to the client
 * because v1.0 prints nothing until `idx > 0`.
 *
 * Only the elapsed seconds are matched loosely — they read the wall clock.
 */

/** The internet pre-flight is a real socket probe, so that module becomes a switch. */
const network = vi.hoisted(() => ({ online: true }))
vi.mock('../../src/main/utils/net-check', () => ({
  checkInternet: async () => network.online
}))

type Call = { model: string; contents: Content[]; config?: GenerateContentConfig }

const QUOTA_MSG =
  'Quota or rate limit reached for gemini-3.5-flash-lite. Wait a bit, or pick another ' +
  'model with /model. Pro models usually need a billing-enabled key.'

let root = ''
const roots: string[] = []
let raw = ''
let mirrored: string[] = []
let detach: (() => void) | null = null

function response(parts: Part[], usage: UsageCounts | null = null): EngineResponse {
  return {
    candidates: [{ content: { role: 'model', parts } }],
    text: parts.map((p) => p.text ?? '').join(''),
    usage_metadata: usage,
    raw_response: null
  }
}

async function makeAgent(
  options: { model?: string; execute?: ToolExecutor; choose?: ChooseHook } = {}
): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-engine-'))
  roots.push(root)
  return await Agent.create({
    root,
    model: options.model ?? 'gemini-3.5-flash-lite',
    // A non-empty placeholder keeps the SDK's missing-key warning out of the test log; the
    // client itself is replaced by `stubClient` before any request could be made.
    apiKey: 'parity-test-placeholder',
    execute: options.execute ?? (async () => ({ ok: true })),
    choose: options.choose ?? (async () => null)
  })
}

/** Replace the network call with a script and record what the ladder asked for. */
function stubClient(
  agent: Agent,
  respond: (index: number, call: Call) => EngineResponse | Promise<EngineResponse>
): Call[] {
  const calls: Call[] = []
  agent.client.generateContent = async (model, contents, config) => {
    const call: Call = { model, contents: contents.map((c) => ({ ...c })), config }
    calls.push(call)
    return await respond(calls.length - 1, call)
  }
  return calls
}

/** `turn()` frames the user request with the suite/mode line; memory rides in the system prompt. */
function framed(request: string): string {
  return `Active Function Suite: all | Active Mode: build\nUser Request:\n${request}`
}

beforeEach(() => {
  raw = ''
  mirrored = []
  network.online = true
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    raw += String(chunk)
    return true
  }) as never)
  // The console mirror of Stage 4 has to see the same text stdout sees, minus the newline.
  detach = onConsoleOutput((text) => mirrored.push(text))
})

afterEach(async () => {
  detach?.()
  detach = null
  vi.restoreAllMocks()
  const pending = roots.splice(0)
  if (root) pending.push(root)
  root = ''
  // Windows can hold a just-written temp folder for a moment; a locked scratch dir must
  // never be mistaken for a parity failure, so the cleanup retries and then gives up.
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

describe('turn() — a plain text reply', () => {
  it('prints the memory frame, the reply block and the log line', async () => {
    const agent = await makeAgent()
    const calls = stubClient(agent, () => response([{ text: 'All good.' }]))
    const memoryBefore = await agent.readMemoryContent()

    await agent.turn('hello')

    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('gemini-3.5-flash-lite')
    expect(agent.contents).toEqual([
      { role: 'user', parts: [{ text: framed('hello') }] },
      { role: 'model', parts: [{ text: 'All good.' }] }
    ])

    expect(raw).toContain(
      `  ${C.GRAY}- ${C.MAGENTA}-' memory_read${C.RESET} ` +
        `${C.DIM}conversation database ` +
        `(${pyFormatThousands(memoryBefore.length)} chars loaded)${C.RESET}`
    )
    expect(raw).toContain(
      `  ${C.GRAY}- ${C.MAGENTA}- memory_log${C.RESET} ` +
        `${C.DIM}Logged prompt, full response, 0 tool output(s), and 0 file change(s) ` +
        `to the conversation database${C.RESET}`
    )
    expect(raw).toContain(`${C.GREEN}│${C.RESET} ${C.GREEN}${C.BOLD}GemiBot AI${C.RESET}`)
    expect(raw).toContain(`${C.GRAY}- gemini-3.5-flash-lite - all - `)
    expect(raw).toContain(`${C.GREEN}│${C.RESET} All good.`)
    expect(agent.timelineHistory).toHaveLength(1)
    expect(agent.timelineHistory[0].replies).toEqual(['All good.'])
  })

  it('sends every printed line to the console mirror as well', async () => {
    const agent = await makeAgent()
    stubClient(agent, () => response([{ text: 'All good.' }]))
    await agent.turn('hello')
    expect(mirrored.join('\n')).toContain(`-' memory_read${C.RESET}`)
    expect(mirrored).toContain(`${C.GREEN}│${C.RESET} All good.`)
  })

  it('mirrors the user’s bro, but only after the brother swap has already run', async () => {
    const agent = await makeAgent()
    stubClient(agent, () => response([{ text: 'Sure thing, brother.' }]))
    await agent.turn('hey bro, fix this')
    // v1.0 rewrites `brother` → `bro` first and only then tests for a `bro` in the reply,
    // so a reply that said "brother" never gets the `Bro!` prefix.
    expect(raw).toContain(`${C.GREEN}│${C.RESET} Sure thing, bro.`)

    const other = await makeAgent()
    stubClient(other, () => response([{ text: 'Fixed it.' }]))
    await other.turn('hey bro, fix this')
    expect(raw).toContain(`${C.GREEN}│${C.RESET} Bro! Fixed it.`)
  })

  it('counts tokens from the snake_case usage metadata', async () => {
    const agent = await makeAgent()
    stubClient(agent, () =>
      response([{ text: 'hi' }], { prompt_token_count: 11, candidates_token_count: 7 })
    )
    await agent.turn('hello')
    expect(agent.tokensIn).toBe(11)
    expect(agent.tokensOut).toBe(7)
  })

  it('falls back to raw_response usage when the SDK gives no usage_metadata', async () => {
    const agent = await makeAgent()
    stubClient(agent, () => ({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      text: 'hi',
      usage_metadata: null,
      raw_response: { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }
    }))
    await agent.turn('hello')
    expect(agent.tokensIn).toBe(5)
    expect(agent.tokensOut).toBe(3)
  })
})

describe('turn() — function calls', () => {
  it('prints one line per call and feeds the function_response back', async () => {
    const executor = vi.fn(async (): Promise<Record<string, unknown>> => ({ result: 'BODY' }))
    const agent = await makeAgent({ execute: executor })
    let n = 0
    const calls = stubClient(agent, () => {
      n += 1
      if (n === 1)
        return response([{ function_call: { name: 'read_file', args: { path: 'a.txt' } } }])
      return response([{ text: 'done' }])
    })

    await agent.turn('read a.txt')

    expect(calls).toHaveLength(2)
    expect(executor).toHaveBeenCalledWith('read_file', { path: 'a.txt' })
    expect(raw).toContain(`  ${C.GRAY}- ${C.CYAN}- read_file${C.RESET} ${C.DIM}a.txt${C.RESET}`)
    expect(agent.contents[2]).toEqual({
      role: 'user',
      parts: [{ function_response: { id: null, name: 'read_file', response: { result: 'BODY' } } }]
    })
    // The second request carries the model turn and the tool result back to the API.
    expect(calls[1].contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(agent.contents).toHaveLength(4)
  })

  it('reports a tool error without leaving the loop', async () => {
    const onToolError = vi.fn()
    const agent = await makeAgent({
      execute: async (): Promise<Record<string, unknown>> => ({ error: 'boom' })
    })
    agent.state.onToolError = onToolError
    let n = 0
    stubClient(agent, () => {
      n += 1
      if (n === 1)
        return response([
          { function_call: { name: 'run_command', args: { command: 'dir' }, id: 'call-1' } }
        ])
      return response([{ text: 'recovered' }])
    })

    await agent.turn('list files')

    expect(raw).toContain(`  ${C.GRAY}- ${C.RED}- boom${C.RESET}`)
    expect(onToolError).toHaveBeenCalledWith('run_command', 'boom')
    expect(agent.contents[2]).toEqual({
      role: 'user',
      parts: [
        { function_response: { id: 'call-1', name: 'run_command', response: { error: 'boom' } } }
      ]
    })
    expect(raw).toContain(`${C.GREEN}│${C.RESET} recovered`)
  })

  it('breaks on an empty reply and never prints the step limit', async () => {
    const agent = await makeAgent()
    const calls = stubClient(agent, () => response([]))
    await agent.turn('hello')
    expect(calls).toHaveLength(1)
    expect(agent.contents).toHaveLength(1)
    expect(raw).toContain(`${C.GREEN}│${C.RESET} Bro, I got an empty reply. Try again?`)
    expect(raw).not.toContain(`-' Reached the step limit`)
  })

  it('runs out of MAX_STEPS tool calls and prints the step limit', async () => {
    const agent = await makeAgent()
    const calls = stubClient(agent, () =>
      response([{ function_call: { name: 'read_file', args: { path: 'a.txt' } } }])
    )
    await agent.turn('loop forever')
    expect(calls).toHaveLength(AppConstants.MAX_STEPS)
    expect(agent.contents).toHaveLength(1 + AppConstants.MAX_STEPS * 2)
    expect(raw).toContain(
      `  ${C.YELLOW}-' Reached the step limit. Tell me to continue, bro.${C.RESET}`
    )
  })
})

describe('_generate_sync() — the model ladder', () => {
  it('auto-routes to the next candidate after a rate limit', async () => {
    const agent = await makeAgent()
    let n = 0
    const calls = stubClient(agent, () => {
      n += 1
      if (n === 1) throw new Error('429 RESOURCE_EXHAUSTED')
      return response([{ text: 'routed' }])
    })

    await agent.turn('hello')

    expect(calls.map((c) => c.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])
    const events = agent.timelineHistory[0].events as Record<string, unknown>[]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'notice',
      tool: 'model_failover',
      status: 'Routed',
      is_error: false,
      duration: 0,
      args: { requested: 'gemini-3.5-flash-lite', routed_to: 'gemini-3.1-flash-lite' },
      output:
        'Notice: [gemini-3.5-flash-lite] unavailable or rate-limited. ' +
        'Auto-routed via gemini-3.1-flash-lite.'
    })
  })

  it('retries the same model without tools when the API rejects the declarations', async () => {
    const agent = await makeAgent()
    let n = 0
    const calls = stubClient(agent, () => {
      n += 1
      if (n === 1) throw new Error('This model cannot use function declarations.')
      return response([{ text: 'toolless' }])
    })

    await agent.turn('hello')

    expect(calls).toHaveLength(2)
    expect(calls[0].model).toBe(calls[1].model)
    expect(calls[0].config?.tools?.length).toBeGreaterThan(0)
    expect(calls[1].config?.tools).toBeUndefined()
    expect(agent.timelineHistory[0].events).toEqual([])
  })

  it('gives up only after every listed model fails, and prints the rate-limit system error', async () => {
    const onError = vi.fn()
    const agent = await makeAgent()
    agent.state.onError = onError
    const calls = stubClient(agent, () => {
      throw new Error('429 RESOURCE_EXHAUSTED')
    })

    await agent.turn('hello')

    const asked = calls.map((c) => c.model)
    // v1.0 stopped after these four, in this order. The ladder still starts with them, so the
    // recorded routing is unchanged — it just keeps walking through the picker afterwards.
    expect(asked.slice(0, 4)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'antigravity-preview-latest',
      'gemini-3.5-flash'
    ])
    expect(new Set(asked).size, 'no model is asked twice in one walk').toBe(asked.length)
    for (const id of AppConstants.MODELS) expect(asked).toContain(AppConstants.resolveModelId(id))
    expect(agent.contents).toEqual([])
    expect(agent.checkpoints).toHaveLength(0)
    expect(raw).toContain(`${C.RED}┃ ${C.BOLD}System Error${C.RESET}`)
    expect(raw).toContain(
      wrap(QUOTA_MSG, AppConstants.WIDTH)
        .map((line) => `${C.RED}┃${C.RESET} ${line}`)
        .join('\n')
    )
    expect(onError).toHaveBeenCalledWith(QUOTA_MSG, '429 RESOURCE_EXHAUSTED')
  })

  it('routes an antigravity failover as a single turn, never as the saved history', async () => {
    const agent = await makeAgent()
    let n = 0
    const calls = stubClient(agent, () => {
      n += 1
      if (n === 2 || n === 3) throw new Error('429 RESOURCE_EXHAUSTED')
      return response([{ text: n === 1 ? 'first' : 'agent reply' }])
    })

    await agent.turn('hello')
    await agent.turn('and again')

    // The API rejects a replayed history for these models with a 400, so the ladder must
    // hand over only the live user turn even though the session has grown.
    const routed = calls[3]
    expect(routed.model).toBe('antigravity-preview-latest')
    expect(calls[1].contents).toHaveLength(3)
    expect(routed.contents).toHaveLength(1)
    expect(routed.contents[0].role).toBe('user')
    expect(routed.config?.tools).toBeUndefined()
    // The same endpoints reject a system instruction, so the persona rides inside the turn.
    expect(routed.config?.systemInstruction).toBeUndefined()
    const handed = routed.contents[0].parts?.[0]?.text ?? ''
    expect(handed).toContain('You are "GemiBot AI"')
    expect(handed.endsWith(framed('and again'))).toBe(true)
    const events = agent.timelineHistory[1].events as Record<string, unknown>[]
    expect(events[0]).toMatchObject({
      tool: 'model_failover',
      args: { requested: 'gemini-3.5-flash-lite', routed_to: 'antigravity-preview-latest' }
    })
  })
})

describe('generate() — the spinner', () => {
  it('repaints the Thinking line and clears it once the reply lands', async () => {
    const agent = await makeAgent()
    agent.client.generateContent = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return response([{ text: 'late' }])
    }

    await agent.turn('hello')

    const clearCount = raw.split('\r\x1b[K').length - 1
    expect(clearCount).toBeGreaterThanOrEqual(3)
    expect(raw).toContain(
      `\r\x1b[K${C.CYAN}|${C.RESET} ${C.BOLD}Thinking...${C.RESET} ` +
        `${C.GRAY}[gemini-3.5-flash-lite - fn:all - 0.0s - press ${C.YELLOW}esc` +
        `${C.GRAY} to interrupt]${C.RESET}`
    )
    // The `finally` clear runs immediately before the first line of the reply.
    expect(raw).toContain(`${C.GRAY} to interrupt]${C.RESET}\r\x1b[K\n${C.GREEN}│`)
  })

  it('rolls the turn back when the user interrupts', async () => {
    const agent = await makeAgent()
    agent.client.generateContent = () => {
      // v1.0 lets the worker thread keep running after Esc; only the loop gives up.
      setTimeout(() => agent.cancel(), 10)
      return new Promise<EngineResponse>(() => {})
    }

    await agent.turn('hello')

    expect(agent.contents).toEqual([])
    expect(agent.checkpoints).toHaveLength(0)
    expect(agent.timelineHistory).toHaveLength(0)
    expect(raw).toContain(`${C.YELLOW}┃ - Interrupted by user (Esc)${C.RESET}`)
  })
})

describe('turn() — the pre-flight and the mentions', () => {
  it('refuses to send a request while offline', async () => {
    const agent = await makeAgent()
    const calls = stubClient(agent, () => response([{ text: 'no' }]))
    network.online = false

    await agent.turn('hello')

    expect(calls).toHaveLength(0)
    expect(agent.contents).toEqual([])
    expect(raw).toContain(`${C.RED}┃ Error: No internet connection${C.RESET}`)
    // With no `on_error` hook v1.0 routes the same text through `show()`.
    expect(raw).toContain(
      `${C.RED}│${C.RESET} ${C.RED}${C.BOLD}Gemibot${C.RESET} ${C.GRAY}- Network Error${C.RESET}`
    )
    expect(raw).toContain(`${C.RED}│${C.RESET} Error: No internet connection.`)
  })

  it('inlines every readable @mention into the request', async () => {
    const agent = await makeAgent()
    await writeFile(join(root, 'notes.txt'), 'LINE1\nLINE2\n', 'utf8')
    stubClient(agent, () => response([{ text: 'saw it' }]))

    await agent.turn('read @notes.txt now')

    expect(raw).toContain(`  ${C.GRAY}- Attached 1 file(s)${C.RESET}`)
    const expanded =
      'read @notes.txt now\n\nReferenced files:\n' +
      '<file path="notes.txt">\nLINE1\nLINE2\n\n</file>'
    expect(agent.contents[0]?.parts?.[0]?.text).toBe(framed(expanded))
  })
})

describe('pick_function()', () => {
  it('switches the suite, persists it and lists the enabled tools', async () => {
    const agent = await makeAgent({ choose: async () => 'read' })
    await agent.pickFunction()

    expect(agent.state.mode).toBe('read')
    expect(agent.state.activeFunction).toBe('read')
    expect(raw).toContain(
      `${C.BG_FUNC} FUNCTION ${C.RESET} ${C.GREEN}${C.BOLD}read${C.RESET} ` +
        `${C.GRAY}(mode: READ)${C.RESET}`
    )
    const enabled = FUNCTION_TOOL_MAP['read'] ?? ALL_DECLARATIONS
    expect(raw).toContain(
      `${C.DIM}Enabled Tools (${enabled.length}): ${enabled.map((d) => d.name).join(', ')}${C.RESET}`
    )
    const persisted = await agent.settings.readSettingsDict()
    expect(persisted['function_suite']).toBe('read')
    expect(persisted['mode']).toBe('read')
  })

  it('keeps the active suite when the picker is cancelled', async () => {
    const agent = await makeAgent({ choose: async () => null })
    await agent.pickFunction()
    expect(raw).toContain(`  ${C.DIM}Cancelled. Active function suite: all${C.RESET}`)
    expect(agent.state.activeFunction).toBe('all')
  })

  it('prints the pip manager header, v1.0 lines and all', async () => {
    const agent = await makeAgent({ choose: async () => 'pip_installer' })
    await agent.pickFunction()
    expect(raw).toContain(`  ${C.GRAY}- ${C.CYAN}${C.BOLD}Gemibot .venv Pip Manager${C.RESET}`)
    expect(raw).toContain(`  ${C.GRAY}- Packages: ${AppConstants.REQUIRED_PIP_PACKAGES.join(', ')}`)
    expect(agent.state.activeFunction).toBe('all')
  })
})

describe('describe()', () => {
  it('picks the first recognised argument and flattens it to 95 characters', async () => {
    const agent = await makeAgent()
    const engine = agent.turnEngine
    expect(engine.describe('read_file', { path: `a\n${'b'.repeat(200)}` })).toBe(
      `a ${'b'.repeat(93)}`
    )
    expect(engine.describe('write_file', { content: 'ignored' })).toBe('')
    expect(engine.describe('shell', { command: 'npm test' })).toBe('npm test')
  })
})
