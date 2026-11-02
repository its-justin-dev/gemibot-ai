import { describe, expect, it } from 'vitest'

import {
  parseJsonObject,
  validateArchitecture,
  validatePlan,
  validateRepair,
  validateReview,
  validateScaffold,
  validateSpec
} from '../../src/shared/utils/build-validate'

function milestone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1',
    title: 'Milestone one',
    goal: 'Ship the first slice',
    acceptance: ['It works'],
    tasks: [
      {
        id: 't1',
        title: 'Task one',
        description: 'Write the service',
        files: ['src/service.ts'],
        acceptance: ['Exports a service'],
        dependsOn: []
      }
    ],
    ...overrides
  }
}

describe('validateSpec', () => {
  it('normalizes a complete spec', () => {
    const result = validateSpec({
      goal: '  Inventory tracker  ',
      users: ['Staff', 42, ' Advisors '],
      features: [' Track stock ', '', 'Reports'],
      stack: ['React'],
      dataModel: ['Item'],
      surfaces: ['/items'],
      outOfScope: ['Billing'],
      assumptions: ['Single warehouse'],
      clarifyQuestions: ['Which database?', 'Which auth?', 'Which host?', 'Dropped']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.goal).toBe('Inventory tracker')
    expect(result.value.users).toEqual(['Staff', 'Advisors'])
    expect(result.value.features).toEqual(['Track stock', 'Reports'])
    expect(result.value.clarifyQuestions).toHaveLength(3)
  })

  it('rejects non-objects, empty goals and featureless specs', () => {
    expect(validateSpec(null).ok).toBe(false)
    expect(validateSpec([]).ok).toBe(false)
    expect(validateSpec({ goal: '  ', features: ['x'] }).ok).toBe(false)
    expect(validateSpec({ goal: 'App', features: [] }).ok).toBe(false)
    expect(validateSpec({ goal: 'App' }).ok).toBe(false)
  })

  it('caps feature and assumption lists', () => {
    const result = validateSpec({
      goal: 'App',
      features: Array.from({ length: 40 }, (_, index) => `Feature ${index}`),
      assumptions: Array.from({ length: 30 }, (_, index) => `Assumption ${index}`)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.features).toHaveLength(30)
    expect(result.value.assumptions).toHaveLength(20)
  })
})

describe('validateArchitecture', () => {
  it('normalizes modules, folders and contracts', () => {
    const result = validateArchitecture({
      summary: 'Express API with a React client',
      folders: [
        { path: 'src/api', purpose: 'HTTP routes' },
        { path: '', purpose: 'ignored' },
        { path: 'src/ui', purpose: '' }
      ],
      modules: [
        { name: 'api', path: 'src/api', responsibility: 'Routes', dependsOn: ['db'] },
        { name: '', path: 'src/bad', responsibility: 'ignored' }
      ],
      contracts: [
        { kind: 'route', name: 'GET /items', signature: 'GET /items -> Item[]', notes: 'public' },
        { kind: 'made-up', name: 'db', signature: 'open()' },
        { name: 'missing-signature' }
      ],
      schema: ['items(id, name)'],
      conventions: ['strict TypeScript'],
      sharedFiles: ['./src/shared.ts', 'src\\shared.ts', '..\\secret.ts', '/abs.ts', 'C:\\x.ts']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.folders).toEqual([{ path: 'src/api', purpose: 'HTTP routes' }])
    expect(result.value.modules).toHaveLength(1)
    expect(result.value.contracts).toHaveLength(2)
    expect(result.value.contracts[1]).toMatchObject({ kind: 'module', notes: '' })
    expect(result.value.sharedFiles).toEqual(['src/shared.ts', 'src/shared.ts'])
  })

  it('requires a summary and at least one module', () => {
    expect(validateArchitecture({ summary: '', modules: [{ name: 'x', path: 'x' }] }).ok).toBe(false)
    expect(validateArchitecture({ summary: 'ok', modules: [] }).ok).toBe(false)
    expect(validateArchitecture({ summary: 'ok' }).ok).toBe(false)
    expect(validateArchitecture(null).ok).toBe(false)
  })
})

describe('validatePlan', () => {
  it('accepts a one-milestone plan with defaults', () => {
    const result = validatePlan({ milestones: [milestone()] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.summary).toBe('Milestone plan')
    expect(result.value.milestones[0]).toMatchObject({
      id: 'm1',
      goal: 'Ship the first slice',
      tasks: [{ id: 't1', description: 'Write the service' }]
    })
  })

  it('rejects missing, too many or empty milestones', () => {
    expect(validatePlan({}).ok).toBe(false)
    expect(validatePlan({ milestones: [] }).ok).toBe(false)
    expect(
      validatePlan({ milestones: Array.from({ length: 7 }, () => milestone()) }).ok
    ).toBe(false)
    expect(validatePlan({ milestones: [milestone({ tasks: [] })] }).ok).toBe(false)
    expect(validatePlan({ milestones: [milestone({ title: '' })] }).ok).toBe(false)
  })

  it('rejects duplicate task ids and shared file ownership', () => {
    const duplicateId = validatePlan({
      milestones: [
        milestone({
          tasks: [
            { id: 't1', title: 'One', files: ['a.ts'] },
            { id: 't1', title: 'Two', files: ['b.ts'] }
          ]
        })
      ]
    })
    expect(duplicateId.ok).toBe(false)
    if (!duplicateId.ok) expect(duplicateId.error).toContain('Duplicate task id t1')

    const shared = validatePlan({
      milestones: [
        milestone({
          tasks: [
            { id: 't1', title: 'One', files: ['src/shared.ts'] },
            { id: 't2', title: 'Two', files: ['src/other.ts', 'src/shared.ts'] }
          ]
        })
      ]
    })
    expect(shared.ok).toBe(false)
    if (!shared.ok) expect(shared.error).toContain('both edit src/shared.ts')
  })

  it('rejects duplicate milestone ids and prototype keys', () => {
    const duplicate = validatePlan({
      milestones: [milestone(), milestone({ tasks: [{ id: 't2', title: 'Two', files: ['b.ts'] }] })]
    })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error).toContain('Duplicate milestone id m1')

    const reservedTask = validatePlan({
      milestones: [
        milestone({
          tasks: [{ id: '__proto__', title: 'One', files: ['a.ts'] }]
        })
      ]
    })
    expect(reservedTask.ok).toBe(false)

    const reservedMilestone = validatePlan({
      milestones: [milestone({ id: '__proto__' })]
    })
    expect(reservedMilestone.ok).toBe(false)
  })

  it('rejects unknown and self dependencies', () => {
    const unknown = validatePlan({
      milestones: [
        milestone({
          tasks: [{ id: 't1', title: 'One', files: ['a.ts'], dependsOn: ['nope'] }]
        })
      ]
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('unknown task nope')

    const self = validatePlan({
      milestones: [
        milestone({
          tasks: [{ id: 't1', title: 'One', files: ['a.ts'], dependsOn: ['t1'] }]
        })
      ]
    })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.error).toContain('depends on itself')
  })

  it('requires task titles and safe files', () => {
    expect(
      validatePlan({ milestones: [milestone({ tasks: [{ id: 't1', title: '', files: ['a.ts'] }] })] })
        .ok
    ).toBe(false)
    expect(
      validatePlan({ milestones: [milestone({ tasks: [{ id: 't1', title: 'One', files: [] }] })] })
        .ok
    ).toBe(false)
    const unsafe = validatePlan({
      milestones: [
        milestone({ tasks: [{ id: 't1', title: 'One', files: ['../outside.ts'] }] })
      ]
    })
    expect(unsafe.ok).toBe(false)
  })

  it('sanitizes file paths in tasks', () => {
    const result = validatePlan({
      milestones: [
        milestone({
          tasks: [
            {
              id: 't1',
              title: 'One',
              files: ['./src/a.ts', 'src\\b.ts', '/etc/passwd', 'C:\\secret.ts', 'src/../c.ts']
            }
          ]
        })
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.milestones[0].tasks[0].files).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('validateReview', () => {
  it('keeps an explicit failure even when the reviewer listed no issues', () => {
    const failed = validateReview({ passed: false, issues: [] })
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.value.passed).toBe(false)
    expect(failed.value.issues).toEqual([])

    const empty = validateReview({ issues: [] })
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.value.passed).toBe(true)
  })

  it('normalizes concrete issues and drops incomplete ones', () => {
    const result = validateReview({
      passed: true,
      issues: [
        {
          problem: 'Missing validation',
          fix: 'Validate the body',
          files: ['src/app.ts', '../escape.ts']
        },
        { fix: 'no problem' },
        { problem: 'Unsafe files only', fix: 'x', files: ['/etc/passwd'] }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.passed).toBe(true)
    expect(result.value.issues).toEqual([
      { problem: 'Missing validation', fix: 'Validate the body', files: ['src/app.ts'] },
      { problem: 'Unsafe files only', fix: 'x', files: [] }
    ])
  })

  it('rejects non-objects', () => {
    expect(validateReview('nope').ok).toBe(false)
  })
})

describe('validateRepair', () => {
  it('requires at least one edit or create', () => {
    expect(validateRepair({ diagnosis: 'x', edits: [], creates: [] }).ok).toBe(false)
    expect(validateRepair({}).ok).toBe(false)
    expect(validateRepair(null).ok).toBe(false)
  })

  it('sanitizes paths and filter broken entries', () => {
    const result = validateRepair({
      diagnosis: '  Fix imports  ',
      edits: [
        { path: './src/a.ts', search: 'old', replace: 'new' },
        { path: '../a.ts', search: 'old', replace: 'new' },
        { path: 'src/a.ts', search: '', replace: 'new' },
        { path: 'src/a.ts', search: 'old' }
      ],
      creates: [
        { path: 'src/new.ts', content: 'export {}' },
        { path: 'src/empty.ts', content: '' }
      ],
      deletes: ['src/old.ts', '../outside.ts', '/absolute.ts']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.diagnosis).toBe('Fix imports')
    expect(result.value.edits).toEqual([
      { path: 'src/a.ts', search: 'old', replace: 'new' },
      { path: 'src/a.ts', search: 'old', replace: '' }
    ])
    expect(result.value.creates).toEqual([
      { path: 'src/new.ts', content: 'export {}' },
      { path: 'src/empty.ts', content: '' }
    ])
    expect(result.value.deletes).toEqual(['src/old.ts'])
  })
})

describe('validateScaffold', () => {
  it('keeps safe non-empty files', () => {
    const result = validateScaffold({
      files: [
        { path: './package.json', content: '{}' },
        { path: '../bad.ts', content: 'x' },
        { path: 'empty.ts', content: '' }
      ]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([{ path: 'package.json', content: '{}' }])
  })

  it('rejects empty scaffolds', () => {
    expect(validateScaffold({ files: [] }).ok).toBe(false)
    expect(validateScaffold({ files: [{ path: '../x', content: 'x' }] }).ok).toBe(false)
    expect(validateScaffold(null).ok).toBe(false)
  })
})

describe('parseJsonObject', () => {
  it('parses plain and fenced JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonObject('```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } })
    expect(parseJsonObject('```\n{"a":3}\n```')).toEqual({ ok: true, value: { a: 3 } })
  })

  it('extracts an object from leading prose and trailing text', () => {
    expect(parseJsonObject('Here is the plan: {"a":{"b":"}"}} thanks')).toEqual({
      ok: true,
      value: { a: { b: '}' } }
    })
  })

  it('rejects empty, object-free, malformed and unclosed replies', () => {
    expect(parseJsonObject('   ').ok).toBe(false)
    expect(parseJsonObject('no json here').ok).toBe(false)
    expect(parseJsonObject('{"a": }').ok).toBe(false)
    expect(parseJsonObject('{"a": {"b": 1}').ok).toBe(false)
  })
})
