import { expect, test } from '@playwright/test'

import { launchApp } from './launch'

/**
 * Boot smoke test for the v1.0-shaped window.
 *
 * `GEMINI_API_KEY` is a placeholder: the two key guards (`src/app.py:170-174` and
 * `window_app.py:3603-3606`) only check that a key exists, and nothing in this flow calls the API.
 */
test('window boots into the v1.0 layout and the model picker opens', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()

  await expect(window.title()).resolves.toBe('GemiBot AI')
  await window.waitForSelector('.win')

  await expect(window.locator('.brand-title')).toHaveText('GemiBot AI')
  await expect(window.locator('.tb-left .caption')).toHaveText('TIMELINE')
  await expect(window.locator('.console-head')).toContainText('MIRROR CONSOLE')
  await expect(window.locator('.side-heading').first()).toBeVisible()

  // The launch banner is mirrored into the console pane, so the buffer is non-empty on frame one.
  await expect(window.locator('.console-line').first()).toBeVisible()

  await window.screenshot({ path: 'artifacts/e2e-window.png' })

  // `<Control-m>` (window_app.py:4213) opens `open_searchable_model_selector()`.
  await window.keyboard.press('Control+m')
  const picker = window.locator('.pk-box')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.pk-title')).toHaveText('Select AI Model & Reasoning Effort')
  await expect(picker.locator('.pk-title .glyph')).toHaveCount(1)
  await expect(picker.locator('.pk-pill')).toHaveCount(9)
  await expect(picker.locator('.pk-effort-btn')).toHaveCount(6)
  await expect(picker.locator('.pk-badge .glyph').first()).toBeVisible()
  expect(await picker.locator('.pk-results').innerText()).not.toMatch(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u
  )
  await window.screenshot({ path: 'artifacts/e2e-picker.png' })

  // `<Escape>` closes the overlay (`_on_escape`, model_picker.py:148).
  await window.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)

  await app.close()
})
