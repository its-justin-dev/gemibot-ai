import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

import { BuildRepoMapService } from '../../src/main/services/build-repo-map.service'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-build-map-'))
  workspaces.push(dir)
  return dir
}

async function put(root: string, rel: string, content: string | Buffer): Promise<void> {
  const full = join(root, rel)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content)
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function seededWorkspace(): Promise<string> {
  const root = await workspace()
  await put(
    root,
    'src/service.ts',
    [
      'export interface Item { id: string }',
      'export const MAX_ITEMS = 100',
      'export function listItems(): Item[] { return [] }',
      'export class ItemStore {}',
      'export { listItems as allItems }',
      'router.get("/health", handler)'
    ].join('\n')
  )
  await put(
    root,
    'app/main.py',
    [
      'from fastapi import FastAPI',
      'class ItemStore:',
      '    pass',
      '',
      'def list_items():',
      '    return []',
      '',
      '@app.get("/health")',
      'def health():',
      '    return {"status": "ok"}'
    ].join('\n')
  )
  await put(root, 'package.json', '{"name":"fixture"}')
  await put(root, '.env.example', 'PORT=3000\n')
  await put(root, '.hidden/secret.ts', 'export const secret = true\n')
  await put(root, 'node_modules/dependency/index.js', 'module.exports = 1\n')
  await put(root, '.git/config', '[core]\n')
  await put(root, '.gemibot/SPEC.md', '# Spec\n')
  await put(root, 'coverage/report.ts', 'export const coverage = true\n')
  await put(root, 'binary.ts', Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x00, 0x31]))
  await put(root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return root
}

describe('BuildRepoMapService.files', () => {
  it('lists text files and skips dependencies, VCS, build docs and dotfiles', async () => {
    const root = await seededWorkspace()
    const files = await new BuildRepoMapService(root).files()
    expect(files).toEqual(
      expect.arrayContaining([
        '.env.example',
        'app/main.py',
        'binary.ts',
        'package.json',
        'src/service.ts'
      ])
    )
    expect(files).not.toEqual(
      expect.arrayContaining([
        '.hidden/secret.ts',
        '.git/config',
        '.gemibot/SPEC.md',
        'coverage/report.ts',
        'logo.png',
        'node_modules/dependency/index.js'
      ])
    )
  })

  it('respects the file limit and normalizes Windows separators', async () => {
    const root = await workspace()
    for (let index = 0; index < 12; index++) {
      await put(root, `src/file-${index}.ts`, `export const value${index} = ${index}\n`)
    }
    const files = await new BuildRepoMapService(root).files(5)
    expect(files).toHaveLength(5)
    expect(files.every((file) => !file.includes('\\'))).toBe(true)
  })

  it('returns an empty list for a missing root', async () => {
    const service = new BuildRepoMapService(join(tmpdir(), 'gemibot-missing-root-xyz'))
    expect(await service.files()).toEqual([])
    expect(await service.map()).toBe('(empty project)')
  })
})

describe('BuildRepoMapService.map', () => {
  it('extracts TypeScript, Python and route symbols', async () => {
    const root = await seededWorkspace()
    const map = await new BuildRepoMapService(root).map()
    expect(map).toContain('Files (relative to target root):')
    const tsLine = map.split('\n').find((line) => line.startsWith('src/service.ts:')) ?? ''
    expect(tsLine).toContain('Item')
    expect(tsLine).toContain('MAX_ITEMS')
    expect(tsLine).toContain('listItems')
    expect(tsLine).toContain('ItemStore')
    expect(tsLine).toContain('ROUTE /health')
    const pyLine = map.split('\n').find((line) => line.startsWith('app/main.py:')) ?? ''
    expect(pyLine).toContain('ItemStore')
    expect(pyLine).toContain('list_items')
    expect(pyLine).toContain('health')
    expect(pyLine).toContain('ROUTE /health')
  })

  it('does not put binary content into the map', async () => {
    const root = await seededWorkspace()
    const map = await new BuildRepoMapService(root).map()
    expect(map).toContain('binary.ts')
    expect(map).not.toContain('\u0000')
    const binaryLine = map.split('\n').find((line) => line.startsWith('binary.ts'))
    expect(binaryLine).toBe('binary.ts')
  })

  it('labels large files without reading their content', async () => {
    const root = await workspace()
    await put(root, 'large.ts', `export const huge = '${'x'.repeat(210_000)}'\n`)
    const map = await new BuildRepoMapService(root).map()
    expect(map).toContain('large.ts: (large file)')
  })

  it(
    'bounds the map size',
    async () => {
      const root = await workspace()
      const directory =
        'src/modules-with-a-deliberately-long-directory-name-for-truncation-coverage'
      for (let index = 0; index < 200; index++) {
        await put(
          root,
          `${directory}/module-${index}.ts`,
          [
            `export interface Shape${index} { id: string }`,
            `export const value${index} = ${index}`,
            `export function build${index}(): Shape${index} { return { id: '${index}' } }`,
            `export class Store${index} {}`,
            `router.get('/route-${index}', handler)`
          ].join('\n')
        )
      }
      const map = await new BuildRepoMapService(root).map()
      expect(map.length).toBeLessThanOrEqual(24_000 + '\n[... repository map truncated]'.length)
      expect(map).toContain('[... repository map truncated]')
    },
    // Creating 200 files on a defended Windows volume occasionally passes five seconds; the
    // service work itself is tiny, so the default timeout only makes this test flaky.
    20_000
  )
})

describe('BuildRepoMapService.readRelevant', () => {
  it('reads only requested files inside the root', async () => {
    const root = await seededWorkspace()
    const outside = await workspace()
    await put(outside, 'secret.ts', 'export const leaked = true\n')
    const service = new BuildRepoMapService(root)
    const files = await service.readRelevant([
      'src/service.ts',
      'app/main.py',
      '../outside.ts',
      join(outside, 'secret.ts'),
      'missing.ts'
    ])
    expect(files.map((file) => file.path)).toEqual(['src/service.ts', 'app/main.py'])
    expect(files[0].content).toContain('export function listItems')
    expect(files[1].content).toContain('FastAPI')
  })

  it('clips per-file content and respects the total budget', async () => {
    const root = await workspace()
    await put(root, 'a.ts', 'a'.repeat(500))
    await put(root, 'b.ts', 'b'.repeat(500))
    const service = new BuildRepoMapService(root)
    const clipped = await service.readRelevant(['a.ts'], 100, 1_000)
    expect(clipped[0].content).toHaveLength(100 + '\n[... clipped]'.length)
    expect(clipped[0].content.endsWith('[... clipped]')).toBe(true)

    const budgeted = await service.readRelevant(['a.ts', 'b.ts'], 400, 450)
    const total = budgeted.reduce((sum, file) => sum + file.content.length, 0)
    expect(total).toBeLessThanOrEqual(450 + '\n[... clipped]'.length)
    expect(budgeted).toHaveLength(2)
  })

  it('skips directories, oversized files and binary files', async () => {
    const root = await workspace()
    await put(root, 'huge.ts', 'x'.repeat(500_001))
    await put(root, 'binary.ts', Buffer.from([0x00, 0x01, 0x02]))
    const service = new BuildRepoMapService(root)
    expect(await service.readRelevant(['huge.ts', 'binary.ts', 'src'])).toEqual([])
  })
})
