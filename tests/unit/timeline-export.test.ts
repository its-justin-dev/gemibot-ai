import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WindowEvent, WindowSnapshot } from '@shared/types/window'
import { initialState, reduce, type RendererState } from '../../src/renderer/src/state/window-store'
import {
  isHtmlExport,
  renderTimelineHtml,
  renderTimelineMarkdown
} from '../../src/renderer/src/state/timeline-export'

/**
 * `_render_timeline_markdown` (window_app.py:4302-4330) and `_render_timeline_html` (4331-4341).
 *
 * The expected strings are the v1.0 literals: the header block, the three row branches, the
 * `strip_ansi(out)[:4000]` fence, and the HTML template with its inline styles.  Pills and error
 * rows are in the timeline but not in `chat_history_items`, so they never reach the file.
 */

const SNAPSHOT: WindowSnapshot = {
  history: [],
  stats: [],
  pendingChanges: {
    total_changes: 0,
    counts: { Added: 0, Modified: 0, Deleted: 0, Generated: 0, 'Document edited': 0 },
    files_read: [],
    changes: []
  },
  isGenerating: false,
  status: { text: 'Ready', color: '#10b981' },
  funcOptions: [],
  modelOptions: [],
  fontScaleOptions: [],
  modeOptions: [],
  fontScaleLabel: 'UI Scale: 13px (Normal)',
  fontScaleSize: 13,
  widgetScale: 1,
  targetEntry: '',
  multiAgent: { isActive: false, orchestratorModel: '', subAgents: [], activeSubAgentIdx: null, totalSubTasks: 0, completedSubTasks: 0 }
}

function stateOf(events: WindowEvent[]): RendererState {
  let state = initialState(SNAPSHOT)
  for (const event of events) state = reduce(state, event)
  return state
}

const TARGET = { project: 'C:/work/project', model: 'gemini-3.1-flash-lite' }

const EVENTS: WindowEvent[] = [
  {
    kind: 'user',
    text: '  draw a box  ',
    cpIdx: 0,
    header: 'You  •  10:00:00',
    timestamp: '10:00:00'
  },
  { kind: 'pill', text: 'Checkpoint created', icon: '💾' },
  {
    kind: 'assistant',
    text: 'Done.\nTwo lines.',
    meta: '',
    header: 'm  •  10:00:01',
    timestamp: '10:00:01'
  },
  {
    kind: 'action',
    event: {
      tool: 'run_command',
      status: 'Success',
      duration: 1.5,
      timestamp: '10:00:02',
      args: { command: 'ls' },
      output: '\u001b[31mred\u001b[0m'
    }
  },
  { kind: 'error', title: 't', message: 'm', details: 'd', icon: '❌', header: 'h' }
]

describe('_render_timeline_markdown', () => {
  it('writes the v1.0 header block and only the three recorded row types', () => {
    const md = renderTimelineMarkdown(stateOf(EVENTS), TARGET)
    const lines = md.split('\n')
    expect(lines.slice(0, 6)).toEqual([
      '# GemiBot AI Activity Timeline',
      expect.stringMatching(/^Exported: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      'Project: C:/work/project',
      'Model: gemini-3.1-flash-lite',
      '---',
      ''
    ])
    expect(lines.slice(6)).toEqual([
      '### 👤 User (10:00:00)',
      'draw a box',
      '',
      '### 🤖 GemiBot AI (10:00:01)',
      'Done.',
      'Two lines.',
      '',
      '#### ⚙️ [Success] run_command (1.5s at 10:00:02)',
      '**Summary:** $ ls',
      '```',
      'red',
      '```',
      ''
    ])
  })

  it('truncates the stripped output at 4000 code points', () => {
    const out = 'x'.repeat(5000)
    const state = stateOf([
      { kind: 'action', event: { tool: 'mystery', status: 'Done', output: out } }
    ])
    const md = renderTimelineMarkdown(state, TARGET)
    expect(md).toContain(`${'x'.repeat(4000)}\n`)
    expect(md).not.toContain('x'.repeat(4001))
  })

  it('leaves the stamp to the moment of rendering, after the dialog', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 22, 14, 5, 9))
    try {
      const md = renderTimelineMarkdown(stateOf([]), TARGET)
      expect(md.split('\n')[1]).toBe('Exported: 2026-10-22 14:05:09')
    } finally {
      vi.useRealTimers()
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('_render_timeline_html', () => {
  it('escapes the markdown and wraps it in the fixed v1.0 template', () => {
    const html = renderTimelineHtml(stateOf(EVENTS), TARGET)
    expect(html.startsWith('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">')).toBe(true)
    expect(html).toContain('<pre># GemiBot AI Activity Timeline\nExported: ')
    expect(html).toContain('### 👤 User (10:00:00)\ndraw a box')
    expect(html.endsWith('</body>\n</html>')).toBe(true)
  })

  it('escapes &, < and > in the same order as escape_markup', () => {
    const state = stateOf([
      { kind: 'user', text: 'a & b <tag>', cpIdx: null, header: 'h', timestamp: '10:00:00' }
    ])
    const html = renderTimelineHtml(state, TARGET)
    expect(html).toContain('a &amp; b &lt;tag&gt;')
  })

  it('picks HTML only for a lowercase .html suffix', () => {
    expect(isHtmlExport('C:/tmp/a.html')).toBe(true)
    expect(isHtmlExport('C:/tmp/a.HTML')).toBe(false)
    expect(isHtmlExport('C:/tmp/a.md')).toBe(false)
  })
})
