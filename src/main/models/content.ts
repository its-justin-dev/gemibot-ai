import {
  PyFloat,
  pyJsonLoads,
  pydanticJsonDumps,
  type PyJsonValue
} from '../../shared/utils/pyjson'

export interface Content {
  parts?: Part[] | null
  role?: string | null
}

export interface Part {
  media_resolution?: Record<string, unknown> | null
  code_execution_result?: Record<string, unknown> | null
  executable_code?: Record<string, unknown> | null
  file_data?: FileData | null
  function_call?: FunctionCall | null
  function_response?: FunctionResponse | null
  inline_data?: Blob | null
  text?: string | null
  thought?: boolean | null
  thought_signature?: string | null
  video_metadata?: VideoMetadata | null
  tool_call?: Record<string, unknown> | null
  tool_response?: Record<string, unknown> | null
  part_metadata?: Record<string, unknown> | null
  audio_transcription?: Record<string, unknown> | null
  media_processing?: string | null
  speech_metadata?: Record<string, unknown> | null
}

export interface Blob {
  data?: string | null
  display_name?: string | null
  mime_type?: string | null
}

export interface FileData {
  display_name?: string | null
  file_uri?: string | null
  mime_type?: string | null
}

export interface FunctionCall {
  id?: string | null
  args?: Record<string, unknown> | null
  name?: string | null
  partial_args?: Record<string, unknown>[] | null
  will_continue?: boolean | null
}

export interface FunctionResponse {
  will_continue?: boolean | null
  scheduling?: string | null
  parts?: Record<string, unknown>[] | null
  id?: string | null
  name?: string | null
  response?: Record<string, unknown> | null
}

export interface VideoMetadata {
  end_offset?: string | null
  fps?: number | null
  start_offset?: string | null
}

export class GenaiValidationError extends Error {
  constructor(
    readonly model: string,
    readonly loc: string,
    readonly reason: string
  ) {
    super(`${model} validation error: ${loc || model} — ${reason}`)
    this.name = 'GenaiValidationError'
  }
}

type FieldKind =
  'str' | 'bool' | 'int' | 'float' | 'bytes' | 'dict' | 'enum' | 'literal' | 'model' | 'model-list'

interface ModelField {
  name: string
  alias: string
  kind: FieldKind
  of?: string
}

interface ModelTable {
  name: string
  fields: ModelField[]
}

const F = (name: string, alias: string, kind: FieldKind, of?: string): ModelField => ({
  name,
  alias,
  kind,
  of
})

