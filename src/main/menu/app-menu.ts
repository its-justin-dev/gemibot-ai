import { Menu, app, shell } from 'electron'

export function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const, label: app.name }]
      : [
          {
            label: 'File',
            submenu: [{ role: 'close' as const }]
          }
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Electron documentation',
          click: (): void => {
            void shell.openExternal('https://www.electronjs.org/docs')
          }
        },
        {
          label: 'electron-vite guide',
          click: (): void => {
            void shell.openExternal('https://electron-vite.org')
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
