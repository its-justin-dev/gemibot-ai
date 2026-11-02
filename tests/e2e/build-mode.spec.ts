import { expect, test, type Locator, type Page } from '@playwright/test'

import { launchApp } from './launch'

type Mode = 'auto' | 'on' | 'off'

const chip = (window: Page): Locator => window.locator('.build-mode-btn')

const MODE_TEXT: Record<Mode, string> = { auto: 'Auto', on: 'On', off: 'Off' }
const MODE_EVENT: Record<Mode, string> = { auto: 'AUTO', on: 'ON', off: 'OFF' }

async function expectMode(window: Page, mode: Mode): Promise<void> {
  await expect(chip(window)).toHaveClass(new RegExp(`\\bmode-${mode}\\b`))
  await expect(chip(window)).toContainText(MODE_TEXT[mode])
}

async function runCommand(window: Page, command: string): Promise<void> {
  await window.locator('.input-text').fill(command)
  await window.locator('.input-text').press('Enter')
}

/**
 * The Build toggle is the only entry point that is always on screen. `/buildmode` is handled by
 * the local command path, so these turns never call the model and need no real API key.
 */
test('Build toggle cycles modes, follows /buildmode and survives a renderer reload', async () => {
  const app = await launchApp({ env: { GEMINI_API_KEY: 'parity-test-placeholder' } })
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  await expect(chip(window)).toBeVisible()

  await expectMode(window, 'auto')
  await chip(window).click()
  await expectMode(window, 'on')
  await expect(window.locator('.row-pill').last()).toContainText('Build mode: ON')

  await chip(window).click()
  await expectMode(window, 'off')
  await expect(window.locator('.row-pill').last()).toContainText('Build mode: OFF')

  await chip(window).click()
  await expectMode(window, 'auto')
  await expect(window.locator('.row-pill').last()).toContainText('Build mode: AUTO')

  // The command path updates the same chip, so keyboard users are never out of sync.
  await runCommand(window, '/buildmode on')
  await expectMode(window, 'on')
  await runCommand(window, '/buildmode off')
  await expectMode(window, 'off')
  await runCommand(window, '/buildmode auto')
  await expectMode(window, 'auto')

  // The mode lives in settings, not renderer state: a reload must restore it from SQLite.
  await chip(window).click()
  await expectMode(window, 'on')
  await window.reload()
  await window.waitForSelector('.win')
  await expect(chip(window)).toBeVisible()
  await expectMode(window, 'on')

  await chip(window).click()
  await chip(window).click()
  await expectMode(window, 'auto')

  // The chip stays inside the top bar at the narrowest supported window.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(980, 640)
  })
  await window.waitForTimeout(150)
  const nav = await window.locator('.top-nav').boundingBox()
  const button = await chip(window).boundingBox()
  expect(nav).not.toBeNull()
  expect(button).not.toBeNull()
  expect(button!.x).toBeGreaterThanOrEqual(nav!.x)
  expect(button!.x + button!.width).toBeLessThanOrEqual(nav!.x + nav!.width)
  const overflow = await window.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth)

  await window.screenshot({ path: 'artifacts/e2e-build-mode.png' })
  await app.close()
})
