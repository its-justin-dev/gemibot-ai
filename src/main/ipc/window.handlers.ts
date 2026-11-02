import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import { extname, join, resolve } from 'path'
import { IPC } from '../../shared/constants/ipc-channels'
import type { FileDiffDict } from '../../shared/models/file-diff'
import { nowStrftime } from '../../shared/utils/strftime'
import type { ApiKeyInfo, ApiKeyResult } from '../../shared/types/api-key'
import { apiKeyInfo, saveApiKey as saveApiKeyFile } from '../services/api-key.service'
import type {
  TimelineSaveTarget,
  WindowAction,
  WindowAnswer,
  WindowCommand,
  WindowEvent,
  WindowRequest,
  WindowSnapshot
} from '../../shared/types/window'
import type { WindowRuntime, WindowTransport } from '../services/window-runtime.service'
import { out } from '../utils/console-out'

type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
type RequestKind = WithoutId<WindowRequest>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || isText(value)
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value)
}

const WINDOW_ACTIONS = new Set<WindowAction>([
  'todos',
  'settings',
  'undo',
  'revert',
  'memory',
  'pip',
  'usage',
  'token',
  'clear'
])

/** Runtime gate for every renderer command: unknown shapes are dropped, never dispatched. */
export function isWindowCommand(value: unknown): value is WindowCommand {
  if (!isRecord(value) || typeof value.cmd !== 'string') return false
  switch (value.cmd) {
    case 'send':
    case 'copy':
    case 'queue-add':
      return isText(value['text'])
    case 'action':
      return typeof value['name'] === 'string' && WINDOW_ACTIONS.has(value['name'] as WindowAction)
    case 'accept-file':
    case 'reject-file':
    case 'target-apply':
      return isNonEmptyText(value['path'])
    case 'mode-change':
      return isText(value['value'])
    case 'function-change':
      return isText(value['display'])
    case 'model-change':
      return isText(value['display'])
    case 'model-selected':
      return isText(value['modelId']) && isText(value['display'])
    case 'effort-selected':
      return isText(value['value'])
    case 'font-scale':
      return isText(value['label'])
    case 'copy-path':
    case 'open-file':
      return isNonEmptyText(value['rel'])
    case 'queue-process':
      return isOptionalText(value['text'])
    case 'queue-delete':
    case 'queue-send-now':
      return isIndex(value['index'])
    case 'queue-edit':
      return isIndex(value['index']) && isText(value['text'])
    case 'multi-agent-stop':
      return isOptionalNumber(value['subAgentIdx'])
    case 'multi-agent-enable':
      return typeof value['enabled'] === 'boolean'
    case 'multi-agent-max':
      return isNumber(value['max'])
    case 'multi-agent-sub-agent-update':
      return (
        isNumber(value['subAgentIdx']) &&
        typeof value['status'] === 'string' &&
        isOptionalText(value['result']) &&
        isOptionalText(value['error']) &&
        isOptionalText(value['model'])
      )
    case 'multi-agent-complete':
      return value['results'] === undefined || isRecord(value['results'])
    case 'conversation-open':
    case 'conversation-delete':
      return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200
    case 'conversation-rename':
      return (
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.title === 'string' &&
        value.title.trim().length > 0 &&
        value.title.length <= 200
      )
    case 'conversation-export':
      return (
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        (value.format === 'md' || value.format === 'json')
      )
    case 'edit-user':
      return (
        typeof value.text === 'string' &&
        typeof value.rowId === 'number' &&
        Number.isFinite(value.rowId) &&
        (value.cpIdx === null || typeof value.cpIdx === 'number') &&
        (value.dbId === undefined || typeof value.dbId === 'number')
      )
    case 'build-mode':
      return value.mode === 'auto' || value.mode === 'on' || value.mode === 'off'
    case 'build-revise':
      return (
        typeof value.text === 'string' &&
        value.text.trim().length > 0 &&
        value.text.length <= 4_000
      )
    case 'build-setting':
      return (
        typeof value.key === 'string' &&
        value.key.length > 0 &&
        value.key.length <= 64 &&
        typeof value.value === 'string' &&
        value.value.length <= 200
      )
    case 'export-timeline':
      return isNonEmptyText(value.path) && isText(value.content)
    case 'multi-agent-start':
      return isText(value['orchestratorModel']) && isNumber(value['totalSubTasks'])
    case 'compact':
    case 'stop':
    case 'accept-all':
    case 'reject-all':
    case 'review-open':
    case 'review-panel-close':
    case 'target-browse':
    case 'target-clear':
    case 'model-picker':
    case 'load-older':
    case 'conversation-new':
    case 'open-data-folder':
    case 'build-pause':
    case 'build-resume':
    case 'build-stop':
    case 'build-approve':
    case 'build-docs':
    case 'build-docs-close':
      return true
  }
  return false
}

