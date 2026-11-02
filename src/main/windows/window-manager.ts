import { BrowserWindow } from 'electron'

const windows = new Map<string, BrowserWindow>()

export const windowManager = {
  register(name: string, window: BrowserWindow): void {
    windows.set(name, window)
    window.on('closed', () => windows.delete(name))
  },

  get(name: string): BrowserWindow | undefined {
    const window = windows.get(name)
    return window && !window.isDestroyed() ? window : undefined
  },

  getFirst(): BrowserWindow | undefined {
    return windows.values().next().value as BrowserWindow | undefined
  }
}
