import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'

import type {
  BuildArchitecture,
  BuildDocView,
  BuildDocsView,
  BuildPlan,
  BuildSpec
} from '../../shared/types/build'

export type BuildDocName = 'SPEC' | 'ARCHITECTURE' | 'PLAN' | 'PROGRESS'

const DOC_NAMES: BuildDocName[] = ['SPEC', 'ARCHITECTURE', 'PLAN', 'PROGRESS']

function bullets(items: string[], fallback = '(none)'): string {
  return items.length === 0 ? fallback : items.map((item) => `- ${item}`).join('\n')
}

function isInside(root: string, candidate: string): boolean {
  const base = resolve(root)
  const full = resolve(candidate)
  const lowerBase = base.toLowerCase().replace(/[\\/]+$/u, '')
  const lowerFull = full.toLowerCase()
  return lowerFull === lowerBase || lowerFull.startsWith(`${lowerBase}${sep}`)
}

export class BuildDocsService {
  readonly root: string
  readonly dir: string

  constructor(root: string) {
    this.root = resolve(root)
    this.dir = join(this.root, '.gemibot')
    if (!isInside(this.root, this.dir)) throw new Error('Build docs directory escapes the target root')
  }

  pathFor(name: BuildDocName): string {
    const path = join(this.dir, `${name}.md`)
    if (!isInside(this.root, path)) throw new Error('Build doc path escapes the target root')
    return path
  }

  async write(name: BuildDocName, content: string): Promise<string> {
    const path = this.pathFor(name)
    await mkdir(this.dir, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
    return path
  }

  async read(name: BuildDocName): Promise<string> {
    try {
      return await readFile(this.pathFor(name), 'utf8')
    } catch {
      return ''
    }
  }

  async readAll(): Promise<BuildDocsView> {
    const docs: BuildDocView[] = []
    for (const name of DOC_NAMES) {
      const content = await this.read(name)
      if (content !== '') docs.push({ name, path: this.pathFor(name), content })
    }
    return { docs }
  }

  async writeSpec(spec: BuildSpec): Promise<void> {
    await this.write('SPEC', this.renderSpec(spec))
  }

  async writeArchitecture(architecture: BuildArchitecture): Promise<void> {
    await this.write('ARCHITECTURE', this.renderArchitecture(architecture))
  }

  async writePlan(plan: BuildPlan): Promise<void> {
    await this.write('PLAN', this.renderPlan(plan))
  }

  async writeProgress(markdown: string): Promise<void> {
    await this.write('PROGRESS', markdown)
  }

  renderSpec(spec: BuildSpec): string {
    return [
      '# Build Spec',
      '',
      `## Goal\n${spec.goal}`,
      '',
      `## Users\n${bullets(spec.users)}`,
      '',
      `## Core Features\n${bullets(spec.features)}`,
      '',
      `## Tech Stack\n${bullets(spec.stack)}`,
      '',
      `## Data Model\n${bullets(spec.dataModel)}`,
      '',
      `## Pages / Endpoints\n${bullets(spec.surfaces)}`,
      '',
      `## Out of Scope\n${bullets(spec.outOfScope)}`,
      '',
      `## Assumptions\n${bullets(spec.assumptions)}`,
      ''
    ].join('\n')
  }

  renderArchitecture(architecture: BuildArchitecture): string {
    const folders = architecture.folders
      .map((folder) => `- \`${folder.path}\` — ${folder.purpose}`)
      .join('\n')
    const modules = architecture.modules
      .map(
        (module) =>
          `- **${module.name}** (\`${module.path}\`) — ${module.responsibility}` +
          (module.dependsOn.length > 0 ? `; depends on ${module.dependsOn.join(', ')}` : '')
      )
      .join('\n')
    const contracts = architecture.contracts
      .map((contract) => `- \`${contract.kind}\` **${contract.name}**: ${contract.signature}${contract.notes ? ` — ${contract.notes}` : ''}`)
      .join('\n')
    return [
      '# Build Architecture',
      '',
      `## Summary\n${architecture.summary}`,
      '',
      `## Folder Structure\n${folders || '(none)'}`,
      '',
      `## Modules\n${modules || '(none)'}`,
      '',
      `## Contracts\n${contracts || '(none)'}`,
      '',
      `## Database Schema\n${bullets(architecture.schema)}`,
      '',
      `## Shared Files (orchestrator only)\n${bullets(architecture.sharedFiles)}`,
      '',
      `## Conventions\n${bullets(architecture.conventions)}`,
      ''
    ].join('\n')
  }

  renderPlan(plan: BuildPlan): string {
    const milestones = plan.milestones
      .map((milestone) => {
        const tasks = milestone.tasks
          .map(
            (task) =>
              `  - [ ] **${task.id}** ${task.title}\n` +
              `    - Files: ${task.files.join(', ') || '(none)'}\n` +
              `    - Done when: ${task.acceptance.join('; ') || '(not specified)'}` +
              (task.dependsOn.length > 0 ? `\n    - After: ${task.dependsOn.join(', ')}` : '')
          )
          .join('\n')
        return (
          `## ${milestone.id}: ${milestone.title}\n${milestone.goal}\n\n` +
          `Acceptance:\n${bullets(milestone.acceptance)}\n\nTasks:\n${tasks || '(none)'}`
        )
      })
      .join('\n\n')
    return [
      '# Build Plan',
      '',
      plan.summary,
      '',
      milestones || 'No milestones.',
      '',
      `## Verification\n${bullets(plan.verification)}`,
      '',
      `## Risks\n${bullets(plan.risks)}`,
      ''
    ].join('\n')
  }
}
