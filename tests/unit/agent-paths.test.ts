import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentPaths } from '../../src/main/services/agent-paths.service'

let base = ''
let root = ''
let outside = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gemibot-paths-'))
  root = join(base, 'work')
  outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'inside.txt'), 'ok')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('AgentPaths.resolve containment', () => {
  it('accepts files inside the root', async () => {
    const paths = new AgentPaths(root)
    expect(await paths.resolve('inside.txt')).toBe(join(root, 'inside.txt'))
    expect(await paths.resolve('nested/new.txt')).toBe(join(root, 'nested', 'new.txt'))
  })

  it('rejects lexical traversal outside the root', async () => {
    const paths = new AgentPaths(root)
    await expect(paths.resolve('../outside')).rejects.toThrow(/Access denied/)
    await expect(paths.resolve(join(outside, 'x.txt'))).rejects.toThrow(/Access denied/)
  })

  it('rejects a linked directory that points outside the root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret')
    try {
      await symlink(outside, join(root, 'link'), 'junction')
    } catch {
      return
    }
    const paths = new AgentPaths(root)
    await expect(paths.resolve('link/secret.txt')).rejects.toThrow(/Access denied/)
    await expect(paths.resolve('link/new.txt')).rejects.toThrow(/Access denied/)
  })

  it('accepts a link that stays inside the root', async () => {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'a.txt'), 'a')
    try {
      await symlink(join(root, 'real'), join(root, 'alias'), 'junction')
    } catch {
      return
    }
    const paths = new AgentPaths(root)
    expect(await paths.resolve('alias/a.txt')).toBe(join(root, 'alias', 'a.txt'))
  })
})
