import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'

import type {
  BuildVerification,
  BuildVerifyKind,
  BuildVerifyStep
} from '../../shared/types/build'
import { BuildAbortedError, isBuildAbort } from './build-model.service'

const MAX_OUTPUT = 12_000
const DEFAULT_TIMEOUTS: Record<BuildVerifyKind, number> = {
  install: 600_000,
  build: 300_000,
  typecheck: 180_000,
  lint: 180_000,
  test: 300_000,
  smoke: 45_000
}

export interface BuildExecResult {
  exitCode: number
  output: string
  durationMs: number
  timedOut: boolean
}

/** Runs one already-whitelisted command. Tests inject a scripted implementation. */
export type BuildExec = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<BuildExecResult>

export interface BuildSmokeInput {
  command: string
  cwd: string
  port: number
  paths: string[]
  timeoutMs: number
  signal?: AbortSignal
}

export type BuildSmokeExec = (input: BuildSmokeInput) => Promise<BuildExecResult>

export interface BuildProjectInfo {
  kind: 'node' | 'python' | 'unknown'
  scripts: Record<string, string>
  dependencies: string[]
  port: number
  /** Command used to start the app for the smoke check, or null when headless. */
  serve: { command: string; port: number; paths: string[] } | null
  hasRequirements: boolean
  hasPyproject: boolean
}

export interface BuildVerifyOptions {
  kinds: BuildVerifyKind[]
  signal?: AbortSignal
  /** False records install as skipped instead of failing before dependencies exist. */
  install?: boolean
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, '')
}

function clip(text: string): string {
  const normalized = stripAnsi(text).replace(/\r\n?/gu, '\n').trim()
  if (normalized.length <= MAX_OUTPUT) return normalized
  return `...(truncated)...\n${normalized.slice(-MAX_OUTPUT)}`
}

function quote(commandPath: string): string {
  return /[\s"']/u.test(commandPath) ? `"${commandPath}"` : commandPath
}

function shellCommand(command: string, cwd: string): ChildProcess {
  if (process.platform === 'win32') {
    const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
    return spawn(comSpec, ['/c', command], {
      cwd,
      windowsHide: true
    })
  }
  return spawn('/bin/sh', ['-c', command], {
    cwd,
    detached: true
  })
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => undefined
    )
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 1_500).unref()
}

export const spawnBuildExec: BuildExec = (command, cwd, timeoutMs, signal) =>
  new Promise<BuildExecResult>((resolve) => {
    const started = Date.now()
    const child = shellCommand(command, cwd)
    const chunks: Buffer[] = []
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode,
        output: clip(Buffer.concat(chunks).toString('utf8')),
        durationMs: Date.now() - started,
        timedOut
      })
    }

    const onAbort = (): void => {
      aborted = true
      killTree(child)
      finish(130)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      finish(124)
    }, Math.max(1_000, timeoutMs))
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => {
      chunks.push(Buffer.from(String(error)))
      finish(127)
    })
    child.on('close', (code, signalName) => {
      if (aborted) return
      finish(code ?? (signalName === null ? 1 : 128))
    })
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })

