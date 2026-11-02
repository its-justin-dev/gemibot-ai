import type {
  BuildArchitecture,
  BuildMilestone,
  BuildPlan,
  BuildSpec,
  BuildTask,
  BuildVerification
} from '../types/build'

/**
 * Original instructions for GemiBot Build mode. The base block is byte-stable so repeated stage
 * calls share a cacheable prefix; stage-specific rules are appended after it.
 */
export const BUILD_BASE_PROMPT = [
  'You are GemiBot Build, the planning and construction engine inside GemiBot AI.',
  'You turn one product request into a small, working, verified project.',
  '',
  'Non-negotiable rules:',
  '- Work only inside the target folder. Never propose absolute paths, parent traversal or files outside it.',
  '- Choose boring, maintained, pinned dependencies. Do not add a package unless the feature needs it.',
  '- Never put secrets, API keys or tokens in code, docs, examples or logs. Use environment variables and .env.example.',
  '- Design contracts first (routes, types, schemas, function signatures) and keep every module consistent with them.',
  '- Prefer small files, explicit interfaces and targeted edits. Never reprint a whole file when a search/replace is enough.',
  '- Do not claim anything is implemented or verified unless a command actually ran and passed.',
  '- If requirements are vague, make the simplest popular choice and record it as an assumption.',
  '- Respect any stack the user named and any existing project conventions.',
  '- Return only the requested output. JSON responses must be one valid JSON object with no markdown fences.'
].join('\n')

const SPEC_RULES = [
  'Stage: understand and decide.',
  'Write a short, concrete spec. Prefer the smallest stack that satisfies the request.',
  'clarifyQuestions may contain at most one batched round (0-3 questions). Leave it empty unless a wrong assumption would be expensive; list the default you would choose for each question in assumptions.',
  'Return this JSON shape:',
  '{"goal":"one sentence","users":["..."],"features":["..."],"stack":["framework and database choices"],"dataModel":["entity: fields"],"surfaces":["page or endpoint"],"outOfScope":["..."],"assumptions":["..."],"clarifyQuestions":["..."]}'
].join('\n')

const ARCHITECTURE_RULES = [
  'Stage: architecture and contracts.',
  'Design the folder structure, modules and every cross-module contract before implementation.',
  'Contracts include API routes and payloads, shared types, database schema, and function signatures the tasks must implement.',
  'sharedFiles are files only the orchestrator may edit (routing tables, config, database schema, shared types).',
  'Return this JSON shape:',
  '{"summary":"...","folders":[{"path":"src/...","purpose":"..."}],"modules":[{"name":"...","path":"...","responsibility":"...","dependsOn":["..."]}],"contracts":[{"kind":"route|type|function|schema|module|config","name":"...","signature":"...","notes":"..."}],"schema":["..."],"conventions":["..."],"sharedFiles":["..."]}'
].join('\n')

const PLAN_RULES = [
  'Stage: task graph.',
  'Break the work into 1-5 milestones and small tasks. Each task must touch a disjoint set of files; if two tasks need the same file, merge them or assign that file to one task.',
  'Every task needs testable acceptance criteria. Every dependency must reference an earlier task id.',
  'Prefer 2-6 tasks per milestone. Do not create a task just to describe work another task already does.',
  'Return this JSON shape:',
  '{"summary":"...","milestones":[{"id":"m1","title":"...","goal":"...","acceptance":["..."],"tasks":[{"id":"m1t1","title":"...","description":"...","files":["src/..."],"acceptance":["..."],"dependsOn":["..."]}]}],"verification":["..."],"risks":["..."]}'
].join('\n')

export function specSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\n${SPEC_RULES}`
}

export function specPrompt(input: {
  goal: string
  projectSummary: string
  conventions: string
  feedback?: string[]
}): string {
  return [
    `User request:\n${input.goal}`,
    input.projectSummary ? `Existing project snapshot:\n${input.projectSummary}` : 'Project: new empty folder.',
    input.conventions ? `Existing conventions to respect:\n${input.conventions}` : '',
    input.feedback && input.feedback.length > 0
      ? `User feedback on the previous plan/spec (apply it):\n- ${input.feedback.join('\n- ')}`
      : '',
    'Produce the spec now.'
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function architectureSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\n${ARCHITECTURE_RULES}`
}

