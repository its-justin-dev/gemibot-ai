import type {
  BuildArchitecture,
  BuildContract,
  BuildMilestone,
  BuildPlan,
  BuildSpec,
  BuildTask
} from '../types/build'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function stringList(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .slice(0, max)
}

function safeFiles(value: unknown): string[] {
  return stringList(value, 30)
    .map((file) => file.replaceAll('\\', '/').replace(/^\.\/+/u, ''))
    .filter(
      (file) =>
        file !== '' &&
        !file.startsWith('/') &&
        !/^[a-z]:[/\\]/iu.test(file) &&
        !file.split('/').includes('..')
    )
}

export function validateSpec(value: unknown): ValidationResult<BuildSpec> {
  const data = record(value)
  if (data === null) return { ok: false, error: 'Expected a JSON object for the spec.' }
  const goal = text(data['goal'])
  const features = stringList(data['features'], 30)
  if (goal === '') return { ok: false, error: 'spec.goal must be a non-empty string.' }
  if (features.length === 0) {
    return { ok: false, error: 'spec.features must contain at least one feature.' }
  }
  return {
    ok: true,
    value: {
      goal,
      users: stringList(data['users'], 12),
      features,
      stack: stringList(data['stack'], 12),
      dataModel: stringList(data['dataModel'], 20),
      surfaces: stringList(data['surfaces'], 30),
      outOfScope: stringList(data['outOfScope'], 20),
      assumptions: stringList(data['assumptions'], 20),
      clarifyQuestions: stringList(data['clarifyQuestions'], 3)
    }
  }
}

function validateContract(value: unknown): BuildContract | null {
  const data = record(value)
  if (data === null) return null
  const name = text(data['name'])
  const signature = text(data['signature'])
  if (name === '' || signature === '') return null
  const kinds = ['route', 'type', 'function', 'schema', 'module', 'config']
  const kind = kinds.includes(text(data['kind'])) ? (text(data['kind']) as BuildContract['kind']) : 'module'
  return { kind, name, signature, notes: text(data['notes']) }
}

export function validateArchitecture(value: unknown): ValidationResult<BuildArchitecture> {
  const data = record(value)
  if (data === null) return { ok: false, error: 'Expected a JSON object for the architecture.' }
  const summary = text(data['summary'])
  if (summary === '') return { ok: false, error: 'architecture.summary must not be empty.' }
  const folders = Array.isArray(data['folders'])
    ? data['folders']
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({ path: text(item['path']), purpose: text(item['purpose']) }))
        .filter((item) => item.path !== '' && item.purpose !== '')
        .slice(0, 60)
    : []
  const modules = Array.isArray(data['modules'])
    ? data['modules']
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          name: text(item['name']),
          path: text(item['path']),
          responsibility: text(item['responsibility']),
          dependsOn: stringList(item['dependsOn'], 12)
        }))
        .filter((item) => item.name !== '' && item.path !== '')
        .slice(0, 40)
    : []
  const contracts = Array.isArray(data['contracts'])
    ? data['contracts']
        .map(validateContract)
        .filter((item): item is BuildContract => item !== null)
        .slice(0, 100)
    : []
  if (modules.length === 0) {
    return { ok: false, error: 'architecture.modules must list at least one module.' }
  }
  return {
    ok: true,
    value: {
      summary,
      folders,
      modules,
      contracts,
      schema: stringList(data['schema'], 40),
      conventions: stringList(data['conventions'], 20),
      sharedFiles: safeFiles(data['sharedFiles'])
    }
  }
}

function validateTask(value: unknown, index: number): BuildTask | null {
  const data = record(value)
  if (data === null) return null
  const id = text(data['id']) || `t${index + 1}`
  const title = text(data['title'])
  if (title === '') return null
  const files = safeFiles(data['files'])
  if (files.length === 0) return null
  return {
    id,
    title,
    description: text(data['description'], title),
    files,
    acceptance: stringList(data['acceptance'], 12),
    dependsOn: stringList(data['dependsOn'], 12)
  }
}

