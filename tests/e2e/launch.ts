import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

export interface LaunchOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Starts the built app against a throwaway Electron profile. Conversations and settings now live
 * in the userData database, so a shared profile would let one spec restore another's chat and
 * would write test rows into the developer's real store.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<ElectronApplication> {
  const profile = mkdtempSync(join(tmpdir(), 'gemibot-e2e-profile-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    cwd: options.cwd,
    env: { ...process.env, GEMINI_API_KEY: 'parity-test-placeholder', ...options.env }
  })
  app.on('close', () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* a profile still locked by the OS stays in the temp folder */
    }
  })
  return app
}
