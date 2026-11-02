import { readFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { main, type BenchmarkReport } from '../../tools/build-benchmark'

describe('Build mode benchmark', () => {
  it('runs all four offline scenarios and records the metrics', async () => {
    await main(['--json', 'benchmarks/build-benchmark-latest.json'])
    const raw = await readFile(join(process.cwd(), 'benchmarks', 'build-benchmark-latest.json'), 'utf8')
    const report = JSON.parse(raw) as BenchmarkReport

    expect(report.mode).toBe('fake')
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'todo-web',
      'rest-auth',
      'inventory-fullstack',
      'vague-request'
    ])
    expect(report.totals.scenarios).toBe(4)
    expect(report.totals.succeeded).toBe(4)
    expect(report.totals.filesCreated).toBeGreaterThan(0)
    expect(report.totals.repairs).toBeGreaterThan(0)
    expect(report.totals.taskRetries).toBeGreaterThan(0)

    for (const scenario of report.scenarios) {
      expect(scenario.success).toBe(true)
      expect(scenario.filesCreated).toBeGreaterThan(0)
      expect(scenario.tokens.input).toBeGreaterThan(0)
      expect(scenario.tokens.output).toBeGreaterThan(0)
      expect(scenario.normalModeEstimate.total).toBeGreaterThan(0)
      expect(scenario.durationMs).toBeGreaterThanOrEqual(0)
    }

    const inventory = report.scenarios.find((scenario) => scenario.id === 'inventory-fullstack')
    expect(inventory).toMatchObject({
      repairs: 1,
      verifications: 5,
      status: 'success'
    })
    expect(inventory?.builds).toBeGreaterThanOrEqual(5)

    const vague = report.scenarios.find((scenario) => scenario.id === 'vague-request')
    expect(vague?.notes.join('\n')).toContain('assumption(s)')
  })
})
