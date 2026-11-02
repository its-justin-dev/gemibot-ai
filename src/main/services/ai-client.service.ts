import {
  GoogleGenAI,
  type Content as GenaiContent,
  type GenerateContentConfig
} from '@google/genai'
import {
  contentToWire,
  type Content,
  type FunctionCall,
  type FunctionResponse,
  type Part
} from '../models/content'
import type { TokenBreakdown, TokenUsageEntry, TokenUsageKind } from '../../shared/types/token-usage'

export interface EngineCandidate {
  content: Content | null
}

export interface EngineResponse {
  candidates: EngineCandidate[]
  text: string
  usage_metadata?: UsageCounts | null
  raw_response?: { usageMetadata?: UsageCounts } | null
}

export interface UsageCounts {
  prompt_token_count?: number
  candidates_token_count?: number
  cached_content_token_count?: number
  thoughts_token_count?: number
  total_token_count?: number
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  thoughtTokens: number
  totalTokens: number
}

/** Labels only. The logger never receives message text, tool output or credentials. */
export interface AiUsageContext {
  conversationId?: string | null
  sender?: string
  kind?: TokenUsageKind | string
  label?: string
  requestedModel?: string | null
  breakdown?: TokenBreakdown | null
  /** Used only when the provider does not report usage. */
  inputEstimate?: number
}

export interface AiUsageReport extends TokenUsageEntry {}

function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

export function usageFromResponse(response: EngineResponse): NormalizedUsage | null {
  const usage = response.usage_metadata ?? response.raw_response?.usageMetadata ?? null
  if (!usage) return null
  const inputTokens = count(usage.prompt_token_count ?? usage.promptTokenCount)
  const outputTokens = count(usage.candidates_token_count ?? usage.candidatesTokenCount)
  const cachedTokens = count(
    usage.cached_content_token_count ?? usage.cachedContentTokenCount
  )
  const thoughtTokens = count(usage.thoughts_token_count ?? usage.thoughtsTokenCount)
  const totalTokens =
    count(usage.total_token_count ?? usage.totalTokenCount) || inputTokens + outputTokens + thoughtTokens
  return { inputTokens, outputTokens, cachedTokens, thoughtTokens, totalTokens }
}

export function attr<T>(obj: unknown, name: string): T | undefined {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  if (name in record) return record[name] as T
  const camel = name.replace(/_([a-z0-9])/gu, (_, ch: string) => ch.toUpperCase())
  if (camel in record) return record[camel] as T
  return undefined
}

function normalizePart(part: Record<string, unknown>): Part {
  const out: Part = {}
  const text = part['text']
  if (text !== undefined && text !== null) out.text = String(text)
  if (part['thought'] !== undefined && part['thought'] !== null)
    out.thought = Boolean(part['thought'])
  if (part['thoughtSignature'] !== undefined)
    out.thought_signature = String(part['thoughtSignature'])
  const call = part['functionCall'] as Record<string, unknown> | undefined
  if (call) {
    const fn: FunctionCall = { name: String(call['name'] ?? '') }
    if (call['id'] !== undefined && call['id'] !== null) fn.id = String(call['id'])
    fn.args = (call['args'] as Record<string, unknown>) ?? undefined
    out.function_call = fn
  }
  const response = part['functionResponse'] as Record<string, unknown> | undefined
  if (response) {
    const fr: FunctionResponse = { name: String(response['name'] ?? '') }
    if (response['id'] !== undefined && response['id'] !== null) fr.id = String(response['id'])
    fr.response = (response['response'] as Record<string, unknown>) ?? undefined
    out.function_response = fr
  }
  const inline = part['inlineData'] as Record<string, unknown> | undefined
  if (inline) {
    out.inline_data = {
      data: inline['data'] === undefined ? null : String(inline['data']),
      mime_type: inline['mimeType'] === undefined ? null : String(inline['mimeType']),
      display_name: inline['displayName'] === undefined ? null : String(inline['displayName'])
    }
  }
  const fileData = part['fileData'] as Record<string, unknown> | undefined
  if (fileData) {
    out.file_data = {
      file_uri: fileData['fileUri'] === undefined ? null : String(fileData['fileUri']),
      mime_type: fileData['mimeType'] === undefined ? null : String(fileData['mimeType']),
      display_name: fileData['displayName'] === undefined ? null : String(fileData['displayName'])
    }
  }
  if (part['codeExecutionResult'] !== undefined)
    out.code_execution_result = part['codeExecutionResult'] as Record<string, unknown>
  if (part['executableCode'] !== undefined)
    out.executable_code = part['executableCode'] as Record<string, unknown>
  if (part['videoMetadata'] !== undefined)
    out.video_metadata = part['videoMetadata'] as Record<string, unknown>
  if (part['mediaResolution'] !== undefined)
    out.media_resolution = part['mediaResolution'] as Record<string, unknown>
  return out
}

