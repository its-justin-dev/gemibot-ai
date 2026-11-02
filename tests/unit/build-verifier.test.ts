import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

import { BuildAbortedError } from '../../src/main/services/build-model.service'
import {
  BuildVerifier,
  type BuildExec,
  type BuildExecResult,
  type BuildSmokeExec
} from '../../src/main/services/build-verifier.service'

const workspaces: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gemibot-build-verify-'))
  workspaces.push(dir)
  return dir
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

function result(exitCode = 0, output = 'ok'): BuildExecResult {
  return { exitCode, output, durationMs: 5, timedOut: false }
}

interface ExecCall {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

function execFrom(
  handler: (command: string) => BuildExecResult,
  calls: ExecCall[] = []
): BuildExec {
  return async (command, cwd, timeoutMs, signal) => {
    calls.push({ command, cwd, timeoutMs, signal })
    return handler(command)
  }
}

const successExec = (calls: ExecCall[] = []): BuildExec => execFrom(() => result(), calls)

describe('BuildVerifier.detect', () => {
  it('detects a Vite app and its preview smoke command', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          build: 'tsc && vite build',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
          preview: 'vite preview'
        },
        dependencies: { react: '19.1.1' },
        devDependencies: { vite: '7.1.2' }
      })
    )
    await put(root, '.env.example', 'VITE_API_URL=http://localhost:3000\nPORT=4100\n')
    const info = await new BuildVerifier(root).detect()
    expect(info).toMatchObject({
      kind: 'node',
      port: 4100,
      hasRequirements: false,
      hasPyproject: false,
      serve: { command: 'npm run preview -- --port 4173 --strictPort', port: 4173, paths: ['/'] }
    })
    expect(info.dependencies).toEqual(expect.arrayContaining(['react', 'vite']))
    expect(info.scripts.build).toContain('vite build')
  })

  it('detects an Express server on the configured port', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: { start: 'node dist/server.js', build: 'tsc' },
        dependencies: { express: '5.1.0' }
      })
    )
    await put(root, '.env.example', 'PORT=4300\n')
    const info = await new BuildVerifier(root).detect()
    expect(info.serve).toEqual({
      command: 'npm start',
      port: 4300,
      paths: ['/health', '/']
    })
  })

  it('does not try to launch Electron or unsupported frameworks', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: { start: 'electron .' },
        devDependencies: { electron: '37.2.6' }
      })
    )
    expect((await new BuildVerifier(root).detect()).serve).toBeNull()

    const nextRoot = await workspace()
    await put(
      nextRoot,
      'package.json',
      JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: { next: '15.5.0' }
      })
    )
    expect((await new BuildVerifier(nextRoot).detect()).serve).toBeNull()
  })

  it('detects a FastAPI project from requirements and main.py', async () => {
    const root = await workspace()
    await put(root, 'requirements.txt', 'fastapi==0.116.1\n')
    await put(root, 'app/main.py', 'from fastapi import FastAPI\napp = FastAPI()\n')
    const info = await new BuildVerifier(root).detect()
    expect(info).toMatchObject({ kind: 'python', port: 8000, hasRequirements: true })
    expect(info.serve?.command).toContain('-m uvicorn app.main:app')
    expect(info.serve?.port).toBe(8000)
    expect(info.serve?.paths).toEqual(['/health', '/'])
  })

  it('reports an unknown project and caches detection until invalidated', async () => {
    const root = await workspace()
    const verifier = new BuildVerifier(root)
    expect((await verifier.detect()).kind).toBe('unknown')
    await put(root, 'package.json', JSON.stringify({ scripts: {} }))
    expect((await verifier.detect()).kind).toBe('unknown')
    verifier.invalidate()
    expect((await verifier.detect()).kind).toBe('node')
  })

  it('ignores a malformed package.json', async () => {
    const root = await workspace()
    await put(root, 'package.json', '{broken')
    expect((await new BuildVerifier(root).detect()).kind).toBe('unknown')
  })
})

