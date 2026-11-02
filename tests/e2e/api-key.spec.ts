import { expect, test, type Page } from '@playwright/test'

import { launchApp } from './launch'

const PLACEHOLDER = 'parity-test-placeholder'
const TYPED = 'AQ.Ab8RN6SimulatedKeyValue0000000000000000000000'
const WRONG_FORMAT = 'AIzaSyNotAGeminiFormatKey0000000000000000'
const PREFIX_ERROR = 'That is not a Google Gemini API key - Gemini keys start with AQ.Ab8RN6.'

const maskOf = (key: string): string =>
  `${key.slice(0, 4)}${'*'.repeat(Math.min(24, key.length - 8))}${key.slice(-4)}`

async function badge(window: Page): Promise<string> {
  return (await window.locator('.dlg-badge').textContent()) ?? ''
}

/** The detail panel must show all of its rows instead of hiding them behind a scrollbar. */
async function detailOverflow(window: Page): Promise<number> {
  const box = await window.locator('.key-detail').evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight
  }))
  return box.scroll - box.client
}

/**
 * The API Key modal: prefilled with the live key, hidden until the eye is clicked, then gated
 * behind a confirmation. The confirmation's "Yes, save & use" is deliberately never clicked -
 * it would rewrite the developer's real .env, and the file edit itself is covered by
 * tests/unit/api-key.test.ts.
 */
test('API key modal masks, reveals, validates and confirms', async () => {
  const app = await launchApp({ env: { GEMINI_API_KEY: PLACEHOLDER } })
  const window = await app.firstWindow()
  await window.waitForSelector('.win')

  const labels = await window.locator('.tb-left .tb-btn').allTextContents()
  expect(labels.map((label) => label.trim())).toEqual([
    'Expand All',
    'Collapse All',
    'Export',
    '🗜️ Compact',
    'API Key'
  ])

  await window.locator('.tb-btn.api-key').click()
  await window.waitForSelector('.dlg-apikey')

  const entry = window.locator('.key-entry')
  await expect.poll(() => entry.inputValue()).toBe(PLACEHOLDER)
  expect(await entry.getAttribute('type')).toBe('password')
  expect(await badge(window)).toBe(maskOf(PLACEHOLDER))

  const rule = (await window.locator('.dlg-msg-rule').textContent()) ?? ''
  expect(rule).toContain('only a Google Gemini AI API key is accepted')
  expect(rule).toContain('AQ.Ab8RN6')

  await window.locator('.key-eye').click()
  expect(await entry.getAttribute('type')).toBe('text')
  await window.locator('.key-eye').click()
  expect(await entry.getAttribute('type')).toBe('password')

  expect(await detailOverflow(window)).toBeLessThanOrEqual(1)
  expect(await window.locator('.key-detail').textContent()).toContain('AQ.Ab8RN6')

  await entry.fill('')
  await window.locator('.dlg-save').click()
  expect(await window.locator('.key-err').textContent()).toBe('API key cannot be empty.')
  expect(await window.locator('.dlg-confirm-key').count()).toBe(0)

  // Only a Google Gemini key may reach .env, and it is refused before the confirmation appears.
  await entry.fill(WRONG_FORMAT)
  await window.locator('.dlg-save').click()
  expect(await window.locator('.key-err').textContent()).toBe(PREFIX_ERROR)
  expect(await window.locator('.dlg-confirm-key').count()).toBe(0)
  await window.screenshot({ path: 'artifacts/api-key-validation.png' })

  await entry.fill(TYPED)
  await window.locator('.dlg-save').click()
  await window.waitForSelector('.dlg-confirm-key')
  expect(await badge(window)).toBe(maskOf(TYPED))
  expect(await badge(window)).not.toContain('Simulated')
  expect(await detailOverflow(window)).toBeLessThanOrEqual(1)

  await window.locator('.dlg-cancel').click()
  expect(await entry.inputValue()).toBe(TYPED)

  // Enter in the field walks the same path as the Save button.
  await entry.press('Enter')
  await window.waitForSelector('.dlg-confirm-key')

  await window.locator('.dlg-cancel').click()
  await window.locator('.dlg-backdrop .dlg-cancel').click()
  await window.waitForSelector('.dlg-apikey', { state: 'detached' })

  // Reopening asks the main process again, so the field never keeps an abandoned draft.
  await window.locator('.tb-btn.api-key').click()
  await window.waitForSelector('.dlg-apikey')
  await expect.poll(() => window.locator('.key-entry').inputValue()).toBe(PLACEHOLDER)
  await window.screenshot({ path: 'artifacts/api-key-dialog.png' })
  await app.close()
})
