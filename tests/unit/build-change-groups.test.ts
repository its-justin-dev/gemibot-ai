import { describe, expect, it } from 'vitest'

import { groupBuildChanges } from '../../src/renderer/src/state/build-change-groups'
import type { FileChangeDict } from '../../src/shared/models/file-change'
import type { BuildView } from '../../src/shared/types/build'

function change(path: string, detail = ''): FileChangeDict {
  return {
    path,
    full_path: `C:/project/${path}`,
    change_type: 'Modified',
    snapshot_id: null,
    original_exists: true,
    timestamp: '2026-10-24 12:00:00',
    detail,
    is_binary: false,
    what: [],
    why: []
  }
}

function view(input: {
  milestones: Array<{ id: string; title: string; files: string[] }>
  conversationId?: string | null
}): BuildView {
  return {
    conversationId: input.conversationId ?? 'conv-1',
    totalMilestones: input.milestones.length,
    milestones: input.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: 'succeeded',
      taskResults: [
        {
          taskId: `${milestone.id}-t1`,
          title: 'task',
          status: 'succeeded',
          summary: '',
          filesChanged: milestone.files,
          issues: [],
          model: '',
          durationMs: 0,
          tokens: 0,
          error: null
        }
      ],
      review: null,
      reviewIssues: [],
      attempts: 0
    }))
  } as unknown as BuildView
}

describe('groupBuildChanges', () => {
  it('leaves small builds and other conversations flat', () => {
    expect(
      groupBuildChanges(
        [change('src/a.ts')],
        view({ milestones: [{ id: 'm1', title: 'Only', files: ['src/a.ts'] }] }),
        'conv-1'
      )
    ).toBeNull()

    expect(
      groupBuildChanges(
        [change('src/a.ts')],
        view({
          milestones: [
            { id: 'm1', title: 'One', files: ['src/a.ts'] },
            { id: 'm2', title: 'Two', files: ['src/b.ts'] }
          ]
        }),
        'conv-2'
      )
    ).toBeNull()
    expect(groupBuildChanges([change('src/a.ts')], null, 'conv-1')).toBeNull()
  })

  it('groups changes by milestone, then setup and unmatched changes', () => {
    const groups = groupBuildChanges(
      [
        change('src/b.ts'),
        change('src/setup/data.ts', 'Build mode'),
        change('notes.txt'),
        change('src/a.ts'),
        change('src/c.ts')
      ],
      view({
        milestones: [
          { id: 'm1', title: 'Core data', files: ['src/a.ts'] },
          { id: 'm2', title: 'Dashboard', files: ['src/b.ts', 'src/c.ts'] }
        ]
      }),
      'conv-1'
    )

    expect(groups?.map((group) => group.title)).toEqual([
      'Build setup',
      'Core data',
      'Dashboard',
      'Other changes'
    ])
    expect(groups?.map((group) => group.items.length)).toEqual([1, 1, 2, 1])
    expect(groups?.find((group) => group.title === 'Dashboard')?.items.map((item) => item.path)).toEqual([
      'src/b.ts',
      'src/c.ts'
    ])
    expect(groups?.find((group) => group.title === 'Build setup')?.items[0].path).toBe(
      'src/setup/data.ts'
    )
    expect(groups?.find((group) => group.title === 'Other changes')?.items[0].path).toBe(
      'notes.txt'
    )
  })

  it('omits empty groups and stays flat when only one group has changes', () => {
    expect(
      groupBuildChanges(
        [change('src/a.ts')],
        view({
          milestones: [
            { id: 'm1', title: 'Core data', files: ['src/a.ts'] },
            { id: 'm2', title: 'Dashboard', files: ['src/b.ts'] }
          ]
        }),
        'conv-1'
      )
    ).toBeNull()
  })

  it('never places the same change in more than one group', () => {
    const groups = groupBuildChanges(
      [change('src/a.ts'), change('src/b.ts')],
      view({
        milestones: [
          { id: 'm1', title: 'Core data', files: ['src/a.ts'] },
          { id: 'm2', title: 'Dashboard', files: ['src/b.ts'] }
        ]
      }),
      'conv-1'
    )
    expect(groups?.flatMap((group) => group.items.map((item) => item.path))).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
  })
})
