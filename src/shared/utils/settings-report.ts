import { pyStrip } from './pystr'

export interface SettingsBehaviorSummary {
  responseStyle: string
  deepMode: boolean
  maxSteps: number
  streaming: boolean
}

export interface SettingsReportInput {
  settings: Record<string, string>
  database: string
  scope: string
  behavior: SettingsBehaviorSummary
}

const BEHAVIOR_KEYS = ['response_style', 'deep_mode', 'max_steps', 'stream_responses']

function formatValue(raw: string): string {
  const value = pyStrip(raw ?? '')
  if (value === '') return '(not set)'
  if (value === 'true') return 'on'
  if (value === 'false') return 'off'
  return value
}

function humanizeKey(key: string): string {
  const words = key.split('_').filter((word) => word !== '')
  if (words.length === 0) return key
  const [first, ...rest] = words
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

function appendSection(lines: string[], title: string, items: Array<[string, string]>): void {
  if (items.length === 0) return
  lines.push('', `## ${title}`)
  for (const [label, value] of items) lines.push(`- ${label}: ${value}`)
}

function prefixedSection(
  settings: Record<string, string>,
  prefix: string,
  skip: string[] = []
): Array<[string, string]> {
  const items: Array<[string, string]> = []
  const keys = Object.keys(settings)
    .filter((key) => key.startsWith(prefix) && !skip.includes(key))
    .sort((a, b) => a.localeCompare(b))
  for (const key of keys) {
    items.push([humanizeKey(key.slice(prefix.length)), formatValue(settings[key])])
  }
  return items
}

export function buildSettingsReport(input: SettingsReportInput): string {
  const { settings, database, scope, behavior } = input
  const lines = [
    '# Settings & Preferences',
    '',
    '## Storage',
    `- Database: ${database}`,
    `- Scope: ${scope}`,
    '- Backend: SQLite conversation database',
    `- Saved keys: ${Object.keys(settings).length}`,
    '',
    '## Behavior',
    `- Response style: ${behavior.responseStyle}`,
    `- Deep mode: ${behavior.deepMode ? 'on' : 'off'}`,
    `- Max steps: ${behavior.maxSteps}`,
    `- Streaming: ${behavior.streaming ? 'on' : 'off'}`
  ]

  const used = new Set(BEHAVIOR_KEYS)

  const workspace: Array<[string, string]> = []
  const workspaceFields: Array<[string, string]> = [
    ['target_directory', 'Target directory'],
    ['function_suite', 'Function suite'],
    ['mode', 'Mode']
  ]
  for (const [key, label] of workspaceFields) {
    if (!(key in settings)) continue
    workspace.push([label, formatValue(settings[key])])
    used.add(key)
  }
  appendSection(lines, 'Workspace', workspace)

  const model: Array<[string, string]> = []
  const modelFields: Array<[string, string]> = [
    ['model', 'Model'],
    ['effort_level', 'Effort level']
  ]
  for (const [key, label] of modelFields) {
    if (!(key in settings)) continue
    model.push([label, formatValue(settings[key])])
    used.add(key)
  }
  appendSection(lines, 'Model & effort', model)

  const ui: Array<[string, string]> = []
  if ('ui_scale_label' in settings || 'ui_scale' in settings) {
    const label = settings['ui_scale_label'] ?? ''
    const scale = settings['ui_scale'] ?? ''
    ui.push(['UI scale', formatValue(pyStrip(label) !== '' ? label : scale)])
    used.add('ui_scale_label')
    used.add('ui_scale')
  }
  for (const [key, label] of [
    ['theme', 'Theme'],
    ['window_geometry', 'Window geometry']
  ] as Array<[string, string]>) {
    if (!(key in settings)) continue
    ui.push([label, formatValue(settings[key])])
    used.add(key)
  }
  appendSection(lines, 'Interface', ui)

  const build = prefixedSection(settings, 'build_', ['build_mode'])
  if ('build_mode' in settings) {
    build.unshift(['Build mode', formatValue(settings['build_mode'])])
  }
  for (const key of Object.keys(settings).filter((key) => key.startsWith('build_'))) {
    used.add(key)
  }
  appendSection(lines, 'Build', build)

  const token = prefixedSection(settings, 'token_')
  for (const key of Object.keys(settings).filter((key) => key.startsWith('token_'))) {
    used.add(key)
  }
  appendSection(lines, 'Token optimization', token)

  const compaction = prefixedSection(settings, 'compaction_')
  for (const key of Object.keys(settings).filter((key) => key.startsWith('compaction_'))) {
    used.add(key)
  }
  appendSection(lines, 'Compaction', compaction)

  const other = Object.keys(settings)
    .filter((key) => !used.has(key))
    .sort((a, b) => a.localeCompare(b))
    .map<[string, string]>((key) => [humanizeKey(key), formatValue(settings[key])])
  appendSection(lines, 'Other saved preferences', other)

  return lines.join('\n')
}
