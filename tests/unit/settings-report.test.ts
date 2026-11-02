import { describe, expect, it } from 'vitest'

import { buildSettingsReport } from '../../src/shared/utils/settings-report'

describe('buildSettingsReport', () => {
  it('groups saved settings into clean, complete sections', () => {
    const settings: Record<string, string> = {
      model: 'gemini-3.1-flash-lite',
      effort_level: 'medium',
      function_suite: 'all',
      mode: 'build',
      ui_scale: '11px',
      ui_scale_label: 'UI Scale: 11px (Compact)',
      theme: 'pure_dark',
      window_geometry: '1240x800',
      target_directory: 'C:\\Users\\ACER\\Desktop\\AI',
      response_style: 'balanced',
      deep_mode: 'true',
      max_steps: '40',
      stream_responses: 'true',
      build_mode: 'off',
      build_max_tokens: '120000',
      build_auto_approve_edits: 'false',
      token_memory_chars: '12000',
      token_memory_relevance: 'true',
      compaction_enabled: 'true',
      compaction_threshold: '80',
      experimental_flag: 'true'
    }
    const report = buildSettingsReport({
      settings,
      database: 'C:\\data\\gemibot.db',
      scope: 'settings:c:\\workspace',
      behavior: { responseStyle: 'detailed', deepMode: false, maxSteps: 25, streaming: true }
    })

    expect(report).toContain('# Settings & Preferences')
    expect(report).not.toContain('**')
    expect(report).not.toContain('`')

    expect(report).toContain(
      '## Storage\n' +
        '- Database: C:\\data\\gemibot.db\n' +
        '- Scope: settings:c:\\workspace\n' +
        '- Backend: SQLite conversation database\n' +
        '- Saved keys: 21\n'
    )
    expect(report).toContain(
      '## Behavior\n' +
        '- Response style: detailed\n' +
        '- Deep mode: off\n' +
        '- Max steps: 25\n' +
        '- Streaming: on\n'
    )
    expect(report).toContain(
      '## Workspace\n' +
        '- Target directory: C:\\Users\\ACER\\Desktop\\AI\n' +
        '- Function suite: all\n' +
        '- Mode: build\n'
    )
    expect(report).toContain(
      '## Model & effort\n- Model: gemini-3.1-flash-lite\n- Effort level: medium\n'
    )
    expect(report).toContain(
      '## Interface\n' +
        '- UI scale: UI Scale: 11px (Compact)\n' +
        '- Theme: pure_dark\n' +
        '- Window geometry: 1240x800\n'
    )
    expect(report).toContain(
      '## Build\n' +
        '- Build mode: off\n' +
        '- Auto approve edits: off\n' +
        '- Max tokens: 120000\n'
    )
    expect(report).toContain(
      '## Token optimization\n- Memory chars: 12000\n- Memory relevance: on\n'
    )
    expect(report).toContain('## Compaction\n- Enabled: on\n- Threshold: 80\n')
    expect(report).toContain('## Other saved preferences\n- Experimental flag: on')

    expect(report).not.toContain('- UI scale: 11px\n')
    expect(report.match(/Response style/g)).toHaveLength(1)
    const order = [
      '## Storage',
      '## Behavior',
      '## Workspace',
      '## Model & effort',
      '## Interface',
      '## Build',
      '## Token optimization',
      '## Compaction',
      '## Other saved preferences'
    ].map((section) => report.indexOf(section))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('falls back to the raw scale, marks empty values and skips missing sections', () => {
    const report = buildSettingsReport({
      settings: {
        target_directory: '',
        ui_scale: '13px',
        theme: 'pure_dark'
      },
      database: '/tmp/gemibot.db',
      scope: 'settings:tmp',
      behavior: { responseStyle: 'balanced', deepMode: true, maxSteps: 40, streaming: false }
    })

    expect(report).toContain('- Target directory: (not set)')
    expect(report).toContain('- UI scale: 13px')
    expect(report).not.toContain('## Model & effort')
    expect(report).not.toContain('## Build')
    expect(report).not.toContain('## Other saved preferences')
    expect(report.match(/^## /gm)).toHaveLength(4)
  })

  it('keeps an empty settings dictionary readable', () => {
    const report = buildSettingsReport({
      settings: {},
      database: '/tmp/gemibot.db',
      scope: 'settings:empty',
      behavior: { responseStyle: 'balanced', deepMode: true, maxSteps: 40, streaming: true }
    })

    expect(report).toContain('- Saved keys: 0')
    expect(report).toContain('## Behavior')
    expect(report).not.toContain('## Workspace')
    expect(report.match(/^## /gm)).toHaveLength(2)
  })
})
