import { Menu } from 'electron'
import type { BrowserWindow } from 'electron'

export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags
    const template: Electron.MenuItemConstructorOptions[] = [
      ...(canCut ? [{ role: 'cut' as const }] : []),
      ...(canCopy ? [{ role: 'copy' as const }] : []),
      ...(canPaste ? [{ role: 'paste' as const }] : []),
      ...(canSelectAll ? [{ role: 'selectAll' as const }] : [])
    ]
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