export function normalizeContent(content: GenaiContent | undefined | null): Content | null {
  if (!content) return null
  const parts = (content.parts as Record<string, unknown>[] | undefined) ?? undefined
  const out: Content = {}
  if (parts) out.parts = parts.map(normalizePart)
  if (content.role !== undefined && content.role !== null) out.role = String(content.role)
  return out
}

export function normalizeResponse(response: unknown): EngineResponse {
  const candidates = (attr<unknown[]>(response, 'candidates') ?? []).map((raw) => ({
    content: normalizeContent(attr<GenaiContent>(raw, 'content'))
  }))
  const usage = attr<Record<string, unknown>>(response, 'usageMetadata')
  const usageCounts: UsageCounts | undefined = usage
    ? {
        prompt_token_count: Number(usage['promptTokenCount'] ?? usage['prompt_token_count'] ?? 0),
        candidates_token_count: Number(
          usage['candidatesTokenCount'] ?? usage['candidates_token_count'] ?? 0
        ),
        cached_content_token_count: Number(
          usage['cachedContentTokenCount'] ?? usage['cached_content_token_count'] ?? 0
        ),
        thoughts_token_count: Number(
          usage['thoughtsTokenCount'] ?? usage['thoughts_token_count'] ?? 0
        ),
        total_token_count: Number(usage['totalTokenCount'] ?? usage['total_token_count'] ?? 0)
      }
    : undefined
  const text = candidates
    .map((c) => (c.content?.parts ?? []).map((p) => p.text ?? '').join(''))
    .join('')
  return { candidates, text, usage_metadata: usageCounts ?? null, raw_response: null }
}

export interface AntigravityInteractions {
  create(params: {
    agent: string
    input: string
    environment: Record<string, never>
  }): Promise<{ output_text?: string }>
}

