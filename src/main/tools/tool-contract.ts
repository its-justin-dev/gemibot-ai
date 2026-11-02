import type { AgentState } from '../models/agent-state'
import { PythonError } from '../../shared/utils/exceptions'
import { pyStr } from '../../shared/utils/pystr'
import type { AgentGenerate } from '../services/agent-generate.service'
import type { AgentPaths } from '../services/agent-paths.service'
import type { AgentSystem } from '../services/agent-system.service'
import type { AiClient } from '../services/ai-client.service'
import type { ChangeTracker } from '../services/change-tracker.service'
import type { FileOperations } from '../services/file-operations.service'

export function pathArg(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return pyStr(value)
}

export function label(value: unknown): string {
  return pyStr(value)
}

export interface ToolContext {
  state: AgentState
  paths: AgentPaths
  system: AgentSystem
  generate: AgentGenerate
  client: AiClient
  fileOps: FileOperations
  changeTracker: ChangeTracker
  allowed(tool: string, detail: string): Promise<boolean>
  commit(
    tool: string,
    full: string,
    rel: string,
    oldText: string | null,
    newText: string,
    crlf: boolean,
    what?: string,
    why?: string
  ): Promise<string>
  beginBinaryArtifact(fullPath: string): Promise<void>
  recordBinaryArtifact(
    fullPath: string,
    actionLabel: string,
    summaryNote: string,
    what?: string,
    why?: string
  ): Promise<void>
  checkCommandPaths(command: string): string[]
  printTodos(): void
}

export type ToolFn = (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>

export interface ToolParam {
  name: string
  required?: boolean
  default?: unknown
}

export interface ToolSpec {
  python: string
  params: ToolParam[]
  run: ToolFn
}

function joinNames(names: string[]): string {
  const quoted = names.map((n) => `'${n}'`)
  if (names.length < 2) return quoted.join('')
  const last = quoted.pop() as string
  return `${quoted.join(', ')}${quoted.length > 1 ? ',' : ''} and ${last}`
}

export function bindArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(spec.params.map((p) => p.name))
  for (const key of Object.keys(args ?? {})) {
    if (!known.has(key)) {
      throw new PythonError(
        'TypeError',
        `${spec.python}() got an unexpected keyword argument '${key}'`
      )
    }
  }

  const bound: Record<string, unknown> = {}
  const missing: string[] = []
  for (const param of spec.params) {
    if (args && Object.prototype.hasOwnProperty.call(args, param.name)) {
      bound[param.name] = args[param.name]
    } else if (param.required) {
      missing.push(param.name)
    } else {
      bound[param.name] = param.default
    }
  }
  if (missing.length > 0) {
    const plural = missing.length === 1 ? 'argument' : 'arguments'
    throw new PythonError(
      'TypeError',
      `${spec.python}() missing ${missing.length} required positional ${plural}: ${joinNames(missing)}`
    )
  }
  return bound
}
