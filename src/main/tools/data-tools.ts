import { PythonError, ToolError } from '../../shared/utils/exceptions'
import { pySlice, pyTypeName } from '../../shared/utils/pystr'
import { SqliteConnection } from '../utils/py-sqlite'
import { EXCEL_TOOLS } from './sheet-tools'
import { pathArg, type ToolSpec } from './tool-contract'

const READ_FIRST_KEYWORD = /^\s*(SELECT|PRAGMA|EXPLAIN)(?![\p{L}\p{N}_])/iu

function sqlText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array)
    throw new PythonError('TypeError', 'cannot use a string pattern on a bytes-like object')
  throw new PythonError(
    'TypeError',
    `expected string or bytes-like object, got '${pyTypeName(value)}'`
  )
}

const sqliteQuery: ToolSpec = {
  python: 'tool_sqlite_query',
  params: [
    { name: 'db_path', required: true },
    { name: 'sql', required: true }
  ],
  run: async (ctx, args) => {
    const full = await ctx.paths.resolve(pathArg(args.db_path))
    const sql = sqlText(args.sql)
    const isRead = READ_FIRST_KEYWORD.test(sql)
    if (
      !isRead &&
      (ctx.state.mode === 'plan' || ctx.state.mode === 'read')
    )
      throw new ToolError(
        `SQLite writes are disabled in ${ctx.state.mode.toUpperCase()} mode. ` +
          'Switch to /build or /function.'
      )
    if (
      !isRead &&
      !(await ctx.allowed('sqlite_query', `${ctx.paths.rel(full)}: ${pySlice(sql, 0, 80)}`))
    )
      throw new ToolError('The user denied SQLite write query.')

    const conn = new SqliteConnection(full)
    try {
      const cur = conn.execute(sql)
      if (cur.columns) {
        const lines = [cur.columns.join(' | '), cur.columns.map(() => '---').join(' | ')]
        for (const row of cur.rows) lines.push(row.join(' | '))
        return `${lines.join('\n')}\n[${cur.rows.length} row(s)]`
      }
      return `Query executed successfully. Rows affected: ${cur.rowcount}`
    } finally {
      conn.close()
    }
  }
}

const csvAnalyze: ToolSpec = {
  python: 'tool_csv_analyze',
  params: [{ name: 'path', required: true }],
  run: (ctx, args) => EXCEL_TOOLS.excel_analyze.run(ctx, { path: args.path })
}

export const DATA_TOOLS: Record<string, ToolSpec> = {
  sqlite_query: sqliteQuery,
  csv_analyze: csvAnalyze
}
