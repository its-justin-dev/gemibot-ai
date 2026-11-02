import { expect, test, type Page } from '@playwright/test'

import { launchApp } from './launch'

const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 3

async function dragResizer(window: Page, dx: number): Promise<void> {
  const box = await window.locator('.sidebar-resizer').boundingBox()
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x + dx, y, { steps: 8 })
  await window.mouse.up()
  await window.waitForTimeout(150)
}

const sideWidth = async (window: Page): Promise<number> =>
  (await window.locator('.sidebar').boundingBox())?.width ?? 0

const chatWidth = async (window: Page): Promise<number> =>
  (await window.locator('.chat-area').boundingBox())?.width ?? 0

/**
 * The sidebar splitter and rail: the right border drags to a new width, clamps at both ends, a
 * double-click returns to the scale-driven default, and collapsing leaves only the toggle rail so
 * the chat column absorbs the whole freed width.
 */
test('sidebar width drags, clamps, resets and collapses', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 840)
  })
  await window.waitForTimeout(200)

  const original = await sideWidth(window)
  expect(original).toBeGreaterThan(190)

  await dragResizer(window, 120)
  expect(near(await sideWidth(window), original + 120)).toBe(true)

  await dragResizer(window, -3000)
  expect(near(await sideWidth(window), 190)).toBe(true)

  await dragResizer(window, 220)
  expect(near(await sideWidth(window), 410)).toBe(true)

  await dragResizer(window, 5000)
  expect(near(await sideWidth(window), 1280 - 520)).toBe(true)

  await window.locator('.sidebar-resizer').dblclick()
  await window.waitForTimeout(150)
  expect(near(await sideWidth(window), original)).toBe(true)

  // Dragging the splitter must not highlight the text it passes over.
  await dragResizer(window, 100)
  expect(await window.evaluate(() => document.getSelection()?.toString() ?? '')).toBe('')

  const pane = await sideWidth(window)
  const chat = await chatWidth(window)
  await window.locator('.sidebar-toggle').click()
  await window.waitForTimeout(150)
  const rail = await sideWidth(window)
  expect(rail).toBeLessThan(60)
  expect(near(await chatWidth(window), chat + (pane - rail))).toBe(true)
  await window.screenshot({ path: 'artifacts/sidebar-collapsed.png' })

  await window.locator('.sidebar-toggle').click()
  await window.waitForTimeout(150)
  expect(near(await sideWidth(window), pane)).toBe(true)
  expect(near(await chatWidth(window), chat)).toBe(true)

  await window.screenshot({ path: 'artifacts/sidebar-resize.png' })
  await app.close()
})
