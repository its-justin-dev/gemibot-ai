import type {
  BuildEffortSetting,
  BuildModeSetting,
  BuildPlanApproval,
  BuildRoleModels,
  BuildSettings
} from '../types/build'

export const DEFAULT_BUILD_SETTINGS: BuildSettings = {
  mode: 'auto',
  planApproval: 'auto',
  maxTokens: 200_000,
  maxSteps: 300,
  repairAttempts: 5,
  subAgents: 4,
  autoApproveEdits: true,
  installDependencies: true,
  verifyEachMilestone: true,
  smokeTest: true,
  clarify: true,
  roleModels: { strong: '', implementation: '', cheap: '' },
  planningEffort: 'high',
  implementationEffort: 'medium',
  reviewEffort: 'high'
}

const EFFORTS: BuildEffortSetting[] = ['saving', 'low', 'medium', 'high', 'extra_high']

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const clean = value.trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(clean)) return true
    if (['0', 'false', 'off', 'no'].includes(clean)) return false
  }
  return fallback
}

function mode(value: unknown): BuildModeSetting {
  const clean = String(value ?? '').trim().toLowerCase()
  return clean === 'on' || clean === 'off' || clean === 'auto' ? clean : 'auto'
}

function approval(value: unknown): BuildPlanApproval {
  const clean = String(value ?? '').trim().toLowerCase()
  return clean === 'ask' ? 'ask' : 'auto'
}

function effort(value: unknown, fallback: BuildEffortSetting): BuildEffortSetting {
  const clean = String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (clean === 'extrahigh') return 'extra_high'
  return EFFORTS.includes(clean as BuildEffortSetting)
    ? (clean as BuildEffortSetting)
    : fallback
}

function model(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : ''
}

export function normalizeBuildSettings(input: Partial<BuildSettings> = {}): BuildSettings {
  const roleInput: Partial<BuildRoleModels> = input.roleModels ?? {}
  return {
    mode: mode(input.mode ?? DEFAULT_BUILD_SETTINGS.mode),
    planApproval: approval(input.planApproval ?? DEFAULT_BUILD_SETTINGS.planApproval),
    maxTokens: clampInt(input.maxTokens, DEFAULT_BUILD_SETTINGS.maxTokens, 10_000, 2_000_000),
    maxSteps: clampInt(input.maxSteps, DEFAULT_BUILD_SETTINGS.maxSteps, 20, 1_200),
    repairAttempts: clampInt(
      input.repairAttempts,
      DEFAULT_BUILD_SETTINGS.repairAttempts,
      0,
      20
    ),
    subAgents: clampInt(input.subAgents, DEFAULT_BUILD_SETTINGS.subAgents, 2, 6),
    autoApproveEdits: bool(
      input.autoApproveEdits,
      DEFAULT_BUILD_SETTINGS.autoApproveEdits
    ),
    installDependencies: bool(
      input.installDependencies,
      DEFAULT_BUILD_SETTINGS.installDependencies
    ),
    verifyEachMilestone: bool(
      input.verifyEachMilestone,
      DEFAULT_BUILD_SETTINGS.verifyEachMilestone
    ),
    smokeTest: bool(input.smokeTest, DEFAULT_BUILD_SETTINGS.smokeTest),
    clarify: bool(input.clarify, DEFAULT_BUILD_SETTINGS.clarify),
    roleModels: {
      strong: model(roleInput.strong),
      implementation: model(roleInput.implementation),
      cheap: model(roleInput.cheap)
    },
    planningEffort: effort(input.planningEffort, DEFAULT_BUILD_SETTINGS.planningEffort),
    implementationEffort: effort(
      input.implementationEffort,
      DEFAULT_BUILD_SETTINGS.implementationEffort
    ),
    reviewEffort: effort(input.reviewEffort, DEFAULT_BUILD_SETTINGS.reviewEffort)
  }
}