const TABLES: Record<string, ModelTable> = {
  Content: {
    name: 'Content',
    fields: [F('parts', 'parts', 'model-list', 'Part'), F('role', 'role', 'str')]
  },
  Part: {
    name: 'Part',
    fields: [
      F('media_resolution', 'mediaResolution', 'model', 'PartMediaResolution'),
      F('code_execution_result', 'codeExecutionResult', 'model', 'CodeExecutionResult'),
      F('executable_code', 'executableCode', 'model', 'ExecutableCode'),
      F('file_data', 'fileData', 'model', 'FileData'),
      F('function_call', 'functionCall', 'model', 'FunctionCall'),
      F('function_response', 'functionResponse', 'model', 'FunctionResponse'),
      F('inline_data', 'inlineData', 'model', 'Blob'),
      F('text', 'text', 'str'),
      F('thought', 'thought', 'bool'),
      F('thought_signature', 'thoughtSignature', 'bytes'),
      F('video_metadata', 'videoMetadata', 'model', 'VideoMetadata'),
      F('tool_call', 'toolCall', 'model', 'ToolCall'),
      F('tool_response', 'toolResponse', 'model', 'ToolResponse'),
      F('part_metadata', 'partMetadata', 'dict'),
      F('audio_transcription', 'audioTranscription', 'model', 'Transcription'),
      F('media_processing', 'mediaProcessing', 'enum'),
      F('speech_metadata', 'speechMetadata', 'model', 'SpeechMetadata')
    ]
  },
  Blob: {
    name: 'Blob',
    fields: [
      F('data', 'data', 'bytes'),
      F('display_name', 'displayName', 'str'),
      F('mime_type', 'mimeType', 'str')
    ]
  },
  FileData: {
    name: 'FileData',
    fields: [
      F('display_name', 'displayName', 'str'),
      F('file_uri', 'fileUri', 'str'),
      F('mime_type', 'mimeType', 'str')
    ]
  },
  FunctionCall: {
    name: 'FunctionCall',
    fields: [
      F('id', 'id', 'str'),
      F('args', 'args', 'dict'),
      F('name', 'name', 'str'),
      F('partial_args', 'partialArgs', 'model-list', 'PartialArg'),
      F('will_continue', 'willContinue', 'bool')
    ]
  },
  FunctionResponse: {
    name: 'FunctionResponse',
    fields: [
      F('will_continue', 'willContinue', 'bool'),
      F('scheduling', 'scheduling', 'enum'),
      F('parts', 'parts', 'model-list', 'FunctionResponsePart'),
      F('id', 'id', 'str'),
      F('name', 'name', 'str'),
      F('response', 'response', 'dict')
    ]
  },
  PartMediaResolution: {
    name: 'PartMediaResolution',
    fields: [F('level', 'level', 'enum'), F('num_tokens', 'numTokens', 'int')]
  },
  CodeExecutionResult: {
    name: 'CodeExecutionResult',
    fields: [F('outcome', 'outcome', 'enum'), F('output', 'output', 'str'), F('id', 'id', 'str')]
  },
  ExecutableCode: {
    name: 'ExecutableCode',
    fields: [F('code', 'code', 'str'), F('language', 'language', 'enum'), F('id', 'id', 'str')]
  },
  VideoMetadata: {
    name: 'VideoMetadata',
    fields: [
      F('end_offset', 'endOffset', 'str'),
      F('fps', 'fps', 'float'),
      F('start_offset', 'startOffset', 'str')
    ]
  },
  ToolCall: {
    name: 'ToolCall',
    fields: [F('id', 'id', 'str'), F('tool_type', 'toolType', 'enum'), F('args', 'args', 'dict')]
  },
  ToolResponse: {
    name: 'ToolResponse',
    fields: [
      F('id', 'id', 'str'),
      F('tool_type', 'toolType', 'enum'),
      F('response', 'response', 'dict')
    ]
  },
  Transcription: {
    name: 'Transcription',
    fields: [
      F('text', 'text', 'str'),
      F('finished', 'finished', 'bool'),
      F('language_code', 'languageCode', 'str'),
      F('speaker_label', 'speakerLabel', 'str'),
      F('words', 'words', 'model-list', 'WordInfo'),
      F('start_offset', 'startOffset', 'str'),
      F('end_offset', 'endOffset', 'str')
    ]
  },
  SpeechMetadata: {
    name: 'SpeechMetadata',
    fields: [F('speaker', 'speaker', 'str'), F('style', 'style', 'str')]
  },
  PartialArg: {
    name: 'PartialArg',
    fields: [
      F('bool_value', 'boolValue', 'bool'),
      F('json_path', 'jsonPath', 'str'),
      F('null_value', 'nullValue', 'literal', 'NULL_VALUE'),
      F('number_value', 'numberValue', 'float'),
      F('string_value', 'stringValue', 'str'),
      F('will_continue', 'willContinue', 'bool')
    ]
  },
  FunctionResponsePart: {
    name: 'FunctionResponsePart',
    fields: [
      F('inline_data', 'inlineData', 'model', 'FunctionResponseBlob'),
      F('file_data', 'fileData', 'model', 'FunctionResponseFileData')
    ]
  },
  FunctionResponseBlob: {
    name: 'FunctionResponseBlob',
    fields: [
      F('mime_type', 'mimeType', 'str'),
      F('data', 'data', 'bytes'),
      F('display_name', 'displayName', 'str')
    ]
  },
  FunctionResponseFileData: {
    name: 'FunctionResponseFileData',
    fields: [
      F('file_uri', 'fileUri', 'str'),
      F('mime_type', 'mimeType', 'str'),
      F('display_name', 'displayName', 'str')
    ]
  },
  WordInfo: {
    name: 'WordInfo',
    fields: [
      F('word', 'word', 'str'),
      F('start_offset', 'startOffset', 'str'),
      F('end_offset', 'endOffset', 'str')
    ]
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const B64_INDEX = /* @__PURE__ */ new Map<string, number>()
for (let i = 0; i < B64_ALPHABET.length; i++) B64_INDEX.set(B64_ALPHABET[i], i)
B64_INDEX.set('+', 62)
B64_INDEX.set('/', 63)
B64_INDEX.set('-', 62)
B64_INDEX.set('_', 63)

const B64_URL = `${B64_ALPHABET}-_`

export function decodeBase64LikePydantic(text: string): number[] {
  let data = text
  let pad = 0
  while (data.endsWith('=')) {
    data = data.slice(0, -1)
    pad++
  }
  const rem = data.length % 4
  if (rem === 1) throw new Error('invalid base64 length')
  const canonicalPad = rem === 0 ? 0 : 4 - rem
  if (pad > canonicalPad) throw new Error('invalid base64 padding')

  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < data.length; i++) {
    const value = B64_INDEX.get(data[i])
    if (value === undefined) throw new Error(`Invalid symbol ${data.charCodeAt(i)}, offset ${i}.`)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) throw new Error('Invalid last symbol, non-zero padding bits.')
  return bytes
}

export function encodeBase64UrlSafe(bytes: readonly number[]): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out +=
      B64_URL[(n >> 18) & 63] + B64_URL[(n >> 12) & 63] + B64_URL[(n >> 6) & 63] + B64_URL[n & 63]
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = bytes[i] << 16
    out += `${B64_URL[(n >> 18) & 63]}${B64_URL[(n >> 12) & 63]}==`
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += `${B64_URL[(n >> 18) & 63]}${B64_URL[(n >> 12) & 63]}${B64_URL[(n >> 6) & 63]}=`
  }
  return out
}

