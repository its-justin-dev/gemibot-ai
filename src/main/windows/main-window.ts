import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { attachContextMenu } from '../menu/context-menu'
import { windowManager } from './window-manager'

export const MAIN_WINDOW = 'main'

export function createMainWindow(): BrowserWindow {
  const existing = windowManager.get(MAIN_WINDOW)
  if (existing) {
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'GemiBot AI',
    backgroundColor: '#121314',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  windowManager.register(MAIN_WINDOW, win)

  win.on('ready-to-show', () => win.show())

  attachContextMenu(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const appUrl = (): string => win.webContents.getURL()
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl()) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (url !== appUrl()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
