import { stripAnsi } from '@shared/utils/ansi'
import { pyFloatRepr } from '@shared/utils/pyjson'
import { pySlice, pyStrip, pyStr } from '@shared/utils/pystr'
import { nowStrftime } from '@shared/utils/strftime'
import { actionSummary, payloadGet } from './card-model'
import type { RendererState } from './window-store'

function pyText(value: unknown): string {
  if (typeof value === 'number' && !Number.isInteger(value)) return pyFloatRepr(value)
  return pyStr(value)
}

function truthy(value: unknown): boolean {
  return typeof value === 'string' ? value !== '' : value !== null && value !== undefined
}

export function renderTimelineMarkdown(
  state: RendererState,
  target: { project: string; model: string }
): string {
  const lines = [
    '# GemiBot AI Activity Timeline',
    `Exported: ${nowStrftime('%Y-%m-%d %H:%M:%S')}`,
    `Project: ${target.project}`,
    `Model: ${target.model}`,
    '---',
    ''
  ]
  for (const row of state.chat) {
    switch (row.type) {
      case 'user':
        lines.push(`### 👤 User (${row.timestamp})`)
        lines.push(pyStrip(row.text))
        lines.push('')
        break
      case 'assistant':
        lines.push(`### 🤖 GemiBot AI (${row.timestamp})`)
        lines.push(row.text)
        lines.push('')
        break
      case 'action': {
        const event = row.event
        const tool = pyText(payloadGet(event, 'tool', 'action'))
        const status = pyText(payloadGet(event, 'status', 'Done'))
        const duration = pyText(payloadGet(event, 'duration', 0))
        const timestamp = pyText(payloadGet(event, 'timestamp', ''))
        lines.push(`#### ⚙️ [${status}] ${tool} (${duration}s at ${timestamp})`)
        const summary = actionSummary(event)
        if (summary !== '') lines.push(`**Summary:** ${summary}`)
        const output = pyText(payloadGet(event, 'output', ''))
        if (truthy(output)) {
          lines.push('```')
          lines.push(pySlice(stripAnsi(output), 0, 4000))
          lines.push('```')
        }
        lines.push('')
        break
      }
      default:
        break
    }
  }
  return lines.join('\n')
}

function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function renderTimelineHtml(
  state: RendererState,
  target: { project: string; model: string }
): string {
  const escaped = escapeMarkup(renderTimelineMarkdown(state, target))
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Gemibot Activity Timeline</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; line-height: 1.6; max-width: 900px; margin: 0 auto; }
pre { background: #1e293b; padding: 12px; border-radius: 6px; overflow-x: auto; color: #38bdf8; }
h1, h2, h3, h4 { color: #f8fafc; }
hr { border: 0; border-top: 1px solid #334155; margin: 20px 0; }
</style>
</head>
<body>
<pre>${escaped}</pre>
</body>
</html>`
}

export function isHtmlExport(path: string): boolean {
  return path.endsWith('.html')
}
