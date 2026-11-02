import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'

/**
 * v2 tolerance for `glob_files`, on top of the v1.0 behaviour pinned in parity-tools.test.ts.
 * `path` is the argument every other workspace tool takes, so models pass it here too; scoping
 * the search is what they mean, and failing the call is what used to happen.
 */

let root = ''
let detach: (() => void) | null = null

async function makeAgent(): Promise<Agent> {
  root = await mkdtemp(join(tmpdir(), 'gemibot-glob-'))
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await writeFile(join(root, 'notes.txt'), 'a\n')
  await writeFile(join(root, 'src', 'a.ts'), 'b\n')
  await writeFile(join(root, 'src', 'deep', 'b.ts'), 'c\n')
  return await Agent.create({
    root,
    model: 'gemini-3.5-flash-lite',
    autoYes: true,
    apiKey: 'parity-test-placeholder',
    choose: async () => null
  })
}

async function run(agent: Agent, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await agent.tools.execute('glob_files', args)
}

function output(result: Record<string, unknown>): string {
  return String(result.output ?? result.error)
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

describe('glob_files path argument', () => {
  it('still answers the v1 shape when path is omitted', async () => {
    const agent = await makeAgent()
    expect(output(await run(agent, { pattern: '**/*.ts' }))).toBe('src/a.ts\nsrc/deep/b.ts')
  })

  it('scopes the search instead of rejecting the call', async () => {
    const agent = await makeAgent()
    expect(output(await run(agent, { pattern: '*.ts', path: 'src' }))).toBe('src/a.ts')
    expect(output(await run(agent, { pattern: '**/*.ts', path: './src/' }))).toBe(
      'src/a.ts\nsrc/deep/b.ts'
    )
  })

  it('keeps refusing a path outside the target directory', async () => {
    const agent = await makeAgent()
    expect(output(await run(agent, { pattern: '*.ts', path: '../../etc' }))).toContain(
      'Access denied: Path'
    )
  })
})