async function probe(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetch(url, {
      signal: signal !== undefined ? signal : AbortSignal.timeout(1_500)
    })
    await response.arrayBuffer().catch(() => undefined)
    return response.status
  } catch {
    return 0
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export const defaultSmokeExec: BuildSmokeExec = async (input) => {
  const started = Date.now()
  const child = shellCommand(input.command, input.cwd)
  const chunks: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))
  let exited = false
  child.on('close', () => {
    exited = true
  })
  child.on('error', (error) => {
    chunks.push(Buffer.from(String(error)))
    exited = true
  })

  const deadline = started + Math.max(5_000, input.timeoutMs)
  let status = 0
  let path = ''
  try {
    while (Date.now() < deadline && !exited) {
      if (input.signal?.aborted === true) throw new BuildAbortedError()
      for (const candidate of input.paths) {
        const code = await probe(`http://127.0.0.1:${input.port}${candidate}`, input.signal)
        if (code > 0 && code < 500) {
          status = code
          path = candidate
          break
        }
      }
      if (status > 0) break
      await sleep(500, input.signal)
    }
  } finally {
    killTree(child)
  }
  const output = clip(Buffer.concat(chunks).toString('utf8'))
  if (status === 0) {
    return {
      exitCode: 1,
      output: `The app did not respond on port ${input.port}.\n${output}`,
      durationMs: Date.now() - started,
      timedOut: true
    }
  }
  return {
    exitCode: 0,
    output: `HTTP ${status} on http://127.0.0.1:${input.port}${path}\n${output}`,
    durationMs: Date.now() - started,
    timedOut: false
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

export class BuildVerifier {
  readonly root: string
  private readonly exec: BuildExec
  private readonly smoke: BuildSmokeExec
  private cached: BuildProjectInfo | null = null

  constructor(
    root: string,
    deps: { exec?: BuildExec; smoke?: BuildSmokeExec } = {}
  ) {
    this.root = root
    this.exec = deps.exec ?? spawnBuildExec
    this.smoke = deps.smoke ?? defaultSmokeExec
  }

  invalidate(): void {
    this.cached = null
  }

  async detect(): Promise<BuildProjectInfo> {
    if (this.cached !== null) return this.cached
    const packageJson = await readJson(join(this.root, 'package.json'))
    const hasRequirements = existsSync(join(this.root, 'requirements.txt'))
    const hasPyproject = existsSync(join(this.root, 'pyproject.toml'))
    const scripts = stringRecord(packageJson?.['scripts'])
    const dependencies = [
      ...Object.keys(stringRecord(packageJson?.['dependencies'])),
      ...Object.keys(stringRecord(packageJson?.['devDependencies']))
    ].map((name) => name.toLowerCase())
    const hasNode = packageJson !== null
    const hasPython = hasRequirements || hasPyproject
    const kind: BuildProjectInfo['kind'] = hasNode ? 'node' : hasPython ? 'python' : 'unknown'

    let port = kind === 'python' ? 8000 : 3000
    try {
      const env = await readFile(join(this.root, '.env.example'), 'utf8')
      const match = /(?:^|\n)\s*(?:PORT|APP_PORT|SERVER_PORT)\s*=\s*(\d{2,5})/u.exec(env)
      if (match !== null) port = Number(match[1])
    } catch {}

    let serve: BuildProjectInfo['serve'] = null
    if (kind === 'node' && !dependencies.includes('electron')) {
      if (dependencies.includes('next') && scripts['start'] !== undefined) {
        serve = { command: 'npm start', port, paths: ['/'] }
      } else if (dependencies.includes('vite') && scripts['preview'] !== undefined) {
        serve = {
          command: `npm run preview -- --port 4173 --strictPort`,
          port: 4173,
          paths: ['/']
        }
      } else if (
        dependencies.some((name) => ['express', 'fastify', 'koa', 'hono'].includes(name)) &&
        (scripts['start'] !== undefined || scripts['dev'] !== undefined)
      ) {
        serve = {
          command: scripts['start'] !== undefined ? 'npm start' : 'npm run dev',
          port,
          paths: ['/health', '/']
        }
      }
    }
    if (kind === 'python') {
      let main = ''
      try {
        main = await readFile(join(this.root, 'app', 'main.py'), 'utf8')
      } catch {}
      if (/FastAPI\s*\(/u.test(main)) {
        serve = {
          command: `${quote(this.pythonExecutable())} -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`,
          port,
          paths: ['/health', '/']
        }
      }
    }

    this.cached = {
      kind,
      scripts,
      dependencies,
      port,
      serve,
      hasRequirements,
      hasPyproject
    }
    return this.cached
  }

  private pythonExecutable(): string {
    return process.platform === 'win32'
      ? join(this.root, '.venv', 'Scripts', 'python.exe')
      : join(this.root, '.venv', 'bin', 'python')
  }

  private async commandFor(
    kind: BuildVerifyKind,
    info: BuildProjectInfo
  ): Promise<{ command: string; skip?: string }> {
    if (kind === 'install') {
      if (info.kind === 'node') {
        return { command: 'npm install --no-audit --no-fund --no-progress' }
      }
      if (info.kind === 'python') {
        if (!existsSync(this.pythonExecutable())) {
          return { command: 'python -m venv .venv' }
        }
        if (info.hasRequirements) {
          return {
            command: `${quote(this.pythonExecutable())} -m pip install --disable-pip-version-check -r requirements.txt`
          }
        }
        if (info.hasPyproject) {
          return {
            command: `${quote(this.pythonExecutable())} -m pip install --disable-pip-version-check -e .`
          }
        }
      }
      return { command: '', skip: 'No dependency manifest was found.' }
    }
    if (info.kind === 'node') {
      const script = kind === 'test' ? 'test' : kind
      if (info.scripts[script] !== undefined) {
        if (kind === 'test') return { command: 'npm test' }
        return { command: `npm run ${script}` }
      }
      return { command: '', skip: `package.json has no "${script}" script.` }
    }
    if (info.kind === 'python') {
      if (kind === 'typecheck') {
        return { command: `${quote(this.pythonExecutable())} -m compileall -q app tests` }
      }
      if (kind === 'build') {
        return { command: '', skip: 'Python projects have no separate build step.' }
      }
      if (kind === 'test') {
        if (existsSync(join(this.root, 'tests')) || info.hasRequirements) {
          return { command: `${quote(this.pythonExecutable())} -m pytest -q` }
        }
      }
      return { command: '', skip: `No Python ${kind} command is configured.` }
    }
    return { command: '', skip: 'No project manifest was found.' }
  }

  /**
   * A Python venv needs two install invocations (create, then pip). Running "install" doubles as
   * environment creation so a fresh checkout needs one action from the user's perspective.
   */
  private async ensurePythonVenv(signal?: AbortSignal): Promise<string | null> {
    if (process.platform === 'win32') {
      const python = this.pythonExecutable()
      if (existsSync(python)) return null
      const result = await this.exec('python -m venv .venv', this.root, DEFAULT_TIMEOUTS.install, signal)
      if (result.exitCode !== 0) return result.output || 'python -m venv failed'
      return null
    }
    const python = this.pythonExecutable()
    if (existsSync(python)) return null
    const result = await this.exec('python3 -m venv .venv', this.root, DEFAULT_TIMEOUTS.install, signal)
    if (result.exitCode !== 0) return result.output || 'python3 -m venv failed'
    return null
  }

  private step(
    kind: BuildVerifyKind,
    command: string,
    result: BuildExecResult,
    status: BuildVerifyStep['status']
  ): BuildVerifyStep {
    return {
      kind,
      command,
      status,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs
    }
  }

  async verify(options: BuildVerifyOptions): Promise<BuildVerification> {
    const info = await this.detect()
    const steps: BuildVerifyStep[] = []
    const failedKinds = new Set<BuildVerifyKind>()
    let installBlocked = false
    let buildPassed = info.scripts['build'] === undefined

    if (options.install === false) {
      steps.push({
        kind: 'install',
        command: '(disabled in settings)',
        status: 'skipped',
        exitCode: 0,
        output: 'Dependency installation is disabled in Build settings.',
        durationMs: 0
      })
    }

    for (const kind of options.kinds) {
      if (options.signal?.aborted === true) throw new BuildAbortedError()
      if (kind === 'install' && options.install === false) continue
      if (installBlocked && kind !== 'install') {
        steps.push({
          kind,
          command: '',
          status: 'skipped',
          exitCode: 0,
          output: 'Skipped because dependency installation failed.',
          durationMs: 0
        })
        continue
      }
      if (kind === 'smoke' && options.kinds.includes('build') && !buildPassed) {
        steps.push({
          kind,
          command: '',
          status: 'skipped',
          exitCode: 0,
          output: 'Skipped because the build failed.',
          durationMs: 0
        })
        continue
      }

      if (kind === 'install' && info.kind === 'python') {
        const venvError = await this.ensurePythonVenv(options.signal)
        if (venvError !== null) {
          const result: BuildExecResult = {
            exitCode: 1,
            output: venvError,
            durationMs: 0,
            timedOut: false
          }
          steps.push(this.step(kind, 'python -m venv .venv', result, 'failed'))
          failedKinds.add(kind)
          installBlocked = true
          continue
        }
      }

      if (kind === 'smoke') {
        if (info.serve === null) {
          steps.push({
            kind,
            command: '',
            status: 'skipped',
            exitCode: 0,
            output: 'No runnable server was detected, so the smoke check was skipped.',
            durationMs: 0
          })
          continue
        }
        try {
          const result = await this.smoke({
            command: info.serve.command,
            cwd: this.root,
            port: info.serve.port,
            paths: info.serve.paths,
            timeoutMs: DEFAULT_TIMEOUTS.smoke,
            signal: options.signal
          })
          const passed = result.exitCode === 0
          steps.push(
            this.step(kind, info.serve.command, result, passed ? 'success' : 'failed')
          )
          if (!passed) failedKinds.add(kind)
        } catch (error) {
          if (isBuildAbort(error)) throw new BuildAbortedError()
          const message = error instanceof Error ? error.message : String(error)
          steps.push({
            kind,
            command: info.serve.command,
            status: 'failed',
            exitCode: 1,
            output: message,
            durationMs: 0
          })
          failedKinds.add(kind)
        }
        continue
      }

      const { command, skip } = await this.commandFor(kind, info)
      if (command === '' || skip !== undefined) {
        steps.push({
          kind,
          command,
          status: 'skipped',
          exitCode: 0,
          output: skip ?? 'Not configured.',
          durationMs: 0
        })
        continue
      }
      try {
        const result = await this.exec(
          command,
          this.root,
          DEFAULT_TIMEOUTS[kind],
          options.signal
        )
        const passed = result.exitCode === 0 && !result.timedOut
        if (!passed) failedKinds.add(kind)
        if (kind === 'install' && !passed) installBlocked = true
        if (kind === 'build') buildPassed = passed
        steps.push(this.step(kind, command, result, passed ? 'success' : 'failed'))
      } catch (error) {
        if (isBuildAbort(error)) throw new BuildAbortedError()
        const message = error instanceof Error ? error.message : String(error)
        steps.push({
          kind,
          command,
          status: 'failed',
          exitCode: 1,
          output: message,
          durationMs: 0
        })
        failedKinds.add(kind)
        if (kind === 'install') installBlocked = true
      }
    }

    const succeeded = steps.filter((step) => step.status === 'success').length
    const passed = failedKinds.size === 0 && succeeded > 0
    const summaryLines = steps.map(
      (step) =>
        `${step.kind} ${step.command || '(none)'}: ${step.status}` +
        (step.status === 'failed' ? ` (exit ${step.exitCode})` : '')
    )
    return {
      steps,
      passed,
      summary:
        succeeded === 0 && steps.every((step) => step.status === 'skipped')
          ? 'No verification command could run. Add a build, typecheck or test script.'
          : `${passed ? 'Verification passed' : 'Verification failed'} — ${failedKinds.size} failed, ${succeeded} succeeded\n${summaryLines.join('\n')}`
    }
  }
}
