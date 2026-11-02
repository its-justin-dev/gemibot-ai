import { expect, test } from '@playwright/test'

import { launchApp } from './launch'

/**
 * Selection contract: content text must be drag-selectable and copyable like a browser, while
 * clickable chrome (buttons, segmented controls, dropdown entries) must stay non-selectable.
 */
test('text is selectable and copyable; chrome stays unselectable', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')

  const valueOf = async (selector: string, property: string): Promise<string> =>
    await window.evaluate(
      ([selector, property]) =>
        getComputedStyle(document.querySelector(selector) as Element).getPropertyValue(property),
      [selector, property]
    )

  expect(await valueOf('.brand-title', 'user-select')).toBe('text')
  expect(await valueOf('.console-line', 'user-select')).toBe('text')
  expect(await valueOf('.mode-seg button', 'user-select')).toBe('none')
  expect(await valueOf('.font-menu', 'user-select')).toBe('none')
  expect(await valueOf('.brand-title', 'cursor')).toBe('auto')

  const box = await window.locator('.brand-title').boundingBox()
  const midY = box!.y + box!.height / 2
  await window.mouse.move(box!.x + 2, midY)
  await window.mouse.down()
  await window.mouse.move(box!.x + box!.width - 2, midY)
  await window.mouse.up()

  const selected = await window.evaluate(() => document.getSelection()?.toString() ?? '')
  expect(selected).toContain('GemiBot')

  await window.keyboard.press('Control+c')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('GemiBot')

  await window.screenshot({ path: 'artifacts/e2e-selection.png' })

  await window.keyboard.press('Control+a')
  const everything = await window.evaluate(() => document.getSelection()?.toString() ?? '')
  expect(everything).toContain('MIRROR CONSOLE')
  expect(everything.length).toBeGreaterThan(200)

  await app.close()
})