export function validatePlan(value: unknown): ValidationResult<BuildPlan> {
  const data = record(value)
  if (data === null) return { ok: false, error: 'Expected a JSON object for the plan.' }
  const rawMilestones = Array.isArray(data['milestones']) ? data['milestones'] : []
  if (rawMilestones.length === 0 || rawMilestones.length > 6) {
    return { ok: false, error: 'plan.milestones must contain 1 to 6 milestones.' }
  }
  const milestones: BuildMilestone[] = []
  const taskIds = new Set<string>()
  const milestoneIds = new Set<string>()
  const fileOwners = new Map<string, string>()
  for (const [milestoneIndex, raw] of rawMilestones.entries()) {
    const item = record(raw)
    if (item === null) return { ok: false, error: `Milestone ${milestoneIndex + 1} is not an object.` }
    const id = text(item['id']) || `m${milestoneIndex + 1}`
    if (id === '__proto__') {
      return { ok: false, error: 'Milestone id "__proto__" is reserved.' }
    }
    if (milestoneIds.has(id)) {
      return { ok: false, error: `Duplicate milestone id ${id}.` }
    }
    milestoneIds.add(id)
    const title = text(item['title'])
    if (title === '') return { ok: false, error: `Milestone ${id} has no title.` }
    const tasksRaw = Array.isArray(item['tasks']) ? item['tasks'] : []
    const tasks: BuildTask[] = []
    for (const [taskIndex, taskRaw] of tasksRaw.entries()) {
      const task = validateTask(taskRaw, taskIndex)
      if (task === null) {
        return { ok: false, error: `Milestone ${id} task ${taskIndex + 1} needs a title and files.` }
      }
      if (task.id === '__proto__') {
        return { ok: false, error: 'Task id "__proto__" is reserved.' }
      }
      if (taskIds.has(task.id)) {
        return { ok: false, error: `Duplicate task id ${task.id}.` }
      }
      taskIds.add(task.id)
      for (const file of task.files) {
        const owner = fileOwners.get(file)
        if (owner !== undefined) {
          return {
            ok: false,
            error: `Tasks ${owner} and ${task.id} both edit ${file}. Merge them or give the file to one task.`
          }
        }
        fileOwners.set(file, task.id)
      }
      tasks.push(task)
    }
    if (tasks.length === 0) return { ok: false, error: `Milestone ${id} has no tasks.` }
    milestones.push({
      id,
      title,
      goal: text(item['goal'], title),
      acceptance: stringList(item['acceptance'], 12),
      tasks
    })
  }
  for (const milestone of milestones) {
    for (const task of milestone.tasks) {
      for (const dependency of task.dependsOn) {
        if (!taskIds.has(dependency)) {
          return { ok: false, error: `Task ${task.id} depends on unknown task ${dependency}.` }
        }
        if (dependency === task.id) {
          return { ok: false, error: `Task ${task.id} depends on itself.` }
        }
      }
    }
  }
  return {
    ok: true,
    value: {
      summary: text(data['summary'], 'Milestone plan'),
      milestones,
      verification: stringList(data['verification'], 20),
      risks: stringList(data['risks'], 20)
    }
  }
}

export interface BuildReviewResult {
  passed: boolean
  issues: Array<{ problem: string; fix: string; files: string[] }>
}

export function validateReview(value: unknown): ValidationResult<BuildReviewResult> {
  const data = record(value)
  if (data === null) return { ok: false, error: 'Expected a JSON object for the review.' }
  const issues = Array.isArray(data['issues'])
    ? data['issues']
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          problem: text(item['problem']),
          fix: text(item['fix']),
          files: safeFiles(item['files'])
        }))
        .filter((item) => item.problem !== '')
        .slice(0, 20)
    : []
  return {
    ok: true,
    value: {
      // An explicit "not passed" must survive even when the reviewer forgot to list issues.
      passed: data['passed'] === true || (data['passed'] !== false && issues.length === 0),
      issues
    }
  }
}

export interface BuildRepairResult {
  diagnosis: string
  edits: Array<{ path: string; search: string; replace: string }>
  creates: Array<{ path: string; content: string }>
  deletes: string[]
}

export function validateRepair(value: unknown): ValidationResult<BuildRepairResult> {
  const data = record(value)
  if (data === null) return { ok: false, error: 'Expected a JSON object for the repair.' }
  const edits = Array.isArray(data['edits'])
    ? data['edits']
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          path: safeFiles([item['path']])[0] ?? '',
          search: text(item['search']),
          replace: typeof item['replace'] === 'string' ? item['replace'] : ''
        }))
        .filter((item) => item.path !== '' && item.search !== '')
        .slice(0, 20)
    : []
  const creates = Array.isArray(data['creates'])
    ? data['creates']
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          path: safeFiles([item['path']])[0] ?? '',
          content: typeof item['content'] === 'string' ? item['content'] : ''
        }))
        .filter((item) => item.path !== '')
        .slice(0, 20)
    : []
  if (edits.length === 0 && creates.length === 0) {
    return { ok: false, error: 'The repair must contain at least one edit or new file.' }
  }
  return {
    ok: true,
    value: {
      diagnosis: text(data['diagnosis'], 'Repair'),
      edits,
      creates,
      deletes: safeFiles(data['deletes'])
    }
  }
}

export function validateScaffold(value: unknown): ValidationResult<Array<{ path: string; content: string }>> {
  const data = record(value)
  const raw = data !== null && Array.isArray(data['files']) ? data['files'] : []
  const files = raw
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      path: safeFiles([item['path']])[0] ?? '',
      content: typeof item['content'] === 'string' ? item['content'] : ''
    }))
    .filter((item) => item.path !== '' && item.content !== '')
    .slice(0, 60)
  if (files.length === 0) {
    return { ok: false, error: 'The scaffold must contain at least one file.' }
  }
  return { ok: true, value: files }
}

/** Extract the first JSON object from a reply; tolerates fences and leading prose. */
export function parseJsonObject(raw: string): ValidationResult<unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  if (cleaned === '') return { ok: false, error: 'The model returned an empty reply.' }
  try {
    return { ok: true, value: JSON.parse(cleaned) }
  } catch {
    const start = cleaned.indexOf('{')
    if (start === -1) return { ok: false, error: 'No JSON object was found in the reply.' }
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < cleaned.length; index++) {
      const char = cleaned[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return { ok: true, value: JSON.parse(cleaned.slice(start, index + 1)) }
          } catch {
            return { ok: false, error: 'The reply contains malformed JSON.' }
          }
        }
      }
    }
    return { ok: false, error: 'The JSON object in the reply is not closed.' }
  }
}