export class AiClient {
  client: GoogleGenAI
  readonly interactions?: AntigravityInteractions
  private usageReporter: ((report: AiUsageReport) => void) | null = null

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey })
  }

  /** Registered once per client; every request passes its own conversation/sender labels. */
  setUsageReporter(reporter: ((report: AiUsageReport) => void) | null): void {
    this.usageReporter = reporter
  }

  private reportUsage(
    model: string,
    usage: NormalizedUsage | null,
    context: AiUsageContext,
    fallbackOutput = 0
  ): void {
    if (this.usageReporter === null) return
    const estimatedInput = Math.max(0, Math.round(context.inputEstimate ?? 0))
    const inputTokens = usage?.inputTokens ?? estimatedInput
    const outputTokens = usage?.outputTokens ?? fallbackOutput
    const thoughtTokens = usage?.thoughtTokens ?? 0
    const estimated =
      usage === null ||
      (usage.outputTokens === 0 && fallbackOutput > 0) ||
      (usage.inputTokens === 0 && estimatedInput > 0)
    const report: AiUsageReport = {
      conversationId: context.conversationId ?? null,
      sender: context.sender ?? 'other',
      kind: context.kind ?? 'chat',
      label: context.label ?? '',
      model,
      requestedModel: context.requestedModel ?? null,
      inputTokens,
      outputTokens,
      cachedTokens: usage?.cachedTokens ?? 0,
      thoughtTokens,
      totalTokens: Math.max(usage?.totalTokens ?? 0, inputTokens + outputTokens + thoughtTokens),
      estimated,
      breakdown: context.breakdown ?? null
    }
    try {
      this.usageReporter(report)
    } catch {
      /* logging must never break a request */
    }
  }

  /**
   * The SDK snapshots the key inside its auth helper, so a new client instance is the only
   * supported way to rotate it. Every request after this call uses the new key.
   */
  setApiKey(apiKey: string): void {
    this.client = new GoogleGenAI({ apiKey })
  }

  async generateContent(
    model: string,
    contents: Content[],
    config?: GenerateContentConfig,
    usage?: AiUsageContext
  ): Promise<EngineResponse> {
    const wire = contents.map(contentToWire) as GenaiContent[]
    const response = await this.client.models.generateContent({ model, contents: wire, config })
    const normalized = normalizeResponse(response)
    this.reportUsage(
      model,
      usageFromResponse(normalized),
      usage ?? {},
      Math.ceil(normalized.text.length / 4)
    )
    return normalized
  }

  /**
   * Streams one reply, forwarding only visible text deltas. Thinking parts are collected for the
   * final response but never streamed, and usage is reported once from the closing chunk.
   */
  async generateContentStream(
    model: string,
    contents: Content[],
    config: GenerateContentConfig | undefined,
    usage: AiUsageContext | undefined,
    onText: (delta: string) => void
  ): Promise<EngineResponse> {
    const wire = contents.map(contentToWire) as GenaiContent[]
    const stream = await this.client.models.generateContentStream({
      model,
      contents: wire,
      config
    })
    let text = ''
    let thought = ''
    const calls: Part[] = []
    let usageCounts: UsageCounts | null = null
    for await (const chunk of stream) {
      const normalized = normalizeResponse(chunk)
      if (normalized.usage_metadata !== null && normalized.usage_metadata !== undefined) {
        usageCounts = normalized.usage_metadata
      }
      const content = normalized.candidates[0]?.content
      for (const part of content?.parts ?? []) {
        if (part.function_call !== undefined) {
          calls.push(part)
          continue
        }
        if (part.text === undefined || part.text === null) continue
        if (part.thought === true) {
          thought += part.text
          continue
        }
        text += part.text
        if (part.text !== '') {
          try {
            onText(part.text)
          } catch {
            /* a dead renderer must not interrupt the stream */
          }
        }
      }
    }
    const parts: Part[] = []
    if (thought !== '') parts.push({ text: thought, thought: true })
    if (text !== '') parts.push({ text })
    parts.push(...calls)
    const normalized: EngineResponse = {
      candidates: [{ content: { role: 'model', parts } }],
      text,
      usage_metadata: usageCounts,
      raw_response: null
    }
    this.reportUsage(
      model,
      usageFromResponse(normalized),
      usage ?? {},
      Math.ceil(text.length / 4)
    )
    return normalized
  }

  async generateImages(
    model: string,
    prompt: string,
    config?: unknown,
    usage?: AiUsageContext
  ): Promise<unknown> {
    const response = await this.client.models.generateImages({ model, prompt, config } as never)
    this.reportUsage(
      model,
      null,
      {
        ...(usage ?? {}),
        kind: usage?.kind ?? 'image',
        inputEstimate: usage?.inputEstimate ?? Math.ceil((prompt.length + 200) / 4)
      },
      0
    )
    return response
  }

  async embedContent(
    model: string,
    contents: string,
    usage?: AiUsageContext
  ): Promise<unknown> {
    const response = await this.client.models.embedContent({ model, contents } as never)
    this.reportUsage(model, null, {
      ...(usage ?? {}),
      kind: usage?.kind ?? 'embedding',
      inputEstimate: usage?.inputEstimate ?? Math.ceil(contents.length / 4)
    })
    return response
  }

  get hasEmbedContent(): boolean {
    return typeof this.client.models.embedContent === 'function'
  }
}
