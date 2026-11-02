import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { launchApp } from './launch'

/**
 * The active conversation can disappear while its id is still current. Every save then fails
 * with `FOREIGN KEY constraint failed` and the timeline shows "This chat is not being saved."
 * The delete path used to leave exactly that state: deleting the last conversation threw before
 * the sidebar was refreshed, and reopening the stale item adopted a row that no longer existed.
 *
 * `GEMINI_API_KEY` is a placeholder, so the turn itself fails; conversation and row writes happen
 * before the model request, which is all this test needs.
 */
test('deleting the last conversation empties the sidebar and the next send is saved', async () => {
  // A workspace without `.gemibot/session.json`: the startup import would otherwise seed a
  // conversation and this test would not start from an empty store.
  const workspace = mkdtempSync(join(tmpdir(), 'gemibot-e2e-recovery-'))
  const app = await launchApp({ cwd: workspace })
  const window = await app.firstWindow()
  await window.waitForSelector('.win')

  const sendPrompt = async (text: string): Promise<void> => {
    await window.locator('.input-text').fill(text)
    await window.locator('.send-btn').click()
    await expect(window.locator('.conversation-item')).toHaveCount(1)
  }

  await sendPrompt('first conversation')
  await expect(window.locator('.conversation-item').first()).toContainText('first conversation')
  // Let the placeholder-key request settle so Delete is not rejected as busy.
  await window.waitForTimeout(4000)

  await window.locator('.conversation-btn', { hasText: 'Delete' }).click()
  await window.locator('.conversation-btn', { hasText: 'Confirm delete' }).click()

  await expect(window.locator('.conversation-item')).toHaveCount(0)
  await expect(window.locator('.conversation-empty')).toHaveText('No saved conversations yet')
  await expect(window.locator('.conversation-actions')).toHaveCount(0)

  await sendPrompt('second conversation')
  await expect(window.locator('.conversation-item')).toContainText('second conversation')
  await expect(window.locator('.row-error', { hasText: 'Database error' })).toHaveCount(0)
  await expect(window.locator('.row-error', { hasText: 'FOREIGN KEY' })).toHaveCount(0)

  await app.close()
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
})
