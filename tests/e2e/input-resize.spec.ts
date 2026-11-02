import { expect, test, type Page } from '@playwright/test'

import { launchApp } from './launch'

const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 3

async function dragHandle(window: Page, dy: number): Promise<void> {
  const box = await window.locator('.input-resizer').boundingBox()
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x, y + dy, { steps: 8 })
  await window.mouse.up()
  await window.waitForTimeout(150)
}

const inputHeight = async (window: Page): Promise<number> =>
  (await window.locator('.input-text').boundingBox())?.height ?? 0

const bottom = async (window: Page, selector: string): Promise<number> => {
  const box = await window.locator(selector).boundingBox()
  return (box?.y ?? 0) + (box?.height ?? 0)
}

async function setScale(window: Page, label: string): Promise<void> {
  await window.locator('.font-menu').click()
  await window.locator('.dropdown-menu .entry', { hasText: label }).click()
  await window.waitForTimeout(150)
}

/**
 * The chat input splitter: the top border of the dock drags up and down, clamps at both ends,
 * and a double-click puts the height back on the scale-driven default. The lower clamp is the
 * Send + Stop stack, so the textarea bottom never rises above the Stop button.
 */
test('chat input height drags, clamps and resets', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 840)
  })
  await window.waitForTimeout(200)

  const original = await inputHeight(window)
  expect(original).toBeGreaterThan(40)

  await dragHandle(window, -120)
  expect(near(await inputHeight(window), original + 120)).toBe(true)

  await dragHandle(window, 3000)
  // The floor is the Send + gap + Stop stack, so the textarea never stops level with Send alone.
  expect(near(await inputHeight(window), 60)).toBe(true)
  expect(
    Math.abs((await bottom(window, '.input-text')) - (await bottom(window, '.stop-btn')))
  ).toBeLessThanOrEqual(1)
  await window.screenshot({ path: 'artifacts/input-resize-min.png' })

  await dragHandle(window, -120)
  expect(near(await inputHeight(window), 180)).toBe(true)

  await dragHandle(window, -5000)
  expect(near(await inputHeight(window), 840 - 380)).toBe(true)

  await window.locator('.input-resizer').dblclick()
  await window.waitForTimeout(150)
  expect(near(await inputHeight(window), original)).toBe(true)

  // The textarea keeps working at any height, and a drag never selects the text under it.
  await window.locator('.input-text').fill('type this bro')
  await dragHandle(window, -60)
  expect(await window.locator('.input-text').inputValue()).toBe('type this bro')
  expect(await window.evaluate(() => document.getSelection()?.toString() ?? '')).toBe('')

  await window.screenshot({ path: 'artifacts/input-resize.png' })

  // The floor is measured in scale units, so it keeps spanning both buttons at the largest scale.
  await setScale(window, 'UI Scale: 18px (Huge)')
  await dragHandle(window, 3000)
  expect(near(await inputHeight(window), 60 * 1.35)).toBe(true)
  expect(
    Math.abs((await bottom(window, '.input-text')) - (await bottom(window, '.stop-btn')))
  ).toBeLessThanOrEqual(1)
  await window.screenshot({ path: 'artifacts/input-resize-min-huge.png' })

  // The scale is persisted in the conversation database; leave the preference as it was found.
  await setScale(window, 'UI Scale: 13px (Normal)')

  await app.close()
})
