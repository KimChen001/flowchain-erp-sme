import net from 'node:net'

// Preloaded into the evaluation's API servers (node --import) and imported by
// the runner: every TCP connection to a host other than this machine is
// refused before it opens and reported on stderr, so the evaluation can never
// reach a model provider, a mail service or any other paid system. The runner
// counts the reports and fails the run if there is one.

export const OFFLINE_GUARD_MARKER = '[ai-eval-offline-guard] blocked'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', ''])
// The runner's --provider-env mode lets the API servers reach the one model
// provider host it names (exact match); every other outside host is still
// refused and reported. The runner itself never sets it.
const ALLOWED_HOST = String(process.env.FLOWCHAIN_AI_EVAL_ALLOW_HOST || '').trim().toLowerCase()

function targetOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first }
  if (typeof first === 'string') return { path: first }
  if (first && typeof first === 'object') return first.path ? { path: first.path } : { host: String(first.host ?? 'localhost'), port: first.port }
  return { host: 'localhost' }
}

if (!globalThis.__flowchainAiEvalOfflineGuard) {
  globalThis.__flowchainAiEvalOfflineGuard = true
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = targetOf(args)
    const host = String(target.host).toLowerCase()
    if (target.path || LOOPBACK.has(host) || (ALLOWED_HOST && host === ALLOWED_HOST)) return connect.apply(this, args)
    process.stderr.write(`${OFFLINE_GUARD_MARKER} ${target.host}:${target.port ?? ''}\n`)
    const error = Object.assign(new Error(`The AI evaluation runs offline; ${target.host} is not reachable.`), { code: 'AI_EVAL_OFFLINE' })
    process.nextTick(() => this.destroy(error))
    return this
  }
}
