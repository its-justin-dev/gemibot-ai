import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { buildMainConfig } from '../../shared/utils/config'
import type { EnvSource, MainConfig } from '../../shared/types/config'
import { paths } from '../utils/paths'
import { log } from './logger.service'

let loaded = false

function loadRuntimeEnv(): void {
  if (loaded) return
  loaded = true

  for (const file of [join(app.getAppPath(), '.env'), join(paths.userData(), '.env')]) {
    if (!existsSync(file)) continue
    process.loadEnvFile(file)
    log.info(`Loaded runtime environment from ${file}`)
    return
  }
  log.debug('No .env file found, using the ambient environment')
}

export const configService = {
  get(): MainConfig {
    loadRuntimeEnv()

    const source: EnvSource = {
      MAIN_VITE_APP_ENV: import.meta.env.MAIN_VITE_APP_ENV,
      MAIN_VITE_API_BASE_URL: import.meta.env.MAIN_VITE_API_BASE_URL,
      GEMIBOT_API_KEY: process.env['GEMIBOT_API_KEY']
    }

    const config = buildMainConfig(source)
    if (!config.hasApiKey) log.warn('GEMIBOT_API_KEY is not set')
    return config
  }
}