export class WindowBridge implements WindowTransport {
  private win: BrowserWindow | null = null
  private ready = false
  private readonly backlog: WindowEvent[] = []
  private nextId = 1
  private readonly pending = new Map<number, (answer: WindowAnswer) => void>()
  private pendingPermission: number | null = null
  private saveTarget: string | null = null
  /** Permission prompts are serialized so a second request cannot orphan the first. */
  private permissionChain: Promise<void> = Promise.resolve()
  private permissionEpoch = 0
  private readonly runtimeReady: Promise<WindowRuntime>
  private readonly resolveRuntime: (runtime: WindowRuntime) => void
  private runtime: WindowRuntime | null = null

  constructor() {
    let resolve!: (runtime: WindowRuntime) => void
    this.runtimeReady = new Promise((r) => {
      resolve = r
    })
    this.resolveRuntime = resolve
  }

  attachWindow(win: BrowserWindow): void {
    this.win = win
    // A reopened window starts before its renderer has asked for the first snapshot.  Anything
    // sent to the old renderer is not recoverable, and dialogs it was showing can never answer.
    this.ready = false
    for (const resolve of this.pending.values()) resolve(null)
    this.pending.clear()
    this.pendingPermission = null
  }

  bindRuntime(runtime: WindowRuntime): void {
    this.runtime = runtime
    this.resolveRuntime(runtime)
  }

  emit(event: WindowEvent): void {
    if (!this.ready || this.win === null || this.win.isDestroyed()) {
      this.backlog.push(event)
      return
    }
    this.win.webContents.send(IPC.WINDOW.EVENT, event)
  }

  private async request(kind: RequestKind): Promise<WindowAnswer> {
    await this.runtimeReady
    if (this.win === null || this.win.isDestroyed()) return null
    const id = this.nextId++
    const full = { ...kind, id } as WindowRequest
    if (full.kind === 'permission') this.pendingPermission = id
    return await new Promise<WindowAnswer>((resolve) => {
      this.pending.set(id, resolve)
      this.win?.webContents.send(IPC.WINDOW.REQUEST, full)
    })
  }

  async readLine(prompt: string): Promise<string | null> {
    const answer = await this.request({ kind: 'read-line', prompt })
    return typeof answer === 'string' ? answer : null
  }

  async permission(tool: string, detail: string): Promise<boolean | 'always'> {
    const epoch = this.permissionEpoch
    let result: boolean | 'always' = false
    const task = this.permissionChain
      .then(async () => {
        // A stop that landed while this request waited means its answer no longer matters.
        if (this.permissionEpoch !== epoch) return
        const answer = await this.request({ kind: 'permission', tool, detail })
        this.pendingPermission = null
        result = answer === 'always' ? 'always' : Boolean(answer)
      })
      .catch(() => {})
    this.permissionChain = task
    await task
    return result
  }

  cancelPermission(): void {
    this.permissionEpoch += 1
    this.emit({ kind: 'cancel-permission' })
    if (this.pendingPermission === null) return
    const id = this.pendingPermission
    this.pendingPermission = null
    this.pending.get(id)?.(false)
    this.pending.delete(id)
  }

  async confirmClear(): Promise<boolean> {
    return Boolean(await this.request({ kind: 'confirm-clear' }))
  }

  async browseDirectory(defaultPath: string, title: string): Promise<string> {
    if (!this.win) return ''
    const result = await dialog.showOpenDialog(this.win, {
      defaultPath,
      title,
      properties: ['openDirectory']
    })
    if (result.canceled) return ''
    return result.filePaths[0] ?? ''
  }

  writeClipboard(text: string): void {
    clipboard.writeText(text)
  }

  async openPath(path: string): Promise<string> {
    return await shell.openPath(path)
  }

  quit(): void {
    this.win?.close()
  }

  getApiKey(): ApiKeyInfo {
    return apiKeyInfo()
  }

  async saveApiKey(key: string): Promise<ApiKeyResult> {
    return this.runtime === null ? await saveApiKeyFile(key) : await this.runtime.applyApiKey(key)
  }

