import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pyJsonLoads } from '../../src/shared/utils/pyjson'

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

/**
 * Loads a reference output captured from current.v1.0 by
 * `tools/parity/dump-v1-fixtures.py`. The fixtures are unvalidated reference
 * data, so they are handed to the tests loosely typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as T
}

/**
 * The same fixture read through `pyJsonLoads`, so a Python `1.0` in the fixture file
 * stays distinguishable from `1` and can be re-dumped byte-for-byte.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixtureMarked<T = any>(name: string): T {
  return pyJsonLoads(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as T
}
