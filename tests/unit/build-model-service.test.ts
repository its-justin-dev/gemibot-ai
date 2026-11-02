import type { GenerateContentConfig } from '@google/genai'
import { describe, expect, it } from 'vitest'

import type { Content } from '../../src/main/models/content'
import type {
  AiUsageContext,
  EngineResponse,
  UsageCounts
} from '../../src/main/services/ai-client.service'
import {
  BuildAbortedError,
  BuildModelService,
  resolveBuildRoles,
  type BuildModelClient
} from '../../src/main/services/build-model.service'
import type { BuildRoleModels } from '../../src/shared/types/build'
import type { ValidationResult } from '../../src/shared/utils/build-validate'

interface ScriptedReply {
  text?: string
  usage?: UsageCounts
  error?: Error
}

interface ModelCall {
  model: string
  contents: Content[]
  config?: GenerateContentConfig
  usage?: AiUsageContext
}

class FakeClient {
  private readonly replies = new Map<string, ScriptedReply[]>()
  readonly calls: ModelCall[] = []

  reply(model: string, ...replies: ScriptedReply[]): void {
    const queue = this.replies.get(model) ?? []
    queue.push(...replies)
    this.replies.set(model, queue)
  }

  async generateContent(
    model: string,
    contents: Content[],
    config?: GenerateContentConfig,
    usage?: AiUsageContext
  ): Promise<EngineResponse> {
    this.calls.push({ model, contents, config, usage })
    const queue = this.replies.get(model)
    const reply = queue?.shift()
    if (reply === undefined) throw new Error(`unexpected call to ${model}`)
    if (reply.error !== undefined) throw reply.error
    const text = reply.text ?? ''
    const response: EngineResponse = {
      candidates: [{ content: { role: 'model', parts: [{ text }] } }],
      text,
      usage_metadata: reply.usage ?? null,
      raw_response: null
    }
    return response
  }
}

const overrides: BuildRoleModels = {
  strong: 'model-strong',
  implementation: 'model-impl',
  cheap: 'model-cheap'
}

function service(
  client: FakeClient,
  input: {
    currentModel?: string
    cheapModel?: string
    roleModels?: BuildRoleModels
    failover?: (from: string, to: string, reason: string) => void
  } = {}
): BuildModelService {
  return new BuildModelService({
    client: client as unknown as BuildModelClient,
    currentModel: input.currentModel ?? 'gemini-3.8-flash',
    cheapModel: input.cheapModel,
    roleModels: input.roleModels ?? overrides,
    conversationId: () => 'conv-1',
    onFailover: input.failover
  })
}

function acceptObject(value: unknown): ValidationResult<{ ok: boolean }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Expected an object.' }
  }
  return { ok: true, value: value as { ok: boolean } }
}

const baseCall = {
  stage: 'spec',
  role: 'strong' as const,
  effort: 'high' as const,
  system: 'System prompt',
  prompt: 'User prompt',
  validate: acceptObject
}

describe('resolveBuildRoles', () => {
  it('picks a strong, implementation and cheap model automatically', () => {
    const flash = resolveBuildRoles({ strong: '', implementation: '', cheap: '' }, 'gemini-3.8-flash')
    expect(flash.strong).toBe('gemini-4-argon')
    expect(flash.implementation).toBe('gemini-3.8-flash')
    expect(flash.cheap).toBe('gemini-3.1-flash-lite')

    const pro = resolveBuildRoles({ strong: '', implementation: '', cheap: '' }, 'gemini-3.1-pro-preview')
    expect(pro.strong).toBe('gemini-3.1-pro-preview')
    expect(pro.implementation).toBe('gemini-3.8-flash')
    expect(pro.cheap).toBe('gemini-3.1-flash-lite')

    const lite = resolveBuildRoles({ strong: '', implementation: '', cheap: '' }, 'gemini-3.1-flash-lite')
    expect(lite.strong).toBe('gemini-4-argon')
    expect(lite.implementation).toBe('gemini-3.8-flash')
    expect(lite.cheap).toBe('gemini-3.1-flash-lite')
  })

  it('prefers explicit overrides and resolves model aliases', () => {
    const roles = resolveBuildRoles(
      {
        strong: ' gemini-2.5-pro ',
        implementation: 'gemini-2.5-flash',
        cheap: '  '
      },
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite'
    )
    expect(roles).toEqual({
      strong: 'gemini-3.1-pro-preview',
      implementation: 'gemini-3.8-flash',
      cheap: 'gemini-3.5-flash-lite'
    })
  })

  it('falls back to the current model when it is the only clue', () => {
    const roles = resolveBuildRoles({ strong: '', implementation: '', cheap: '' }, 'custom-model')
    expect(roles.implementation).toBe('custom-model')
    expect(roles.strong).toBe('gemini-4-argon')
    expect(roles.cheap).toBe('gemini-3.1-flash-lite')
  })
})

