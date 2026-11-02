import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

import { BuildDocsService } from '../../src/main/services/build-docs.service'
import type {
  BuildArchitecture,
  BuildPlan,
  BuildSpec
} from '../../src/shared/types/build'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-build-docs-'))
  workspaces.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

const spec: BuildSpec = {
  goal: 'Track inventory',
  users: ['Staff'],
  features: ['Track stock', 'Reports'],
  stack: ['React'],
  dataModel: ['Item(id, name)'],
  surfaces: ['/items'],
  outOfScope: ['Billing'],
  assumptions: ['Single warehouse'],
  clarifyQuestions: []
}

const architecture: BuildArchitecture = {
  summary: 'React client with a small API',
  folders: [{ path: 'src/api', purpose: 'Routes' }],
  modules: [
    { name: 'api', path: 'src/api', responsibility: 'HTTP routes', dependsOn: ['db'] }
  ],
  contracts: [
    {
      kind: 'route',
      name: 'GET /items',
      signature: 'GET /items -> Item[]',
      notes: 'public'
    }
  ],
  schema: ['items(id, name)'],
  conventions: ['Strict TypeScript'],
  sharedFiles: ['src/shared/types.ts']
}

const plan: BuildPlan = {
  summary: 'One milestone',
  milestones: [
    {
      id: 'm1',
      title: 'Core inventory',
      goal: 'Track stock',
      acceptance: ['Stock can be listed'],
      tasks: [
        {
          id: 't1',
          title: 'Inventory service',
          description: 'Build the service',
          files: ['src/api/items.ts'],
          acceptance: ['GET /items works'],
          dependsOn: []
        }
      ]
    }
  ],
  verification: ['npm test'],
  risks: ['No database yet']
}

describe('BuildDocsService', () => {
  it('keeps its directory inside the target root', async () => {
    const root = await workspace()
    const docs = new BuildDocsService(root)
    expect(docs.root).toBe(resolve(root))
    expect(docs.dir).toBe(join(resolve(root), '.gemibot'))
    for (const name of ['SPEC', 'ARCHITECTURE', 'PLAN', 'PROGRESS'] as const) {
      expect(docs.pathFor(name).startsWith(docs.dir)).toBe(true)
    }
  })

  it('writes and reads every build document', async () => {
    const root = await workspace()
    const docs = new BuildDocsService(root)
    await docs.writeSpec(spec)
    await docs.writeArchitecture(architecture)
    await docs.writePlan(plan)
    await docs.writeProgress('# Progress\n\nMilestone m1 running.')

    const all = await docs.readAll()
    expect(all.docs.map((doc) => doc.name)).toEqual([
      'SPEC',
      'ARCHITECTURE',
      'PLAN',
      'PROGRESS'
    ])
    expect(await docs.read('SPEC')).toContain('# Build Spec')
    expect(await docs.read('PLAN')).toContain('Core inventory')
  })

  it('returns an empty string for a missing document', async () => {
    const root = await workspace()
    const docs = new BuildDocsService(root)
    expect(await docs.read('PROGRESS')).toBe('')
    expect(await docs.readAll()).toEqual({ docs: [] })
  })

  it('overwrites documents atomically and leaves no temp files', async () => {
    const root = await workspace()
    const docs = new BuildDocsService(root)
    await docs.writeProgress('first')
    await docs.writeProgress('second')
    expect(await readFile(docs.pathFor('PROGRESS'), 'utf8')).toBe('second')
    const all = await docs.readAll()
    expect(all.docs).toHaveLength(1)
  })

  it('renders a spec with every section and list item', () => {
    const root = resolve(workspaces[0] ?? tmpdir())
    const markdown = new BuildDocsService(root).renderSpec(spec)
    expect(markdown).toContain('## Goal\nTrack inventory')
    expect(markdown).toContain('## Users\n- Staff')
    expect(markdown).toContain('- Track stock')
    expect(markdown).toContain('## Out of Scope\n- Billing')
    expect(markdown).toContain('## Assumptions\n- Single warehouse')
  })

  it('renders architecture modules, contracts and shared files', () => {
    const markdown = new BuildDocsService(tmpdir()).renderArchitecture(architecture)
    expect(markdown).toContain('**api** (`src/api`) — HTTP routes; depends on db')
    expect(markdown).toContain('`route` **GET /items**: GET /items -> Item[] — public')
    expect(markdown).toContain('## Shared Files (orchestrator only)\n- src/shared/types.ts')
    expect(markdown).toContain('`src/api` — Routes')
  })

  it('renders plan checkboxes, files and acceptance criteria', () => {
    const markdown = new BuildDocsService(tmpdir()).renderPlan(plan)
    expect(markdown).toContain('## m1: Core inventory')
    expect(markdown).toContain('- [ ] **t1** Inventory service')
    expect(markdown).toContain('Files: src/api/items.ts')
    expect(markdown).toContain('Done when: GET /items works')
    expect(markdown).toContain('## Verification\n- npm test')
    expect(markdown).toContain('## Risks\n- No database yet')
  })

  it('uses "(none)" for empty optional sections', () => {
    const markdown = new BuildDocsService(tmpdir()).renderSpec({
      ...spec,
      users: [],
      assumptions: []
    })
    expect(markdown).toContain('## Users\n(none)')
    expect(markdown).toContain('## Assumptions\n(none)')
  })
})
