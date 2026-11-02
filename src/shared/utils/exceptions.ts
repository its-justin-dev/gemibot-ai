export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export class PythonError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

export class KeyboardInterrupt extends Error {
  constructor() {
    super('')
    this.name = 'KeyboardInterrupt'
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
