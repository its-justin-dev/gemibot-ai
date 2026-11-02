import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  detectDependencyPlan,
  type PackageManager
} from '../../src/main/services/project-deps.service'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gemibot-deps-'))
  roots.push(root)
  return root
}

async function putPackageJson(root: string, content = '{"name":"demo"}'): Promise<void> {
  await writeFile(join(root, 'package.json'), content)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('detectDependencyPlan', () => {
  it('asks for a package.json when the workspace is not a Node project', async () => {
    const root = await makeRoot()
    expect(detectDependencyPlan(root)).toEqual({
      ok: false,
      reason: 'missing-package-json',
      message: `No package.json was found in ${root}.`
    })
  })

  it('rejects a package.json that is not valid JSON', async () => {
    const root = await makeRoot()
    await putPackageJson(root, '{"name":')
    const result = detectDependencyPlan(root)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failed plan')
    expect(result.reason).toBe('invalid-package-json')
    expect(result.message).toContain('package.json is not valid JSON:')
  })

  it('accepts a package.json saved with a UTF-8 BOM', async () => {
    const root = await makeRoot()
    await putPackageJson(root, '\uFEFF{"name":"demo"}')
    expect(detectDependencyPlan(root)).toEqual({
      ok: true,
      plan: { manager: 'npm', source: 'default package manager', command: 'npm install' }
    })
  })

  it('prefers the packageManager field over every lockfile', async () => {
    const root = await makeRoot()
    await putPackageJson(root, '{"name":"demo","packageManager":"pnpm@9.15.0"}')
    await writeFile(join(root, 'package-lock.json'), '{}\n')
    expect(detectDependencyPlan(root)).toEqual({
      ok: true,
      plan: {
        manager: 'pnpm',
        source: 'packageManager field: pnpm@9.15.0',
        command: 'pnpm install'
      }
    })
  })

  const LOCKFILES: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm']
  ]

  it.each(LOCKFILES)('reads %s as %s', async (file, manager) => {
    const root = await makeRoot()
    await putPackageJson(root)
    await writeFile(join(root, file), '')
    expect(detectDependencyPlan(root)).toEqual({
      ok: true,
      plan: { manager, source: `lockfile: ${file}`, command: `${manager} install` }
    })
  })

  it('defaults to npm when no lockfile is present', async () => {
    const root = await makeRoot()
    await putPackageJson(root)
    expect(detectDependencyPlan(root)).toEqual({
      ok: true,
      plan: { manager: 'npm', source: 'default package manager', command: 'npm install' }
    })
  })
})