export function canonicalBase64(text: string): string {
  return encodeBase64UrlSafe(decodeBase64LikePydantic(text))
}

const TRUE_WORDS = new Set(['1', '0.0', 'true', 't', 'yes', 'y', 'on'])
const FALSE_WORDS = new Set(['0', '0.0', 'false', 'f', 'no', 'n', 'off'])

function coerceBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return null
}

function coerceNumber(value: unknown): number | null {
  if (value instanceof PyFloat) return value.value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
  )
}

function dumpFields(
  table: ModelTable,
  value: Record<string, unknown>,
  excludeNone: boolean
): Record<string, PyJsonValue> {
  const out: Record<string, PyJsonValue> = {}
  for (const field of table.fields) {
    const raw = value[field.name]
    if (raw === undefined || raw === null) {
      if (!excludeNone) out[field.name] = null
      continue
    }
    if (field.kind === 'bytes') {
      if (typeof raw !== 'string') {
        throw new GenaiValidationError(table.name, field.name, 'Data should be valid base64')
      }
      out[field.name] = canonicalBase64(raw)
    } else if (field.kind === 'float') {
      const parsed = coerceNumber(raw)
      if (parsed === null)
        throw new GenaiValidationError(table.name, field.name, 'Input should be a valid number')
      out[field.name] = new PyFloat(parsed)
    } else if (field.kind === 'model') {
      out[field.name] = dumpTable(nestedTable(field), raw, excludeNone)
    } else if (field.kind === 'model-list') {
      const inner = nestedTable(field)
      out[field.name] = (raw as unknown[]).map((item) => dumpTable(inner, item, excludeNone))
    } else {
      out[field.name] = raw as PyJsonValue
    }
  }
  return out
}

function nestedTable(field: ModelField): ModelTable {
  const table = field.of ? TABLES[field.of] : undefined
  if (!table) throw new GenaiValidationError(field.of ?? field.name, field.name, 'Unknown model')
  return table
}

function dumpTable(
  table: ModelTable,
  value: unknown,
  excludeNone: boolean
): Record<string, PyJsonValue> {
  if (!isPlainObject(value)) {
    throw new GenaiValidationError(table.name, '', 'Input should be an object')
  }
  return dumpFields(table, value, excludeNone)
}

export function contentModelDumpJson(content: Content, excludeNone = true): string {
  return pydanticJsonDumps(
    dumpFields(TABLES.Content, content as unknown as Record<string, unknown>, excludeNone)
  )
}

function parseFields(
  table: ModelTable,
  data: Record<string, unknown>,
  loc: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const known = new Set<string>()
  for (const field of table.fields) {
    known.add(field.name)
    known.add(field.alias)
    const hasName = field.name in data
    const hasAlias = field.alias !== field.name && field.alias in data
    if (hasName && hasAlias) {
      throw new GenaiValidationError(table.name, joinLoc(loc, field.name), 'duplicate field input')
    }
    const key = hasName ? field.name : hasAlias ? field.alias : null
    if (key === null) {
      out[field.name] = null
      continue
    }
    out[field.name] = parseValue(table, field, data[key], joinLoc(loc, field.name))
  }
  for (const key of Object.keys(data)) {
    if (!known.has(key))
      throw new GenaiValidationError(
        table.name,
        joinLoc(loc, key),
        'Extra inputs are not permitted'
      )
  }
  return out
}

