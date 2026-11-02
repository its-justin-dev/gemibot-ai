import { expect, test } from '@playwright/test'

import { launchApp } from './launch'

const CLEAR = 'Clear chat & memory (/clear)'
const MEMORY = 'View memory history (/memory)'

/**
 * The quick action is destructive: it must explain what survives, refuse a cancel silently, and
 * leave the SQLite memory document back at its header so `/memory` reports zero interactions.
 */
test('clear chat & memory confirms, archives the chat and resets the SQLite memory log', async () => {
  const app = await launchApp()
  const window = await app.firstWindow()
  await window.waitForSelector('.win')

  const openQuickAction = async (label: string): Promise<void> => {
    await window.getByRole('combobox', { name: 'Quick actions' }).click()
    await window.locator('.dropdown-menu .entry', { hasText: label }).click()
  }

  const openClear = async (): Promise<void> => {
    await openQuickAction(CLEAR)
    await expect(window.locator('.dlg-clear')).toBeVisible()
  }

  await openClear()
  const detail = window.locator('.dlg-detail-clear')
  await expect(detail).toContainText('stays archived in the database')
  await expect(detail).toContainText('can still be reopened or exported')
  await expect(detail).toContainText('cannot be undone')

  const fit = await window.locator('.dlg-clear').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      inside:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
    }
  })
  expect(fit.inside).toBe(true)

  // Cancel closes the dialog without clearing anything.
  await window.locator('.dlg-cancel').click()
  await expect(window.locator('.dlg-clear')).toHaveCount(0)

  await openClear()
  await window.locator('.dlg-confirm-clear').click()
  await expect(window.locator('.dlg-clear')).toHaveCount(0)
  await expect(window.locator('.row-pill').last()).toContainText(
    'Active chat and conversation memory cleared.'
  )

  await openQuickAction(MEMORY)
  const memory = window.locator('.row-assistant').last()
  await expect(memory).toContainText('Memory History')
  await expect(memory).toContainText(/Logged Interactions:\*{0,2} 0/)

  await app.close()
})