export function architecturePrompt(input: {
  goal: string
  spec: BuildSpec
  projectSummary: string
  feedback?: string[]
}): string {
  return [
    `Goal:\n${input.goal}`,
    `Spec:\n${JSON.stringify(input.spec)}`,
    input.projectSummary ? `Existing project snapshot:\n${input.projectSummary}` : '',
    input.feedback && input.feedback.length > 0
      ? `User feedback to apply:\n- ${input.feedback.join('\n- ')}`
      : '',
    'Produce the architecture and contracts now.'
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function planSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\n${PLAN_RULES}`
}

export function planPrompt(input: {
  goal: string
  spec: BuildSpec
  architecture: BuildArchitecture
  feedback?: string[]
}): string {
  return [
    `Goal:\n${input.goal}`,
    `Spec summary:\n${JSON.stringify({
      goal: input.spec.goal,
      features: input.spec.features,
      stack: input.spec.stack,
      dataModel: input.spec.dataModel,
      outOfScope: input.spec.outOfScope
    })}`,
    `Architecture:\n${JSON.stringify(input.architecture)}`,
    input.feedback && input.feedback.length > 0
      ? `User feedback to apply:\n- ${input.feedback.join('\n- ')}`
      : '',
    'Produce the task-graph plan now.'
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function scaffoldSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\nStage: scaffold.\nCreate the smallest runnable skeleton with pinned dependency files and configuration. No product features yet. Return JSON: {"files":[{"path":"relative/path","content":"full file text"}]}`
}

export function scaffoldPrompt(input: {
  spec: BuildSpec
  architecture: BuildArchitecture
  existingFiles: string[]
}): string {
  return [
    `Spec:\n${JSON.stringify(input.spec)}`,
    `Architecture:\n${JSON.stringify(input.architecture)}`,
    input.existingFiles.length > 0
      ? `Files that already exist (never overwrite them):\n${input.existingFiles.join('\n')}`
      : 'The folder is empty.',
    'Produce the scaffold files now. Include .env.example and .gitignore; never include real secrets.'
  ].join('\n\n')
}

export function contractSlice(architecture: BuildArchitecture, task: BuildTask): string {
  const fileSet = new Set(task.files)
  const modules = architecture.modules.filter(
    (module) => fileSet.has(module.path) || [...fileSet].some((file) => file.startsWith(module.path))
  )
  const contracts = architecture.contracts.filter(
    (contract) =>
      [...fileSet].some((file) => contract.signature.includes(file) || contract.name.includes(file)) ||
      contract.kind === 'schema' ||
      contract.kind === 'type'
  )
  return JSON.stringify({
    summary: architecture.summary,
    modules: modules.length > 0 ? modules : architecture.modules.slice(0, 6),
    contracts,
    conventions: architecture.conventions,
    sharedFiles: architecture.sharedFiles
  })
}

/**
 * The full sub-agent instruction. File bodies are already bounded by the orchestrator, so this
 * function only assembles the compact context and hard boundaries.
 */
export function buildTaskPrompt(input: {
  task: BuildTask
  milestone: BuildMilestone
  spec: BuildSpec
  architecture: BuildArchitecture
  fileContents: Array<{ path: string; content: string }>
  previousIssues?: string[]
}): string {
  const specSummary = JSON.stringify({
    goal: input.spec.goal,
    features: input.spec.features,
    dataModel: input.spec.dataModel,
    assumptions: input.spec.assumptions
  })
  const files =
    input.fileContents.length > 0
      ? input.fileContents.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`).join('\n\n')
      : '(none of your files exist yet; create them)'
  return [
    `You are implementing one task of a larger build. Milestone: ${input.milestone.title}.`,
    `Task ${input.task.id}: ${input.task.title}\n${input.task.description}`,
    `Your files (edit or create only these):\n${input.task.files.join('\n')}`,
    `Acceptance criteria:\n- ${input.task.acceptance.join('\n- ')}`,
    `Project spec summary:\n${specSummary}`,
    `Contracts and conventions you must follow:\n${contractSlice(input.architecture, input.task)}`,
    `Shared files owned by the orchestrator (do not edit):\n${
      input.architecture.sharedFiles.join('\n') || '(none)'
    }`,
    `Current content of your files:\n${files}`,
    input.previousIssues && input.previousIssues.length > 0
      ? `Fix these review findings from the previous attempt:\n- ${input.previousIssues.join('\n- ')}`
      : '',
    'Instructions:',
    '- Use edit_file for targeted changes and write_file for new files. Do not reprint unchanged files.',
    '- Keep imports and public signatures exactly as the contracts describe.',
    '- Add focused tests when the task introduces core logic or an endpoint.',
    '- Run only small relevant checks. Do not install global packages and do not touch other tasks.',
    '- Finish by stating what you changed, which files, and anything still broken.'
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function reviewSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\nStage: self-review.\nCheck the milestone against the spec, architecture and acceptance criteria. Find concrete defects: missing files, mismatched routes/types/schema, unused imports, broken wiring, missing tests. Return JSON: {"passed":true,"issues":[{"problem":"...","fix":"...","files":["..."]}]}. Do not list style preferences.`
}

export function milestoneReviewPrompt(input: {
  milestone: BuildMilestone
  spec: BuildSpec
  architecture: BuildArchitecture
  taskResults: Array<{ taskId: string; summary: string; filesChanged: string[] }>
  repoMap: string
  verification: BuildVerification | null
}): string {
  return [
    `Milestone:\n${JSON.stringify(input.milestone)}`,
    `Spec:\n${JSON.stringify(input.spec)}`,
    `Contracts:\n${JSON.stringify({
      contracts: input.architecture.contracts,
      schema: input.architecture.schema,
      sharedFiles: input.architecture.sharedFiles
    })}`,
    `Task results:\n${JSON.stringify(input.taskResults)}`,
    `Repository map:\n${input.repoMap}`,
    input.verification
      ? `Verification result:\n${input.verification.summary}\n${input.verification.steps
          .map((step) => `${step.kind} ${step.command}: ${step.status} (exit ${step.exitCode})`)
          .join('\n')}`
      : 'Verification has not run yet.',
    'Review this milestone now.'
  ].join('\n\n')
}

export function repairSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\nStage: repair.\nDiagnose the real failure and apply the smallest correct fix. Return JSON: {"diagnosis":"...","edits":[{"path":"...","search":"exact existing text","replace":"new text"}],"creates":[{"path":"...","content":"..."}],"deletes":["..."]}. Edits must use exact text from the provided snippets. Never delete unrelated files or use absolute paths.`
}

export function repairPrompt(input: {
  failure: string
  repoMap: string
  files: Array<{ path: string; content: string }>
  previousAttempts: string[]
  attempt: number
}): string {
  return [
    `Failure to fix:\n${input.failure}`,
    `Relevant files:\n${input.files
      .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
      .join('\n\n')}`,
    `Repository map:\n${input.repoMap}`,
    input.previousAttempts.length > 0
      ? `Previous repair attempts that did not work; change the approach instead of repeating them:\n${input.previousAttempts
          .map((attempt) => `- ${attempt}`)
          .join('\n')}`
      : '',
    `Repair attempt ${input.attempt}.`
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}

export function readmeSystemPrompt(): string {
  return `${BUILD_BASE_PROMPT}\n\nStage: documentation.\nWrite a concise README in Markdown for the actual project. Include install, configuration (.env values from .env.example, never real secrets), run, test, project structure and verification commands. Do not invent features that the spec and plan do not contain. Return only Markdown.`
}

export function readmePrompt(input: {
  goal: string
  spec: BuildSpec
  architecture: BuildArchitecture
  plan: BuildPlan
  verification: BuildVerification | null
}): string {
  return [
    `Goal: ${input.goal}`,
    `Spec:\n${JSON.stringify(input.spec)}`,
    `Architecture:\n${JSON.stringify({
      summary: input.architecture.summary,
      folders: input.architecture.folders,
      modules: input.architecture.modules
    })}`,
    `Milestones:\n${input.plan.milestones.map((milestone) => `- ${milestone.title}: ${milestone.goal}`).join('\n')}`,
    input.verification
      ? `Verified commands:\n${input.verification.steps
          .map((step) => `- ${step.command} (${step.status})`)
          .join('\n')}`
      : 'No verification commands are known.',
    'Write the README now.'
  ].join('\n\n')
}

export function progressMarkdown(input: {
  goal: string
  spec: BuildSpec | null
  plan: BuildPlan | null
  milestones: Array<{
    title: string
    status: string
    tasks: Array<{ title: string; status: string; summary: string }>
  }>
  decisions: string[]
  verification: BuildVerification | null
  nextStep: string
}): string {
  const lines = ['# Build Progress', '', `Goal: ${input.goal}`, '']
  if (input.verification) {
    lines.push(`Last verification: ${input.verification.passed ? 'passed' : 'failed'}`, '')
  }
  lines.push('## Done', '')
  let done = 0
  for (const milestone of input.milestones) {
    for (const task of milestone.tasks) {
      if (task.status === 'succeeded') {
        done += 1
        lines.push(`- [x] ${task.title}${task.summary ? ` — ${task.summary}` : ''}`)
      }
    }
  }
  if (done === 0) lines.push('- (none yet)')
  lines.push('', '## In Progress', '')
  let active = 0
  for (const milestone of input.milestones) {
    for (const task of milestone.tasks) {
      if (task.status === 'running' || task.status === 'pending') {
        active += 1
        lines.push(`- [ ] ${task.title} (${task.status})`)
      }
    }
  }
  if (active === 0) lines.push('- (none)')
  lines.push('', '## Next', '', input.nextStep || 'Wait for the next instruction.', '')
  lines.push('## Key Decisions', '')
  if (input.decisions.length === 0) lines.push('- (none recorded)')
  else for (const decision of input.decisions) lines.push(`- ${decision}`)
  if (input.spec && input.spec.assumptions.length > 0) {
    lines.push('', '## Assumptions', '')
    for (const assumption of input.spec.assumptions) lines.push(`- ${assumption}`)
  }
  lines.push('')
  return lines.join('\n')
}