export function buildSettingsFromDict(dict: Record<string, string>): BuildSettings {
  return normalizeBuildSettings({
    mode: dict['build_mode'] as BuildModeSetting | undefined,
    planApproval: dict['build_plan_approval'] as BuildPlanApproval | undefined,
    maxTokens: dict['build_max_tokens'] === undefined ? undefined : Number(dict['build_max_tokens']),
    maxSteps: dict['build_max_steps'] === undefined ? undefined : Number(dict['build_max_steps']),
    repairAttempts:
      dict['build_repair_attempts'] === undefined
        ? undefined
        : Number(dict['build_repair_attempts']),
    subAgents:
      dict['build_sub_agents'] === undefined ? undefined : Number(dict['build_sub_agents']),
    autoApproveEdits: dict['build_auto_approve_edits'] === undefined
      ? undefined
      : bool(dict['build_auto_approve_edits'], DEFAULT_BUILD_SETTINGS.autoApproveEdits),
    installDependencies: dict['build_install_dependencies'] === undefined
      ? undefined
      : bool(dict['build_install_dependencies'], DEFAULT_BUILD_SETTINGS.installDependencies),
    verifyEachMilestone: dict['build_verify_each_milestone'] === undefined
      ? undefined
      : bool(dict['build_verify_each_milestone'], DEFAULT_BUILD_SETTINGS.verifyEachMilestone),
    smokeTest: dict['build_smoke_test'] === undefined
      ? undefined
      : bool(dict['build_smoke_test'], DEFAULT_BUILD_SETTINGS.smokeTest),
    clarify: dict['build_clarify'] === undefined
      ? undefined
      : bool(dict['build_clarify'], DEFAULT_BUILD_SETTINGS.clarify),
    roleModels: {
      strong: dict['build_strong_model'] ?? '',
      implementation: dict['build_implementation_model'] ?? '',
      cheap: dict['build_cheap_model'] ?? ''
    },
    planningEffort: dict['build_planning_effort'] as BuildEffortSetting | undefined,
    implementationEffort: dict['build_implementation_effort'] as BuildEffortSetting | undefined,
    reviewEffort: dict['build_review_effort'] as BuildEffortSetting | undefined
  })
}

export function buildSettingsToDict(settings: BuildSettings): Record<string, string> {
  const clean = normalizeBuildSettings(settings)
  return {
    build_mode: clean.mode,
    build_plan_approval: clean.planApproval,
    build_max_tokens: String(clean.maxTokens),
    build_max_steps: String(clean.maxSteps),
    build_repair_attempts: String(clean.repairAttempts),
    build_sub_agents: String(clean.subAgents),
    build_auto_approve_edits: clean.autoApproveEdits ? 'true' : 'false',
    build_install_dependencies: clean.installDependencies ? 'true' : 'false',
    build_verify_each_milestone: clean.verifyEachMilestone ? 'true' : 'false',
    build_smoke_test: clean.smokeTest ? 'true' : 'false',
    build_clarify: clean.clarify ? 'true' : 'false',
    build_strong_model: clean.roleModels.strong,
    build_implementation_model: clean.roleModels.implementation,
    build_cheap_model: clean.roleModels.cheap,
    build_planning_effort: clean.planningEffort,
    build_implementation_effort: clean.implementationEffort,
    build_review_effort: clean.reviewEffort
  }
}

export function cycleBuildMode(current: BuildModeSetting): BuildModeSetting {
  return current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto'
}

export function buildModeLabel(value: BuildModeSetting): string {
  return value === 'auto' ? 'Build: Auto' : value === 'on' ? 'Build: On' : 'Build: Off'
}

/** Auto approves only plans small enough to review quickly; ask mode always waits. */
export function needsPlanApproval(
  settings: BuildSettings,
  milestones: number,
  tasks: number
): boolean {
  if (settings.planApproval === 'ask') return true
  return milestones > 3 || tasks > 12
}