  /** Save dialog for a conversation export; the runtime writes the file itself. */
  async saveConversationFile(defaultName: string, format: 'md' | 'json'): Promise<string | null> {
    if (!this.win) return null
    const result = await dialog.showSaveDialog(this.win, {
      defaultPath: join(app.getPath('documents'), defaultName),
      title: `Export Conversation (${format.toUpperCase()})`,
      filters:
        format === 'json'
          ? [
              { name: 'JSON files', extensions: ['json'] },
              { name: 'All files', extensions: ['*'] }
            ]
          : [
              { name: 'Markdown files', extensions: ['md'] },
              { name: 'All files', extensions: ['*'] }
            ]
    })
    if (result.canceled || !result.filePath) return null
    const extension = extname(result.filePath) === '' ? `.${format}` : ''
    return `${result.filePath}${extension}`
  }

  async openDataFolder(): Promise<void> {
    await shell.openPath(app.getPath('userData'))
  }

  private async takeSnapshot(): Promise<WindowSnapshot> {
    const runtime = await this.runtimeReady
    const snapshot = runtime.snapshot()
    this.ready = true
    for (const event of this.backlog.splice(0, this.backlog.length)) {
      this.emit(event)
    }
    return snapshot
  }

  /** Only the window this bridge owns may drive agent state or read the API key. */
  private trusted(event: { sender: unknown }): boolean {
    return this.win !== null && !this.win.isDestroyed() && event.sender === this.win.webContents
  }

  register(): void {
    ipcMain.handle(IPC.WINDOW.SNAPSHOT, (event) => {
      if (!this.trusted(event)) throw new Error('Untrusted IPC sender')
      return this.takeSnapshot()
    })
    ipcMain.on(IPC.WINDOW.REPLY, (event, answer: unknown) => {
      if (!this.trusted(event)) return
      if (!isRecord(answer)) return
      const id = answer['id']
      const value = answer['answer']
      if (!isNumber(id)) return
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean') return
      const resolve = this.pending.get(id)
      this.pending.delete(id)
      resolve?.(value)
    })
    ipcMain.on(IPC.WINDOW.COMMAND, (event, cmd: unknown) => {
      if (!this.trusted(event)) return
      if (!isWindowCommand(cmd)) {
        out('\n  Window command blocked: malformed payload.\n')
        return
      }
      if (cmd.cmd === 'export-timeline' && !this.consumeSaveTarget(cmd.path)) {
        out('\n  Timeline export blocked: the path did not come from the save dialog.\n')
        return
      }
      void this.runtimeReady
        .then((runtime) => runtime.dispatch(cmd))
        .catch((error: unknown) => {
          out(`\n  Window command failed: ${error instanceof Error ? error.message : String(error)}\n`)
        })
    })
    ipcMain.handle(IPC.WINDOW.DIFF, async (event, path: unknown): Promise<FileDiffDict | null> => {
      if (!this.trusted(event) || !isNonEmptyText(path)) return null
      const runtime = await this.runtimeReady
      const diff = await runtime.getFileDiff(path)
      return diff ? diff.toDict() : null
    })
    ipcMain.handle(IPC.WINDOW.SAVE_DIALOG, (event): Promise<TimelineSaveTarget | null> => {
      if (!this.trusted(event)) return Promise.resolve(null)
      return this.pickSaveTarget()
    })
    ipcMain.handle(IPC.API_KEY.GET, (event) => {
      if (!this.trusted(event)) throw new Error('Untrusted IPC sender')
      return this.getApiKey()
    })
    ipcMain.handle(IPC.API_KEY.SET, (event, key: unknown) => {
      if (!this.trusted(event)) throw new Error('Untrusted IPC sender')
      if (!isText(key)) return { ok: false, message: 'The API key must be a string.' }
      return this.saveApiKey(key)
    })
  }

  private async pickSaveTarget(): Promise<TimelineSaveTarget | null> {
    const runtime = await this.runtimeReady
    if (!this.win) return null
    const stamp = nowStrftime('%Y%m%d_%H%M%S')
    const result = await dialog.showSaveDialog(this.win, {
      defaultPath: join(process.cwd(), `gemibot_timeline_${stamp}.md`),
      title: 'Export Conversation Activity Timeline',
      filters: [
        { name: 'Markdown files', extensions: ['md'] },
        { name: 'HTML files', extensions: ['html'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    const path = extname(result.filePath) === '' ? `${result.filePath}.md` : result.filePath
    this.saveTarget = normalizeSavePath(path)
    return { path, ...runtime.exportMeta() }
  }

  private consumeSaveTarget(path: string): boolean {
    if (this.saveTarget === null) return false
    const ok = normalizeSavePath(path) === this.saveTarget
    this.saveTarget = null
    return ok
  }
}

function normalizeSavePath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const windowBridge = new WindowBridge()
