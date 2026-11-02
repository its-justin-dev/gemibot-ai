export type KeyPoll = () => boolean

export class EscMonitor {
  active = false
  interrupted = false

  constructor(private readonly poll: KeyPoll = () => false) {}

  resume(): void {
    if (this.active) return
    this.active = true
  }

  pause(): void {
    this.active = false
  }

  check(): boolean {
    if (this.interrupted) return true
    if (!this.active) return false
    return this.poll()
  }
}
