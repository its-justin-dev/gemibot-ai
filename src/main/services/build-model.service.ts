import type { GenerateContentConfig } from '@google/genai'

import { AppConstants } from '../../shared/constants/app-constants'
import { EffortLevel } from '../../shared/models/effort-level'
import type {
  BuildEffortSetting,
  BuildRoleModels
} from '../../shared/types/build'
import { parseJsonObject, type ValidationResult } from '../../shared/utils/build-validate'
import type { Content } from '../models/content'
import { EffortMapper } from './effort-mapper.service'
import {
  usageFromResponse,
  type AiUsageContext,
  type EngineResponse
} from './ai-client.service'

export type BuildModelRole = 'strong' | 'implementation' | 'cheap'

export interface BuildModelClient {
  generateContent(
    model: string,
    contents: Content[],
    config?: GenerateContentConfig,
    usage?: AiUsageContext
  ): Promise<EngineResponse>
}

export interface BuildUsageCounts {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface BuildModelResult<T> {
  value: T
  model: string
  usage: BuildUsageCounts
  durationMs: number
  attempts: number
}

export interface BuildModelCall<T> {
  stage: string
  role: BuildModelRole
  effort: BuildEffortSetting
  system: string
  prompt: string
  validate: (value: unknown) => ValidationResult<T>
  /** Defaults to 2: the invalid reply is followed by one validation-error retry. */
  attempts?: number
  signal?: AbortSignal
}

export interface BuildTextCall {
  stage: string
  role: BuildModelRole
  effort: BuildEffortSetting
  system: string
  prompt: string
  signal?: AbortSignal
}

export class BuildAbortedError extends Error {
  constructor() {
    super('Build action aborted')
    this.name = 'BuildAbortedError'
  }
}

export function isBuildAbort(error: unknown): boolean {
  if (error instanceof BuildAbortedError) return true
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  return name === 'AbortError' || /abort/iu.test(message)
}

function unique(models: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const model of models) {
    const clean = AppConstants.resolveModelId(model)
    if (clean === '' || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
  }
  return result
}

/** Role resolution with deterministic automatic choices and explicit user overrides. */
export function resolveBuildRoles(
  overrides: BuildRoleModels,
  currentModel: string,
  cheapModel = ''
): Record<BuildModelRole, string> {
  const models = AppConstants.MODELS
  const current = AppConstants.resolveModelId(currentModel)
  const isPro = (id: string): boolean => /(?:pro|argon)/iu.test(id)
  const isLite = (id: string): boolean => /lite|flash-lite/iu.test(id)
  const strong =
    overrides.strong.trim() ||
    (isPro(current) ? current : '') ||
    models.find((id) => /argon/iu.test(id)) ||
    models.find((id) => /pro/iu.test(id)) ||
    current
  const implementation =
    overrides.implementation.trim() ||
    (!isLite(current) && !isPro(current) ? current : '') ||
    models.find((id) => /flash/iu.test(id) && !isLite(id)) ||
    current
  const cheap =
    overrides.cheap.trim() ||
    cheapModel.trim() ||
    (isLite(current) ? current : '') ||
    models.find((id) => /lite/iu.test(id)) ||
    current
  return {
    strong: AppConstants.resolveModelId(strong),
    implementation: AppConstants.resolveModelId(implementation),
    cheap: AppConstants.resolveModelId(cheap)
  }
}

export class BuildModelService {
  private readonly client: BuildModelClient
  private readonly roles: Record<BuildModelRole, string>
  private readonly conversationId: () => string | null
  private readonly onFailover: ((from: string, to: string, reason: string) => void) | null
  private readonly fallbackModels: string[]

  constructor(deps: {
    client: BuildModelClient
    currentModel: string
    cheapModel?: string
    roleModels: BuildRoleModels
    conversationId: () => string | null
    onFailover?: (from: string, to: string, reason: string) => void
  }) {
    this.client = deps.client
    this.roles = resolveBuildRoles(deps.roleModels, deps.currentModel, deps.cheapModel)
    this.conversationId = deps.conversationId
    this.onFailover = deps.onFailover ?? null
    this.fallbackModels = unique([
      deps.currentModel,
      ...AppConstants.FALLBACK_MODELS,
      this.roles.implementation,
      this.roles.cheap,
      this.roles.strong
    ])
  }

  roleModel(role: BuildModelRole): string {
    return this.roles[role]
  }

  private candidates(role: BuildModelRole): string[] {
    return unique([this.roles[role], ...this.fallbackModels])
  }