describe('BuildVerifier.verify (Node)', () => {
  async function nodeProject(): Promise<string> {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          build: 'vite build',
          typecheck: 'tsc --noEmit',
          test: 'vitest run'
        },
        devDependencies: { vite: '7.1.2' }
      })
    )
    return root
  }

  it('runs configured scripts in order and skips missing ones', async () => {
    const root = await nodeProject()
    const calls: ExecCall[] = []
    const verification = await new BuildVerifier(root, { exec: successExec(calls) }).verify({
      kinds: ['build', 'typecheck', 'lint', 'test']
    })
    expect(calls.map((call) => call.command)).toEqual([
      'npm run build',
      'npm run typecheck',
      'npm test'
    ])
    expect(calls.every((call) => call.cwd === root)).toBe(true)
    expect(verification.passed).toBe(true)
    expect(verification.steps.map((step) => step.status)).toEqual([
      'success',
      'success',
      'skipped',
      'success'
    ])
    expect(verification.steps[2].output).toContain('package.json has no "lint" script.')
    expect(verification.summary).toContain('Verification passed')
  })

  it('fails when every command is skipped and says nothing was verified', async () => {
    const root = await workspace()
    await put(root, 'package.json', JSON.stringify({ scripts: {} }))
    const verification = await new BuildVerifier(root, { exec: successExec() }).verify({
      kinds: ['build', 'typecheck']
    })
    expect(verification.passed).toBe(false)
    expect(verification.steps.every((step) => step.status === 'skipped')).toBe(true)
    expect(verification.summary).toBe(
      'No verification command could run. Add a build, typecheck or test script.'
    )
  })

  it('records command failures with the real exit code', async () => {
    const root = await nodeProject()
    const verification = await new BuildVerifier(root, {
      exec: execFrom((command) =>
        command === 'npm run build' ? result(2, 'TypeError: broken') : result()
      )
    }).verify({ kinds: ['build', 'typecheck'] })
    expect(verification.passed).toBe(false)
    expect(verification.steps[0]).toMatchObject({
      kind: 'build',
      status: 'failed',
      exitCode: 2,
      output: 'TypeError: broken'
    })
    expect(verification.summary).toContain('1 failed, 1 succeeded')
  })

  it('skips smoke when the build failed', async () => {
    const root = await nodeProject()
    const smokeCalls: string[] = []
    const smoke: BuildSmokeExec = async (input) => {
      smokeCalls.push(input.command)
      return result()
    }
    const verification = await new BuildVerifier(root, {
      exec: execFrom((command) => (command === 'npm run build' ? result(1) : result())),
      smoke
    }).verify({ kinds: ['build', 'smoke'] })
    expect(smokeCalls).toEqual([])
    expect(verification.steps[1]).toMatchObject({
      kind: 'smoke',
      status: 'skipped',
      output: 'Skipped because the build failed.'
    })
    expect(verification.passed).toBe(false)
  })

  it('blocks every later command when installation fails', async () => {
    const root = await nodeProject()
    const calls: ExecCall[] = []
    const verification = await new BuildVerifier(root, {
      exec: execFrom(() => result(1, 'npm ERR! network'), calls)
    }).verify({ kinds: ['install', 'build', 'typecheck'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('npm install --no-audit --no-fund --no-progress')
    expect(verification.passed).toBe(false)
    expect(verification.steps[1]).toMatchObject({
      status: 'skipped',
      output: 'Skipped because dependency installation failed.'
    })
    expect(verification.steps[2].status).toBe('skipped')
  })

  it('records a skipped install when dependency installation is disabled', async () => {
    const root = await nodeProject()
    const calls: ExecCall[] = []
    const verification = await new BuildVerifier(root, { exec: successExec(calls) }).verify({
      kinds: ['install', 'build'],
      install: false
    })
    expect(calls.map((call) => call.command)).toEqual(['npm run build'])
    expect(verification.steps[0]).toMatchObject({
      kind: 'install',
      command: '(disabled in settings)',
      status: 'skipped'
    })
    expect(verification.passed).toBe(true)
  })

  it('runs the injected smoke check and reports its HTTP result', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: { start: 'node server.js' },
        dependencies: { express: '5.1.0' }
      })
    )
    const smokeInputs: Array<{ command: string; port: number; paths: string[] }> = []
    const verification = await new BuildVerifier(root, {
      exec: successExec(),
      smoke: async (input) => {
        smokeInputs.push({ command: input.command, port: input.port, paths: input.paths })
        return result(0, 'HTTP 200 on /health')
      }
    }).verify({ kinds: ['smoke'] })
    expect(smokeInputs).toEqual([{ command: 'npm start', port: 3000, paths: ['/health', '/'] }])
    expect(verification.passed).toBe(true)
    expect(verification.steps[0]).toMatchObject({ kind: 'smoke', status: 'success' })
  })

  it('fails the smoke step when the server never responds', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({
        scripts: { start: 'node server.js' },
        dependencies: { express: '5.1.0' }
      })
    )
    const verification = await new BuildVerifier(root, {
      exec: successExec(),
      smoke: async () => result(1, 'The app did not respond on port 3000.')
    }).verify({ kinds: ['smoke'] })
    expect(verification.passed).toBe(false)
    expect(verification.steps[0]).toMatchObject({ kind: 'smoke', status: 'failed', exitCode: 1 })
  })

  it('skips smoke when no server can be detected', async () => {
    const root = await workspace()
    await put(
      root,
      'package.json',
      JSON.stringify({ scripts: { build: 'tsc' }, devDependencies: { electron: '37.2.6' } })
    )
    const verification = await new BuildVerifier(root, { exec: successExec() }).verify({
      kinds: ['smoke']
    })
    expect(verification.steps[0]).toMatchObject({
      kind: 'smoke',
      status: 'skipped',
      output: 'No runnable server was detected, so the smoke check was skipped.'
    })
    expect(verification.passed).toBe(false)
  })

  it('aborts before running a command', async () => {
    const root = await nodeProject()
    const controller = new AbortController()
    controller.abort()
    const calls: ExecCall[] = []
    await expect(
      new BuildVerifier(root, { exec: successExec(calls) }).verify({
        kinds: ['build'],
        signal: controller.signal
      })
    ).rejects.toBeInstanceOf(BuildAbortedError)
    expect(calls).toHaveLength(0)
  })

  it('turns an aborted exec into BuildAbortedError', async () => {
    const root = await nodeProject()
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    const exec: BuildExec = async () => {
      throw abortError
    }
    await expect(
      new BuildVerifier(root, { exec }).verify({ kinds: ['build'] })
    ).rejects.toBeInstanceOf(BuildAbortedError)
  })
})

