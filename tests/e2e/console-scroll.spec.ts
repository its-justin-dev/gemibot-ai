import { expect, test, type Locator, type Page } from '@playwright/test'

import { launchApp } from './launch'

/** The console's pill, scoped away from the chat column's own `.jump-btn`. */
const consolePill = (window: Page): Locator => window.locator('.console-pane .jump-btn')

/** Metrics of the console's scroll container, in CSS pixels. */
async function metrics(window: Page): Promise<{ top: number; client: number; full: number }> {
  return await window.evaluate(() => {
    const node = document.querySelector('.console-screen') as HTMLElement
    return { top: node.scrollTop, client: node.clientHeight, full: node.scrollHeight }
  })
}

const atBottom = (m: { top: number; client: number; full: number }): boolean =>
  m.top + m.client >= m.full - 1

/** `/help` is answered by the CLI itself, so it writes ~30 console lines without a model call. */
async function flood(window: Page): Promise<void> {
  await window.locator('.input-text').fill('/help')
  await window.locator('.input-text').press('Enter')
  await window.waitForTimeout(600)
}

/**
 * The mirror console follows new output while you are looking at the bottom, releases the pin the
 * moment you scroll back, and hands you a Jump to latest button to get the stream back.
 */
test('console pins to new output, releases on scroll-back and jumps to latest', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  // A short window keeps the console column overflowing so the scrollbar has somewhere to go.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 560)
  })
  await window.waitForSelector('.console-screen')
  await window.waitForTimeout(200)

  await flood(window)

  const flooded = await metrics(window)
  expect(flooded.full).toBeGreaterThan(flooded.client)
  expect(atBottom(flooded)).toBe(true)
  await expect(consolePill(window)).toHaveCount(0)

  await window.evaluate(() => {
    ;(document.querySelector('.console-screen') as HTMLElement).scrollTop = 0
  })
  await window.waitForTimeout(200)
  await expect(consolePill(window)).toHaveCount(1)
  expect(atBottom(await metrics(window))).toBe(false)

  // New output must not yank a reader who scrolled back down to the bottom.
  const before = await metrics(window)
  await flood(window)
  const held = await metrics(window)
  expect(held.full).toBeGreaterThan(before.full)
  expect(held.top).toBe(0)
  await window.screenshot({ path: 'artifacts/console-scroll-jump.png' })

  await consolePill(window).click()
  await window.waitForTimeout(200)
  expect(atBottom(await metrics(window))).toBe(true)
  await expect(consolePill(window)).toHaveCount(0)

  // Re-armed: the next burst is followed again.
  const armed = await metrics(window)
  await flood(window)
  expect(atBottom(await metrics(window))).toBe(true)
  expect((await metrics(window)).full).toBeGreaterThan(armed.full)

  await window.screenshot({ path: 'artifacts/console-scroll-bottom.png' })
  await app.close()
})

/**
 * The two panes are siblings in `.body`, so the console pill has to sit on the same line as the
 * chat one — anchored at the same fraction of an equally tall box, not pinned to the screen edge.
 */
test('console pill sits level with the chat pill', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 560)
  })
  await window.waitForSelector('.console-screen')
  await window.waitForTimeout(200)

  // Enough turns that both columns have real scrollback to leave.
  await flood(window)
  await flood(window)
  await flood(window)
  await flood(window)
  await flood(window)
  await window.evaluate(() => {
    ;(document.querySelector('.console-screen') as HTMLElement).scrollTop = 0
    ;(document.querySelector('.chat-container') as HTMLElement).scrollTop = 0
  })
  await window.waitForTimeout(300)

  const chatPill = window.locator('.chat-area > .jump-btn')
  await expect(chatPill).toHaveCount(1)
  await expect(consolePill(window)).toHaveCount(1)

  const pane = await window.locator('.console-pane').boundingBox()
  const chat = await window.locator('.chat-area').boundingBox()
  const pill = await consolePill(window).boundingBox()
  expect(pane).not.toBeNull()
  expect(chat).not.toBeNull()
  expect(pill).not.toBeNull()

  // Same row, so the two columns share a top edge and a height.
  expect(Math.abs(pane!.y - chat!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(pane!.height - chat!.height)).toBeLessThanOrEqual(1)

  // The two pills must land on the same line.
  const consoleCentre = pill!.y + pill!.height / 2
  const chatBox = await chatPill.boundingBox()
  const chatCentre = chatBox!.y + chatBox!.height / 2
  expect(Math.abs(consoleCentre - chatCentre)).toBeLessThanOrEqual(1)

  await window.screenshot({ path: 'artifacts/console-pill-aligned.png' })
  await app.close()
})

/** The pill is centred in the console column, so it must survive the narrowest pane too. */
test('console pill stays inside the console column on a small window', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(980, 640)
  })
  await window.waitForSelector('.console-screen')
  await window.waitForTimeout(200)

  await flood(window)
  await window.evaluate(() => {
    ;(document.querySelector('.console-screen') as HTMLElement).scrollTop = 0
  })
  await window.waitForTimeout(200)

  const pill = await consolePill(window).boundingBox()
  const pane = await window.locator('.console-pane').boundingBox()
  expect(pill).not.toBeNull()
  expect(pane).not.toBeNull()
  expect(pill!.x).toBeGreaterThanOrEqual(pane!.x)
  expect(pill!.x + pill!.width).toBeLessThanOrEqual(pane!.x + pane!.width)
  await window.screenshot({ path: 'artifacts/console-jump-narrow.png' })

  await app.close()
})
