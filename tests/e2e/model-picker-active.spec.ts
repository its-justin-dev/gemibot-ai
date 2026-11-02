import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { launchApp } from './launch'

const EFFORT_LABELS: Record<string, string> = {
  turbo: 'Turbo',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra_high: 'Extra High',
  saving: 'Saving'
}

/** The id of the card the picker marks as the live model. */
async function activeCardId(window: Page): Promise<string | null> {
  const cards = window.locator('.pk-card')
  const count = await cards.count()
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index)
    if ((await card.locator('.pk-active-tag').count()) > 0)
      return (await card.locator('.pk-id').innerText()).trim()
  }
  return null
}

async function activeEffortLabel(window: Page): Promise<string> {
  const button = window.locator('.pk-effort-btn.is-active')
  return (await button.count()) > 0 ? (await button.innerText()).trim() : ''
}

async function cardIds(window: Page): Promise<string[]> {
  return (await window.locator('.pk-card .pk-id').allInnerTexts()).map((id) => id.trim())
}

async function openPicker(window: Page): Promise<void> {
  await window.keyboard.press('Control+m')
  await window.waitForSelector('.pk-box')
}

async function closePicker(window: Page): Promise<void> {
  await window.keyboard.press('Escape')
  await expect(window.locator('.pk-box')).toHaveCount(0)
}

/**
 * The picker reads `modelController.currentModel` / `currentEffort`, which used to drift behind the
 * model and effort actually in force whenever they were changed from inside the picker itself.
 *
 * Settings now live in the conversation database keyed by the target folder, so the app runs
 * against a throwaway project directory: the developer's own preferences are never touched.
 */
test('model and effort pickers open on the values the app is actually using', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'gemibot-picker-'))

  try {
    const app = await launchApp({ cwd: sandbox })
    const window = await app.firstWindow()
    await window.waitForSelector('.win')

    await openPicker(window)
    const initialModel = await activeCardId(window)
    expect(initialModel).not.toBeNull()
    expect(await activeEffortLabel(window)).toContain(EFFORT_LABELS.medium)

    const others = (await cardIds(window)).filter((id) => id !== initialModel)
    expect(others.length).toBeGreaterThan(0)
    const picked = others[0]

    await window
      .locator('.pk-card', { has: window.locator('.pk-id', { hasText: picked }) })
      .first()
      .click()
    await expect(window.locator('.pk-box')).toHaveCount(0)

    await openPicker(window)
    expect(await activeCardId(window)).toBe(picked)

    // Effort buttons sit in Turbo, Low, Medium, High, Extra High, Saving order.
    const high = window.locator('.pk-effort-btn').nth(3)
    const highLabel = (await high.innerText()).trim()
    await high.click()
    await closePicker(window)

    await openPicker(window)
    expect(await activeEffortLabel(window)).toBe(highLabel)
    expect(await activeCardId(window)).toBe(picked)

    // Saving is the button v2.0 appends; it must select like the others and its longer
    // description must still fit the picker without clipping.
    const saving = window.locator('.pk-effort-btn').nth(5)
    expect((await saving.innerText()).trim()).toContain(EFFORT_LABELS.saving)
    await saving.click()
    await expect(saving).toHaveClass(/is-active/)
    const desc = window.locator('.pk-effort-desc')
    expect(await desc.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await closePicker(window)

    await openPicker(window)
    expect(await activeEffortLabel(window)).toContain(EFFORT_LABELS.saving)
    await window.screenshot({ path: 'artifacts/model-picker-active.png' })
    await closePicker(window)
    await app.close()
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
