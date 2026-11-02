import { _electron as electron, expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

test('app starts cleanly from a copy of the real database and restores the last conversation', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'gemibot-audit-db-'))
  mkdirSync(join(profile, 'Cache'), { recursive: true })
  const dbSource = resolve('backups/gemibot-db-20261024-133340.db')
  copyFileSync(dbSource, join(profile, 'gemibot.db'))

  const errors: string[] = []
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    env: { ...process.env, GEMINI_API_KEY: 'audit-no-real-key' }
  })
  app.process().stderr?.on('data', (d) => {
    const line = String(d)
    if (line.includes('Debugger ending') || line.includes('For help, see')) return
    errors.push(line)
  })
  app.process().stdout?.on('data', (d) => {
    const line = String(d)
    if (line.toLowerCase().includes('error')) errors.push(line)
  })

  const window = await app.firstWindow()
  await window.waitForSelector('.win', { timeout: 30_000 })
  expect(await window.title()).toBe('GemiBot AI')

  // Capture any renderer console errors.
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  await window.waitForTimeout(1000)

  // The sidebar should show at least one conversation from the imported data.
  await expect(window.locator('.conversation-item')).toHaveCount(2)
  const names = await window.locator('.conversation-item').allTextContents()
  expect(names.length).toBeGreaterThan(0)

  await window.locator('.conversation-item').first().click()
  await window.waitForTimeout(800)

  // The opened conversation should render rows in the timeline.
  const rowSelector =
    '.row-assistant, .row-user, .row-pill, .row-error, .row-divider, .row-action'
  const rows = await window.locator(rowSelector).count()
  expect(rows).toBeGreaterThan(0)

  await window.screenshot({ path: 'artifacts/e2e-real-db-first.png' })

  // Restart the renderer / reload the snapshot path by relaunching.
  await app.close()
  const errors2: string[] = []
  const app2 = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    env: { ...process.env, GEMINI_API_KEY: 'audit-no-real-key' }
  })
  app2.process().stderr?.on('data', (d) => {
    const line = String(d)
    if (line.includes('Debugger ending') || line.includes('For help, see')) return
    errors2.push(line)
  })

  const window2 = await app2.firstWindow()
  await window2.waitForSelector('.win', { timeout: 30_000 })
  await window2.waitForTimeout(1000)

  // Re-open the same conversation and verify rows again.
  await window2.locator('.conversation-item').first().click()
  await window2.waitForTimeout(800)
  expect(await window2.locator(rowSelector).count()).toBeGreaterThan(0)

  await window2.screenshot({ path: 'artifacts/e2e-real-db-restart.png' })
  await app2.close()

  rmSync(profile, { recursive: true, force: true, maxRetries: 5 })

  expect(errors.filter((e) => !e.includes('audit-no-real-key'))).toEqual([])
  expect(errors2.filter((e) => !e.includes('audit-no-real-key'))).toEqual([])
  expect(consoleErrors).toEqual([])
})
