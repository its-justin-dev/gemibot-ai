declare module 'better-sqlite3' {
  interface Statement {
    run(...params: any[]): { lastInsertRowid: number; changes: number }
    get(...params: any[]): any
    all(...params: any[]): any[]
  }

  class Database {
    constructor(filename: string, options?: { readonly?: boolean })
    prepare(sql: string): Statement
    pragma(sql: string, options?: { simple?: boolean }): any
    exec(sql: string): void
    close(): void
    transaction<T>(fn: () => T): () => T
  }
  export = Database
}
