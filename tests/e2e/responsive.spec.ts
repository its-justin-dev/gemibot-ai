import { expect, test } from '@playwright/test'

import { launchApp } from './launch'

/**
 * Responsiveness probe: the shell must keep all three columns and the chrome visible at the
 * smallest supported window (980x640) and at the largest UI scale (18px / 1.35).
 */
test('layout stays inside the viewport across window sizes and UI scales', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')

  const setSize = async (width: number, height: number): Promise<void> => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.setContentSize(size[0], size[1])
      },
      [width, height]
    )
    await window.waitForTimeout(150)
  }

  const setScale = async (label: string): Promise<void> => {
    await window.locator('.font-menu').click()
    await window.locator('.dropdown-menu .entry', { hasText: label }).click()
    await window.waitForTimeout(150)
  }

  const overflow = async (): Promise<{ scrollWidth: number; innerWidth: number }> =>
    window.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }))

  for (const [width, height] of [
    [980, 640],
    [1280, 840],
    [1920, 1080]
  ]) {
    for (const label of [
      'UI Scale: 11px (Compact)',
      'UI Scale: 13px (Normal)',
      'UI Scale: 18px (Huge)'
    ]) {
      await setSize(width, height)
      await setScale(label)
      const { scrollWidth, innerWidth } = await overflow()
      expect(scrollWidth, `${width}x${height} @ ${label}`).toBeLessThanOrEqual(innerWidth)
      const box = await window.locator('.win').boundingBox()
      expect(box?.height ?? 0, `${width}x${height} @ ${label}`).toBeLessThanOrEqual(height)
      await window.screenshot({
        path: `artifacts/responsive-${width}x${height}-${label.replace(/\D+/g, '-')}.png`
      })
    }
  }

  // Pills render their icon through the Lucide layer instead of an emoji glyph.
  const pill = window.locator('.row-pill').last()
  await expect(pill.locator('.glyph').first()).toBeVisible()
  expect(await pill.innerText()).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u)

  // The picker and review overlays are capped to the viewport when the scale is at its largest.
  await setSize(980, 640)
  await setScale('UI Scale: 18px (Huge)')
  await window.keyboard.press('Control+m')
  const picker = window.locator('.pk-box')
  await expect(picker).toBeVisible()
  const pickerBox = await picker.boundingBox()
  expect(pickerBox?.width ?? 0).toBeLessThanOrEqual(980 - 32)
  expect(pickerBox?.height ?? 0).toBeLessThanOrEqual(640 - 32)
  await window.screenshot({ path: 'artifacts/responsive-picker-980x640-huge.png' })

  // The scale is persisted in the conversation database; leave the preference as it was found.
  await window.keyboard.press('Escape')
  await setScale('UI Scale: 13px (Normal)')

  await app.close()
})
