import type { FileChangeDict } from '@shared/models/file-change'
import type { BuildView } from '@shared/types/build'

export interface BuildChangeGroup {
  id: string
  title: string
  items: FileChangeDict[]
}

/**
 * Groups pending changes for multi-milestone builds. Paths come from each task's reported
 * files, so no extra storage is needed. Small builds and unrelated conversations stay flat.
 */
export function groupBuildChanges(
  changes: FileChangeDict[],
  view: BuildView | null,
  activeConversationId: string | null
): BuildChangeGroup[] | null {
  if (view === null || view.totalMilestones < 2) return null
  if (view.conversationId !== null && view.conversationId !== activeConversationId) return null

  const owners = new Map<string, string>()
  for (const milestone of view.milestones) {
    for (const result of milestone.taskResults) {
      for (const file of result.filesChanged) owners.set(file, milestone.id)
    }
  }

  const setup: BuildChangeGroup = { id: 'build-setup', title: 'Build setup', items: [] }
  const groups: BuildChangeGroup[] = [
    setup,
    ...view.milestones.map((milestone) => ({
      id: `milestone-${milestone.id}`,
      title: milestone.title,
      items: [] as FileChangeDict[]
    })),
    { id: 'other-changes', title: 'Other changes', items: [] as FileChangeDict[] }
  ]
  const byId = new Map(groups.map((group) => [group.id, group]))

  for (const change of changes) {
    const milestoneId = owners.get(change.path)
    if (milestoneId !== undefined) {
      byId.get(`milestone-${milestoneId}`)?.items.push(change)
    } else if (change.detail === 'Build mode') {
      setup.items.push(change)
    } else {
      byId.get('other-changes')?.items.push(change)
    }
  }

  const filled = groups.filter((group) => group.items.length > 0)
  return filled.length > 1 ? filled : null
}