  private config(
    system: string,
    effort: BuildEffortSetting,
    model: string,
    signal: AbortSignal | undefined,
    json: boolean
  ): GenerateContentConfig {
    const config: GenerateContentConfig = {
      systemInstruction: system,
      temperature: json ? 0.2 : 0.4
    }
    if (json) config.responseMimeType = 'application/json'
    const thinking = EffortMapper.getThinkingConfig(model, EffortLevel.fromString(effort), false)
    if (thinking !== null) config.thinkingConfig = thinking
    if (signal !== undefined) config.abortSignal = signal
    return config
  }

  private async callModel(
    model: string,
    system: string,
    prompt: string,
    effort: BuildEffortSetting,
    stage: string,
    signal: AbortSignal | undefined,
    json: boolean
  ): Promise<{ response: EngineResponse; usage: BuildUsageCounts; durationMs: number }> {
    const started = Date.now()
    const response = await this.client.generateContent(
      model,
      [{ role: 'user', parts: [{ text: prompt }] }],
      this.config(system, effort, model, signal, json),
      {
        conversationId: this.conversationId(),
        sender: 'build',
        kind: 'build',
        label: `build:${stage}`,
        requestedModel: model,
        inputEstimate: Math.ceil((system.length + prompt.length) / 4)
      }
    )
    const usage = usageFromResponse(response)
    const inputTokens = usage?.inputTokens ?? Math.ceil((system.length + prompt.length) / 4)
    const outputTokens = usage?.outputTokens ?? Math.ceil(response.text.length / 4)
    return {
      response,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          usage?.totalTokens ?? inputTokens + outputTokens + (usage?.thoughtTokens ?? 0)
      },
      durationMs: Date.now() - started
    }
  }

  async json<T>(call: BuildModelCall<T>): Promise<BuildModelResult<T>> {
    const failures: string[] = []
    const attemptsPerModel = Math.max(1, Math.min(3, call.attempts ?? 2))
    let attempts = 0
    for (const [candidateIndex, model] of this.candidates(call.role).entries()) {
      let prompt = call.prompt
      for (let attempt = 0; attempt < attemptsPerModel; attempt++) {
        if (call.signal?.aborted === true) throw new BuildAbortedError()
        attempts += 1
        try {
          const result = await this.callModel(
            model,
            call.system,
            prompt,
            call.effort,
            call.stage,
            call.signal,
            true
          )
          const parsed = parseJsonObject(result.response.text)
          if (!parsed.ok) {
            failures.push(`${model}: ${parsed.error}`)
            prompt = `${call.prompt}\n\nYour previous reply was invalid: ${parsed.error}\nReturn only corrected JSON.`
            continue
          }
          const validated = call.validate(parsed.value)
          if (!validated.ok) {
            failures.push(`${model}: ${validated.error}`)
            prompt = `${call.prompt}\n\nYour previous reply was invalid: ${validated.error}\nReturn only corrected JSON.`
            continue
          }
          return {
            value: validated.value,
            model,
            usage: result.usage,
            durationMs: result.durationMs,
            attempts
          }
        } catch (error) {
          if (isBuildAbort(error) || call.signal?.aborted) throw new BuildAbortedError()
          failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
      const next = this.candidates(call.role)[candidateIndex + 1]
      if (next !== undefined && this.onFailover !== null) {
        try {
          this.onFailover(model, next, failures[failures.length - 1] ?? 'model call failed')
        } catch {}
      }
    }
    throw new Error(`Build ${call.stage} failed after ${attempts} attempt(s): ${failures.slice(-3).join(' | ')}`)
  }

  async text(call: BuildTextCall): Promise<BuildModelResult<string>> {
    const failures: string[] = []
    let attempts = 0
    for (const model of this.candidates(call.role)) {
      if (call.signal?.aborted === true) throw new BuildAbortedError()
      attempts += 1
      try {
        const result = await this.callModel(
          model,
          call.system,
          call.prompt,
          call.effort,
          call.stage,
          call.signal,
          false
        )
        const text = result.response.text.trim()
        if (text === '') {
          failures.push(`${model}: empty reply`)
          continue
        }
        return { value: text, model, usage: result.usage, durationMs: result.durationMs, attempts }
      } catch (error) {
        if (isBuildAbort(error) || call.signal?.aborted) throw new BuildAbortedError()
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`Build ${call.stage} failed after ${attempts} attempt(s): ${failures.slice(-3).join(' | ')}`)
  }
}