function joinLoc(loc: string, name: string): string {
  return loc ? `${loc}.${name}` : name
}

function parseValue(table: ModelTable, field: ModelField, value: unknown, loc: string): unknown {
  if (value === null || value === undefined) return null
  switch (field.kind) {
    case 'str':
      if (typeof value !== 'string') {
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid string')
      }
      return value
    case 'enum':
      if (typeof value !== 'string') {
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid string')
      }
      return value
    case 'literal':
      if (value !== field.of) {
        throw new GenaiValidationError(table.name, loc, `Input should be '${field.of}'`)
      }
      return value
    case 'bool': {
      const parsed = coerceBool(value)
      if (parsed === null)
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid boolean')
      return parsed
    }
    case 'int': {
      const parsed = coerceNumber(value)
      if (parsed === null)
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid integer')
      if (!Number.isInteger(parsed)) {
        throw new GenaiValidationError(
          table.name,
          loc,
          'Input should be a valid integer, got a number with a fractional part'
        )
      }
      return parsed
    }
    case 'float': {
      const parsed = coerceNumber(value)
      if (parsed === null)
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid number')
      return parsed
    }
    case 'bytes': {
      if (typeof value !== 'string') {
        throw new GenaiValidationError(table.name, loc, 'Data should be valid base64')
      }
      try {
        return canonicalBase64(value)
      } catch (error) {
        throw new GenaiValidationError(
          table.name,
          loc,
          `Data should be valid base64: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    case 'dict':
      if (!isPlainObject(value)) {
        throw new GenaiValidationError(table.name, loc, 'Input should be an object')
      }
      return cloneJsonValue(value)
    case 'model': {
      if (!isPlainObject(value)) {
        throw new GenaiValidationError(table.name, loc, 'Input should be an object')
      }
      return parseFields(nestedTable(field), value, loc)
    }
    case 'model-list': {
      if (!Array.isArray(value)) {
        throw new GenaiValidationError(table.name, loc, 'Input should be a valid array')
      }
      const inner = nestedTable(field)
      return value.map((item, index) => {
        const itemLoc = joinLoc(loc, String(index))
        if (!isPlainObject(item)) {
          throw new GenaiValidationError(table.name, itemLoc, 'Input should be an object')
        }
        return parseFields(inner, item, itemLoc)
      })
    }
  }
}

function cloneJsonValue(value: unknown): PyJsonValue {
  if (value === null) return null
  if (value instanceof PyFloat) return value
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return value
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (isPlainObject(value)) {
    const out: Record<string, PyJsonValue> = {}
    for (const key of Object.keys(value)) out[key] = cloneJsonValue(value[key])
    return out
  }
  throw new TypeError('Object of type object is not JSON serializable')
}

export function contentModelValidateJson(text: string): Content {
  let data: unknown
  try {
    data = pyJsonLoads(text)
  } catch (error) {
    throw new GenaiValidationError(
      'Content',
      '',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!isPlainObject(data)) {
    throw new GenaiValidationError('Content', '', 'Input should be an object')
  }
  return parseFields(TABLES.Content, data, '') as unknown as Content
}

export function modelFieldNames(model: string): { name: string; alias: string }[] {
  return (TABLES[model]?.fields ?? []).map((field) => ({ name: field.name, alias: field.alias }))
}

function wireJsonValue(value: unknown): unknown {
  if (value instanceof PyFloat) return value.value
  if (Array.isArray(value)) return value.map(wireJsonValue)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = wireJsonValue(value[key])
    return out
  }
  return value
}

function wireFields(table: ModelTable, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of table.fields) {
    const raw = value[field.name]
    if (raw === undefined || raw === null) continue
    if (field.kind === 'model') {
      out[field.alias] = wireFields(nestedTable(field), raw as Record<string, unknown>)
    } else if (field.kind === 'model-list') {
      const inner = nestedTable(field)
      out[field.alias] = (raw as unknown[]).map((item) =>
        wireFields(inner, item as Record<string, unknown>)
      )
    } else if (field.kind === 'dict') {
      out[field.alias] = wireJsonValue(raw)
    } else {
      out[field.alias] = raw
    }
  }
  return out
}

export function contentToWire(content: Content): Record<string, unknown> {
  return wireFields(TABLES.Content, content as unknown as Record<string, unknown>)
}
