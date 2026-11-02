import { spawn, type ChildProcess } from 'child_process'

export const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15
}

const activeChildren = new Set<ChildProcess>()

export function spawnShell(command: string, cwd: string): ChildProcess {
  const child =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', ['/c', command], {
          cwd,
          windowsHide: true
        })
      : // A dedicated process group lets a stop kill the shell's children too.
        spawn('/bin/sh', ['-c', command], { cwd, detached: true })
  activeChildren.add(child)
  child.once('close', () => activeChildren.delete(child))
  child.once('error', () => activeChildren.delete(child))
  return child
}

/** Kills the shell and every process it started (npm, node, python, ...). */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid
  if (pid === undefined) {
    try {
      child.kill(signal)
    } catch {}
    return
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      }).on('error', () => undefined)
    } catch {}
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

/** Called on quit so a long command cannot keep writing after the window closes. */
export function killAllChildren(): void {
  for (const child of activeChildren) killProcessTree(child, 'SIGTERM')
  activeChildren.clear()
}

export function pyNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n')
}

export function shellReturncode(code: number | null, signal: string | null): number {
  return code === null ? -(SIGNAL_NUMBERS[signal ?? ''] ?? 1) : code
}
