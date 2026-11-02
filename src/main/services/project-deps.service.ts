import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface DependencyPlan {
  manager: PackageManager
  source: string
  command: string
}

export type DependencyPlanResult =
  | { ok: true; plan: DependencyPlan }
  | { ok: false; reason: 'missing-package-json' | 'invalid-package-json'; message: string }

const PACKAGE_MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])

const LOCKFILES: Array<[PackageManager, string]> = [
  ['pnpm', 'pnpm-lock.yaml'],
  ['yarn', 'yarn.lock'],
  ['bun', 'bun.lockb'],
  ['bun', 'bun.lock'],
  ['npm', 'package-lock.json']
]

function planFor(manager: PackageManager, source: string): DependencyPlanResult {
  return { ok: true, plan: { manager, source, command: `${manager} install` } }
}

export function detectDependencyPlan(root: string): DependencyPlanResult {
  const packageJsonPath = join(root, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      reason: 'missing-package-json',
      message: `No package.json was found in ${root}.`
    }
  }

  let raw: string
  try {
    raw = readFileSync(packageJsonPath, 'utf-8').replace(/^\uFEFF/u, '')
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-package-json',
      message: `package.json could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-package-json',
      message: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const declared = (parsed as { packageManager?: unknown }).packageManager
    if (typeof declared === 'string') {
      const name = declared.split('@')[0].trim().toLowerCase()
      if (PACKAGE_MANAGERS.has(name as PackageManager)) {
        return planFor(name as PackageManager, `packageManager field: ${declared}`)
      }
    }
  }

  for (const [manager, file] of LOCKFILES) {
    if (existsSync(join(root, file))) return planFor(manager, `lockfile: ${file}`)
  }

  return planFor('npm', 'default package manager')
}
