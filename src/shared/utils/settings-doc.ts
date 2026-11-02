import { AppConstants } from '../constants/app-constants'
import { pyLstripChars, pySplitlines, pyStrip, pyStripChars } from './pystr'

export function parseSettingsMarkdown(content: string): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const rawLine of pySplitlines(content)) {
    const line = pyStrip(rawLine)
    if (line.startsWith('- **') && line.includes(':**')) {
      const at = line.indexOf(':**')
      const keyPart = line.slice(0, at)
      const valPart = line.slice(at + 3)
      settings[pyStrip(keyPart.replaceAll('- **', ''))] = pyStrip(
        pyStripChars(pyStrip(valPart), '`')
      )
    } else if (line.includes(':') && !(line.startsWith('#') || line.startsWith('>'))) {
      const at = line.indexOf(':')
      const key = pyLstripChars(pyStrip(line.slice(0, at)), '-* ').toLowerCase()
      const value = pyStrip(pyStripChars(pyStrip(line.slice(at + 1)), '`'))
      if (key) settings[key] = value
    }
  }
  return settings
}

export function defaultSettingsBlock(model: string, activeFunction: string, mode: string): string {
  return (
    AppConstants.SETTINGS_HEADER +
    `- **model:** \`${model}\`\n` +
    '- **effort_level:** `medium`\n' +
    `- **function_suite:** \`${activeFunction}\`\n` +
    `- **mode:** \`${mode}\`\n` +
    '- **ui_scale:** `13px`\n' +
    '- **ui_scale_label:** `UI Scale: 13px (Normal)`\n' +
    '- **theme:** `pure_dark`\n' +
    '- **window_geometry:** `1240x800`\n' +
    '- **target_directory:** ``\n'
  )
}
