import { dialog, BrowserWindow } from 'electron'

export const fileService = {
  async openTextFile(window: BrowserWindow): Promise<string | null> {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: 'Open a text file',
      properties: ['openFile'],
      filters: [
        { name: 'Text', extensions: ['txt', 'md', 'json', 'csv', 'log'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  }
}