describe('BuildVerifier.verify (Python)', () => {
  it('uses a local venv for install, compile and pytest commands', async () => {
    const root = await workspace()
    await put(root, 'requirements.txt', 'fastapi==0.116.1\npytest==8.4.1\n')
    await put(root, 'app/main.py', 'from fastapi import FastAPI\napp = FastAPI()\n')
    const python = join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'
    )
    await mkdir(dirname(python), { recursive: true })
    await writeFile(python, '')
    const calls: ExecCall[] = []
    const verification = await new BuildVerifier(root, { exec: successExec(calls) }).verify({
      kinds: ['install', 'typecheck', 'test']
    })
    expect(calls).toHaveLength(3)
    expect(calls[0].command).toContain('pip install')
    expect(calls[0].command).toContain('-r requirements.txt')
    expect(calls[1].command).toContain('-m compileall -q app tests')
    expect(calls[2].command).toContain('-m pytest -q')
    expect(calls.every((call) => call.command.includes('.venv'))).toBe(true)
    expect(verification.passed).toBe(true)
  })

  it('creates the venv before installing dependencies', async () => {
    const root = await workspace()
    await put(root, 'requirements.txt', 'fastapi==0.116.1\n')
    await put(root, 'app/main.py', 'from fastapi import FastAPI\napp = FastAPI()\n')
    const calls: ExecCall[] = []
    const verification = await new BuildVerifier(root, {
      exec: execFrom((command) => {
        if (command.includes('python') && command.includes('-m venv')) {
          return result(0, 'venv created')
        }
        return result()
      }, calls)
    }).verify({ kinds: ['install'] })
    expect(calls[0].command).toMatch(/python(3)? -m venv \.venv$/)
    expect(calls[1].command).toContain('-m venv .venv')
    expect(verification.steps).toHaveLength(1)
  })

  it('skips a separate build step for Python', async () => {
    const root = await workspace()
    await put(root, 'requirements.txt', 'fastapi==0.116.1\n')
    await put(root, 'app/main.py', 'from fastapi import FastAPI\n')
    const verification = await new BuildVerifier(root, { exec: successExec() }).verify({
      kinds: ['build']
    })
    expect(verification.steps[0]).toMatchObject({
      kind: 'build',
      status: 'skipped',
      output: 'Python projects have no separate build step.'
    })
  })
})
