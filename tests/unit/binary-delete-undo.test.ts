import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onConsoleOutput } from '../../src/main/utils/console-out'
import { Agent } from '../../src/main/services/agent.service'

/**
 * `delete_file` records what it removed on the undo stack. For a binary file the text field is
 * empty, so the original bytes have to ride along in the fourth tuple slot; otherwise `/undo`
 * would "restore" an empty file.
 */

let root = ''
let detach: (() => void) | null = null

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

describe('undo after a binary delete', () => {
  it('restores the original bytes instead of an empty file', async () => {
    root = await mkdtemp(join(tmpdir(), 'gemibot-binary-undo-'))
    const agent = await Agent.create({
      root,
      model: 'gemini-3.5-flash-lite',
      autoYes: true,
      apiKey: 'parity-test-placeholder',
      choose: async () => null
    })
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x01, 0x02
    ])
    await writeFile(join(root, 'art.bin'), bytes)

    const result = await agent.tools.execute('delete_file', { path: 'art.bin' })
    expect(result.output).toBe('Deleted art.bin')
    expect(existsSync(join(root, 'art.bin'))).toBe(false)

    await agent.undo()
    expect(await readFile(join(root, 'art.bin'))).toEqual(bytes)
  })
})
