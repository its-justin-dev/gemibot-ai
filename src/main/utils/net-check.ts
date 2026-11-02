import { lookup } from 'dns/promises'
import { Socket } from 'net'

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const finish = (error?: Error): void => {
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish())
    socket.once('timeout', () => finish(new Error('connect timeout')))
    socket.once('error', (err) => finish(err))
    socket.connect(port, host)
  })
}

const LOOKUP_HOSTS = ['generativelanguage.googleapis.com', 'google.com']
/** A reachable network does not change between two turns, so the answer is worth reusing. */
const ONLINE_TTL_MS = 15000

let verifiedAt = 0

async function probe(timeoutMs: number): Promise<boolean> {
  const attempts = [
    tcpProbe('8.8.8.8', 53, timeoutMs),
    ...LOOKUP_HOSTS.map(async (host) => {
      await lookup(host)
    })
  ]
  try {
    await Promise.any(attempts)
    return true
  } catch {
    return false
  }
}

export async function checkInternet(timeoutMs = 1500): Promise<boolean> {
  if (Date.now() - verifiedAt < ONLINE_TTL_MS) return true
  const online = await probe(timeoutMs)
  if (online) verifiedAt = Date.now()
  return online
}
