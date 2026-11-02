import { app, BrowserWindow, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { AppConstants } from '../shared/constants/app-constants'
import { C } from '../shared/constants/colors'
import { registerIpcHandlers } from './ipc'
import { windowBridge } from './ipc/window.handlers'
import { buildAppMenu } from './menu/app-menu'
import { Agent } from './services/agent.service'
import { log } from './services/logger.service'
import { WindowRuntime } from './services/window-runtime.service'
import { choose } from './utils/choose'
import { onConsoleOutput, out } from './utils/console-out'
import { pyResolve } from './utils/fs-path'
import { envCandidates, loadDotenv, resolveApiKey } from './utils/load-env'
import { killAllChildren } from './utils/py-subprocess'
import { createMainWindow } from './windows/main-window'
import { openDatabase, closeDatabase, getDbPath } from './services/database.service'
import { legacyImport, type LegacyImportReport } from './services/legacy-import.service'

// One stray rejection must not take the whole window down mid-session. Log it with the full
// stack so it still surfaces in the terminal mirror and the log file.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  out(`${C.RED}Unhandled rejection: ${message}${C.RESET}`)
  log.error(`Unhandled rejection: ${message}`)
})
process.on('uncaughtException', (error) => {
  const message = error.stack ?? error.message
  out(`${C.RED}Uncaught exception: ${message}${C.RESET}`)
  log.error(`Uncaught exception: ${message}`)
})

function requireApiKey(): string {
  const key = resolveApiKey()
  if (key) return key
  // The key can still be entered from the in-app dialog, so a missing key must not kill the
  // window before it is shown.
  out(
    `${C.YELLOW}No API key found yet.${C.RESET} Use the API key button in the window, or set ` +
      'the GEMINI_API_KEY environment variable and restart.'
  )
  return ''
}

async function createAgent(key: string): Promise<Agent> {
  const readLine = (prompt: string): Promise<string | null> => windowBridge.readLine(prompt)
  return await Agent.create({
    root: pyResolve(process.cwd()),
    model: AppConstants.MODELS[0],
    apiKey: key,
    readLine,
    choose: (title, items, options) => choose(title, items, options, readLine),
    advancedAgent: true,
    streamResponses: true
  })
}

async function launchWindowUi(
  agent: Agent,
  migration: Promise<LegacyImportReport | null>,
  databaseOk: boolean
): Promise<void> {
  out(
    `\n${C.CYAN}${C.BOLD}+---------------------------------------------------------------+${C.RESET}`
  )
  out(
    `${C.CYAN}${C.BOLD}|  Gemibot Window Mode Active - Real-Time Terminal Mirroring   |${C.RESET}`
  )
  out(
    `${C.CYAN}${C.BOLD}+---------------------------------------------------------------+${C.RESET}`
  )
  out(`  ${C.GRAY}Target Directory :${C.RESET} ${C.GREEN}${pyResolve(process.cwd())}${C.RESET}`)
  out(`  ${C.GRAY}Active Model     :${C.RESET} ${C.YELLOW}${agent.model}${C.RESET}`)
  out(`  ${C.GRAY}Memory Store     :${C.RESET} ${C.DIM}conversation database${C.RESET}`)
  out(`  ${C.GRAY}Conversation DB  :${C.RESET} ${C.DIM}${getDbPath()}${C.RESET}`)
  out(`  ${C.DIM}All prompts, thinking, memory reads, tool calls, and responses${C.RESET}`)
  out(`  ${C.DIM}from the GUI will mirror here in real time for debugging.${C.RESET}\n`)

  // The import runs alongside agent creation; wait for it so the first snapshot already lists
  // the imported conversations, then report it as a pill instead of blocking the window.
  const report = await migration
  const runtime = await WindowRuntime.create(agent, windowBridge)
  windowBridge.bindRuntime(runtime)

  if (!databaseOk) {
    windowBridge.emit({
      kind: 'pill',
      text: 'Database unavailable: this session will not be saved.',
      icon: '⚠️'
    })
  } else if (report !== null) {
    if (report.imported > 0) {
      windowBridge.emit({
        kind: 'pill',
        text: `Imported ${report.imported} session(s) from legacy backups.`,
        icon: '📥'
      })
    }
    if (report.errors.length > 0 || report.warnings.length > 0) {
      windowBridge.emit({
        kind: 'pill',
        text: `Import finished with ${report.warnings.length} warning(s) and ${report.errors.length} error(s). See the console.`,
        icon: '⚠️'
      })
    }
  }
}

function bootstrap(): void {
  electronApp.setAppUserModelId('com.gemibot.prototype')

  // Every privileged web capability (camera, microphone, notifications, geolocation, …) is
  // unnecessary here: copy, voice and file access all run through validated IPC instead.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  // The database is opened once, before anything can write to it.  A failure here leaves the app
  // running in RAM with a visible warning; it never falls back to session files.
  let databaseOk = true
  try {
    openDatabase()
    out(`${C.GREEN}Database initialized at ${getDbPath()}${C.RESET}`)
  } catch (err) {
    databaseOk = false
    out(
      `${C.RED}Failed to initialize database at ${getDbPath()}: ` +
        `${err instanceof Error ? err.message : String(err)}${C.RESET}`
    )
    out(`${C.YELLOW}Continuing without persistence; chats will not be saved.${C.RESET}`)
  }

  const migration: Promise<LegacyImportReport | null> = databaseOk
    ? legacyImport.importExistingSessions(pyResolve(process.cwd())).catch((err) => {
        out(
          `${C.YELLOW}Legacy import warning: ${err instanceof Error ? err.message : String(err)}${C.RESET}`
        )
        return null
      })
    : Promise.resolve(null)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  buildAppMenu()

  const win = createMainWindow()
  windowBridge.attachWindow(win)
  onConsoleOutput((text, terminator) => {
    windowBridge.emit({ kind: 'console', text: `${text}${terminator}` })
  })

  loadDotenv(envCandidates(app.getAppPath(), app.getPath('userData')))
  const key = requireApiKey()
  void createAgent(key)
    .then((agent) => {
      if (!key) {
        windowBridge.emit({
          kind: 'pill',
          text: 'No API key configured yet. Use the API key button to add one.',
          icon: '🔑'
        })
      }
      return launchWindowUi(agent, migration, databaseOk)
    })
    .catch((err) => {
      out(`Error: ${err instanceof Error ? err.message : String(err)}`)
      log.error(`Window launch failed: ${String(err)}`)
    })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const reopened = createMainWindow()
      windowBridge.attachWindow(reopened)
    }
  })

  log.info(`Started ${app.getName()} v${app.getVersion()} on ${process.platform}`)
}

// Two app instances would open the same SQLite store and race each other's turns and settings.
// The second launch focuses the running window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win === undefined) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(bootstrap).catch((err) => {
    out(`Startup failed: ${err instanceof Error ? err.message : String(err)}`)
    log.error(`Startup failed: ${String(err)}`)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  killAllChildren()
})

app.on('quit', () => {
  closeDatabase()
})
