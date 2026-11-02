export type BuildModeSetting = 'auto' | 'on' | 'off'

export type BuildPlanApproval = 'auto' | 'ask'

export type BuildRunStatus =
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'success'
  | 'failed'
  | 'stopped'

export type BuildStageName =
  | 'spec'
  | 'architecture'
  | 'plan'
  | 'scaffold'
  | 'implement'
  | 'verify'
  | 'finish'

export type BuildStageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export type BuildTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export type BuildVerifyKind = 'install' | 'build' | 'typecheck' | 'lint' | 'test' | 'smoke'

export type BuildEffortSetting = 'saving' | 'low' | 'medium' | 'high' | 'extra_high'

export interface BuildRoleModels {
  /** Spec, architecture, plan, review and hard repair. Empty means pick automatically. */
  strong: string
  /** Milestone implementation. Empty means pick automatically. */
  implementation: string
  /** Summaries, progress notes and formatting. Empty means pick automatically. */
  cheap: string
}

export interface BuildSettings {
  mode: BuildModeSetting
  planApproval: BuildPlanApproval
  maxTokens: number
  maxSteps: number
  repairAttempts: number
  subAgents: number
  autoApproveEdits: boolean
  installDependencies: boolean
  verifyEachMilestone: boolean
  smokeTest: boolean
  /** Ask one batched clarification round when the spec model says an assumption is costly. */
  clarify: boolean
  roleModels: BuildRoleModels
  planningEffort: BuildEffortSetting
  implementationEffort: BuildEffortSetting
  reviewEffort: BuildEffortSetting
}

export interface BuildSpec {
  goal: string
  users: string[]
  features: string[]
  stack: string[]
  dataModel: string[]
  surfaces: string[]
  outOfScope: string[]
  assumptions: string[]
  /** Only filled when a wrong assumption would be expensive; asked at most once. */
  clarifyQuestions: string[]
}

export interface BuildArchitectureModule {
  name: string
  path: string
  responsibility: string
  dependsOn: string[]
}

export interface BuildContract {
  kind: 'route' | 'type' | 'function' | 'schema' | 'module' | 'config'
  name: string
  signature: string
  notes: string
}

export interface BuildArchitecture {
  summary: string
  folders: Array<{ path: string; purpose: string }>
  modules: BuildArchitectureModule[]
  contracts: BuildContract[]
  schema: string[]
  conventions: string[]
  sharedFiles: string[]
}

export interface BuildTask {
  id: string
  title: string
  description: string
  files: string[]
  acceptance: string[]
  dependsOn: string[]
}

export interface BuildMilestone {
  id: string
  title: string
  goal: string
  acceptance: string[]
  tasks: BuildTask[]
}

export interface BuildPlan {
  summary: string
  milestones: BuildMilestone[]
  verification: string[]
  risks: string[]
}

export interface BuildTaskResult {
  taskId: string
  title: string
  status: BuildTaskStatus
  summary: string
  filesChanged: string[]
  issues: string[]
  model: string
  durationMs: number
  tokens: number
  error: string | null
}

export interface BuildMilestoneState {
  id: string
  title: string
  status: BuildTaskStatus
  taskResults: BuildTaskResult[]
  review: string | null
  reviewIssues: string[]
  attempts: number
}

export interface BuildVerifyStep {
  kind: BuildVerifyKind
  command: string
  status: 'success' | 'failed' | 'skipped'
  exitCode: number
  output: string
  durationMs: number
}

export interface BuildVerification {
  steps: BuildVerifyStep[]
  passed: boolean
  summary: string
}

export interface BuildStageRecord {
  stage: BuildStageName
  label: string
  status: BuildStageStatus
  model: string
  startedAt: number
  durationMs: number
  detail: string
  output: string
}

export interface BuildUsageRow {
  label: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
}

export interface BuildView {
  id: string
  conversationId: string | null
  root: string
  goal: string
  status: BuildRunStatus
  stage: BuildStageName
  stageLabel: string
  stages: BuildStageRecord[]
  milestones: BuildMilestoneState[]
  totalMilestones: number
  completedMilestones: number
  tasksDone: number
  tasksTotal: number
  tokensUsed: number
  tokenBudget: number
  stepsUsed: number
  stepBudget: number
  repairAttempts: number
  maxRepairAttempts: number
  planApprovalRequired: boolean
  assumptions: string[]
  summary: string
  error: string | null
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  usage: BuildUsageRow[]
  specPath: string
  architecturePath: string
  planPath: string
  progressPath: string
}

export interface BuildPersistedState {
  view: BuildView
  spec: BuildSpec | null
  architecture: BuildArchitecture | null
  plan: BuildPlan | null
  taskResults: Record<string, BuildTaskResult>
  milestoneReviews: Record<string, string>
  decisions: string[]
  verification: BuildVerification | null
  report: string | null
  scaffoldFiles: string[]
  pendingFeedback: string[]
  planApproved?: boolean
  budgetWarned?: { tokens?: boolean; steps?: boolean }
}

export interface BuildDocView {
  name: string
  path: string
  content: string
}

export interface BuildDocsView {
  docs: BuildDocView[]
}

export interface BuildSummaryLine {
  label: string
  tokens: number
  durationMs: number
}

export interface BuildRunSummary {
  status: BuildRunStatus
  milestones: number
  tasks: number
  repairs: number
  tokens: number
  durationMs: number
}