describe('BuildModelService.json', () => {
  it('returns validated JSON with usage and a JSON-only request config', async () => {
    const client = new FakeClient()
    client.reply('model-strong', {
      text: '{"ok":true}',
      usage: {
        prompt_token_count: 100,
        candidates_token_count: 40,
        thoughts_token_count: 10,
        total_token_count: 150
      }
    })
    const models = service(client)
    const result = await models.json(baseCall)
    expect(result).toMatchObject({
      value: { ok: true },
      model: 'model-strong',
      attempts: 1,
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 150 }
    })
    const call = client.calls[0]
    expect(call.config).toMatchObject({
      systemInstruction: 'System prompt',
      temperature: 0.2,
      responseMimeType: 'application/json'
    })
    expect(call.contents).toEqual([{ role: 'user', parts: [{ text: 'User prompt' }] }])
    expect(call.usage).toMatchObject({
      conversationId: 'conv-1',
      sender: 'build',
      kind: 'build',
      label: 'build:spec',
      requestedModel: 'model-strong'
    })
  })

  it('retries once with the validation error before giving up on a model', async () => {
    const client = new FakeClient()
    client.reply('model-strong', { text: 'not json at all' }, { text: '{"ok":true}' })
    const models = service(client)
    const result = await models.json(baseCall)
    expect(result.attempts).toBe(2)
    expect(client.calls).toHaveLength(2)
    const retryPrompt = client.calls[1].contents[0].parts?.[0]?.text ?? ''
    expect(retryPrompt).toContain('Your previous reply was invalid')
    expect(retryPrompt).toContain('No JSON object was found')
    expect(retryPrompt).toContain('Return only corrected JSON.')
  })

  it('reports a schema validation error and retries with it', async () => {
    const client = new FakeClient()
    client.reply('model-strong', { text: '[]' }, { text: '{"ok":true}' })
    const models = service(client)
    const result = await models.json(baseCall)
    expect(result.attempts).toBe(2)
    expect(client.calls[1].contents[0].parts?.[0]?.text ?? '').toContain(
      'Expected an object.'
    )
  })

  it('falls over to the next model and reports the reason', async () => {
    const client = new FakeClient()
    client.reply('model-strong', { error: new Error('model unavailable') })
    client.reply('gemini-3.8-flash', { text: '{"ok":true}' })
    const failures: Array<{ from: string; to: string; reason: string }> = []
    const models = service(client, {
      failover: (from, to, reason) => failures.push({ from, to, reason })
    })
    const result = await models.json(baseCall)
    expect(result.model).toBe('gemini-3.8-flash')
    expect(result.attempts).toBe(2)
    expect(failures).toEqual([
      { from: 'model-strong', to: 'gemini-3.8-flash', reason: expect.stringContaining('model unavailable') }
    ])
  })

  it('applies effort-specific thinking budgets to supported models', async () => {
    const client = new FakeClient()
    client.reply('gemini-3.1-pro-preview', { text: '{"ok":true}' })
    const models = service(client, {
      currentModel: 'gemini-3.1-pro-preview',
      roleModels: {
        strong: 'gemini-3.1-pro-preview',
        implementation: '',
        cheap: ''
      }
    })
    const controller = new AbortController()
    await models.json({ ...baseCall, effort: 'extra_high', signal: controller.signal })
    expect(client.calls[0].config?.thinkingConfig).toEqual({
      thinkingBudget: 16_384,
      includeThoughts: false
    })
    expect(client.calls[0].config?.abortSignal).toBe(controller.signal)
  })

  it('estimates usage when the provider reports none', async () => {
    const client = new FakeClient()
    client.reply('model-strong', { text: '{"ok":true}' })
    const models = service(client)
    const result = await models.json({
      ...baseCall,
      system: 'S'.repeat(40),
      prompt: 'P'.repeat(40)
    })
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 3, totalTokens: 23 })
  })

  it('aborts before calling a model when the signal is already aborted', async () => {
    const client = new FakeClient()
    const controller = new AbortController()
    controller.abort()
    const models = service(client)
    await expect(models.json({ ...baseCall, signal: controller.signal })).rejects.toBeInstanceOf(
      BuildAbortedError
    )
    expect(client.calls).toHaveLength(0)
  })

  it('turns provider aborts into BuildAbortedError without failing over', async () => {
    const client = new FakeClient()
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    client.reply('model-strong', { error: abortError })
    const models = service(client)
    await expect(models.json(baseCall)).rejects.toBeInstanceOf(BuildAbortedError)
    expect(client.calls).toHaveLength(1)
  })
})

describe('BuildModelService.text', () => {
  it('returns trimmed text and falls over after an empty reply', async () => {
    const client = new FakeClient()
    client.reply('model-strong', { text: '   ' })
    client.reply('gemini-3.8-flash', { text: '  # README\n\nHello  \n' })
    const models = service(client)
    const result = await models.text({
      stage: 'finish',
      role: 'strong',
      effort: 'low',
      system: 'Write a README',
      prompt: 'Project details'
    })
    expect(result.value).toBe('# README\n\nHello')
    expect(result.model).toBe('gemini-3.8-flash')
    expect(result.attempts).toBe(2)
    expect(client.calls[0].config).toMatchObject({ temperature: 0.4 })
    expect(client.calls[0].config?.responseMimeType).toBeUndefined()
  })

  it('reports the last failures when every candidate fails', async () => {
    const client = new FakeClient()
    const models = service(client, {
      roleModels: { strong: 'only-model', implementation: '', cheap: '' }
    })
    client.reply('only-model', { text: '' })
    await expect(
      models.text({
        stage: 'plan',
        role: 'strong',
        effort: 'medium',
        system: 'S',
        prompt: 'P'
      })
    ).rejects.toThrow(/Build plan failed after \d+ attempt\(s\)/)
  })
})
