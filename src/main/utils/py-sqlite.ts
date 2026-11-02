import { DatabaseSync, StatementSync } from 'node:sqlite'

import { PythonError } from '../../shared/utils/exceptions'
import { pyFloatRepr } from '../../shared/utils/pyjson'
import { pyBytesRepr } from '../../shared/utils/pyrepr'
import { pyStr } from '../../shared/utils/pystr'

export const SQLITE_FETCH_LIMIT = 200

type SqliteValue = null | string | number | bigint | Uint8Array

const DATABASE_ERROR_CODES = [2, 11, 12, 16, 26]
const DATA_ERROR_CODES = [18, 25]
const INTEGRITY_ERROR_CODES = [19, 20]
const PROGRAMMING_ERROR_CODES = [21]

export function pySqliteValueStr(value: SqliteValue): string {
  if (value === null) return 'None'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return pyFloatRepr(value)
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return pyBytesRepr(value)
  return pyStr(value)
}

function sqliteErrcode(error: unknown): number | null {
  if (error instanceof Error && 'errcode' in error) {
    const code = (error as { errcode?: unknown }).errcode
    if (typeof code === 'number') return code
  }
  return null
}

export function pySqliteErrorName(errcode: number): string {
  const primary = errcode & 0xff
  if (DATABASE_ERROR_CODES.includes(primary)) return 'DatabaseError'
  if (DATA_ERROR_CODES.includes(primary)) return 'DataError'
  if (INTEGRITY_ERROR_CODES.includes(primary)) return 'IntegrityError'
  if (PROGRAMMING_ERROR_CODES.includes(primary)) return 'ProgrammingError'
  return 'OperationalError'
}

function asPythonError(error: unknown): unknown {
  const code = sqliteErrcode(error)
  if (code === null || !(error instanceof Error)) return error
  return new PythonError(pySqliteErrorName(code), error.message)
}

function isNoStatement(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_INVALID_ARG_VALUE' &&
    error.message === 'The SQL query contains no statements.'
  )
}

const LINE_END = /[\n\r]/

function skipTrivia(text: string, from: number, semicolons: boolean): number {
  let i = from
  for (;;) {
    const ch = text[i]
    if (ch === undefined) return i
    if (/\s/.test(ch) || (ch >= '\u001c' && ch <= '\u001f')) {
      i++
      continue
    }
    if (semicolons && ch === ';') {
      i++
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.slice(i + 2).search(LINE_END)
      i = end < 0 ? text.length : i + 2 + end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    return i
  }
}

function firstWord(text: string): string {
  const at = skipTrivia(text, 0, false)
  const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(at))
  return match ? match[0].toUpperCase() : ''
}

function hasSecondStatement(tail: string): boolean {
  return skipTrivia(tail, 0, false) < tail.length
}

export interface SqliteCursor {
  columns: string[] | null
  rows: string[][]
  rowcount: number
}

export class SqliteConnection {
  private readonly db: DatabaseSync

  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path)
    } catch (error) {
      throw asPythonError(error)
    }
  }

  execute(sql: string): SqliteCursor {
    if (sql.includes('\u0000'))
      throw new PythonError('ProgrammingError', 'the query contains a null character')

    let stmt: StatementSync
    try {
      stmt = this.db.prepare(sql)
    } catch (error) {
      if (isNoStatement(error)) return { columns: null, rows: [], rowcount: -1 }
      throw asPythonError(error)
    }

    if (hasSecondStatement(sql.slice(stmt.sourceSQL.length)))
      throw new PythonError('ProgrammingError', 'You can only execute one statement at a time.')

    const columns = stmt.columns()
    if (columns.length > 0) {
      stmt.setReturnArrays(true)
      stmt.setReadBigInts(true)
      const rows: string[][] = []
      try {
        for (const row of stmt.iterate() as unknown as Iterable<SqliteValue[]>) {
          rows.push(row.map(pySqliteValueStr))
          if (rows.length === SQLITE_FETCH_LIMIT) break
        }
      } catch (error) {
        throw asPythonError(error)
      }
      return { columns: columns.map((column) => column.name), rows, rowcount: -1 }
    }

    let changes: number | bigint
    try {
      changes = stmt.run().changes
    } catch (error) {
      throw asPythonError(error)
    }
    const isDml = ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(firstWord(stmt.sourceSQL))
    return { columns: null, rows: [], rowcount: isDml ? Number(changes) : -1 }
  }

  close(): void {
    this.db.close()
  }
}
