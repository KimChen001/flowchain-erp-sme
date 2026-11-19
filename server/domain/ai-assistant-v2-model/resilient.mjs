import { AssistantModelError, modelAbortError } from './model-error.mjs'

// Every v2 model call a provider client makes goes through here: a call that
// fails before its first event is tried once more after a short pause, when
// the failure looks passing (a dropped connection, 408, 429, 5xx, an
// overloaded reply) and the answer still has time; and every call that fails,
// is stopped, or takes long writes one JSON line to the server log, with no
// prompt text and no key (2026-11-09 on Flash: 2 of 20 probe answers came back
// in about 1 s as unavailable, with nothing in the log to say why).
export const MODEL_CALL_RETRY = Object.freeze({
  // The pause before the second try.
  backoffMs: 1500,
  // A second try starts only if the answer has this much time left after the
  // pause, so a slow retry does not end in the answer's own timeout instead.
  minTimeLeftMs: 15000,
  // A completed call this slow is logged too.
  slowMs: 20000,
  // A try with no first event this long is ended and tried again (Flash's
  // slowest first event in 99 calls on 2026-11-09 was 15.1 s).
  firstEventMs: 20000,
  // The wait for a first event ends this long before the answer's deadline.
  deadlineMarginMs: 1500,
})

const TRANSIENT_ERROR_TYPE = /overload|rate.?limit|too.?many|timeout|unavailable|server.?error|internal|api.?error|bad.?gateway/i

// Whether a failed call is worth one more try. Authentication, the spending
// limit (402) and other 4xx replies are not: they fail the same way again.
export function transientModelError(error) {
  if (!(error instanceof AssistantModelError) || error.budgetExceeded) return false
  // A dropped connection, a reply cut short before anything arrived, or no
  // first event in time.
  if (['network_error', 'malformed_output', 'first_event_timeout'].includes(error.reason)) return true
  if (error.reason !== 'non_success_status') return false
  if (error.status) return error.status === 408 || error.status === 429 || error.status >= 500
  // An error the provider reported in the body of a 200 reply.
  return TRANSIENT_ERROR_TYPE.test(error.errorType || '')
}

const isAbort = (error) => error?.name === 'AbortError'
const clipped = (value, max) => String(value ?? '').slice(0, max) || undefined

// What a log line says about a failure: codes only, never a message that
// could carry the endpoint or the prompt.
function failureFields(error) {
  if (isAbort(error)) return { reason: 'stopped' }
  if (!(error instanceof AssistantModelError)) return { reason: 'client_error', errorClass: clipped(error?.name || typeof error, 40) }
  const cause = error.cause
  return {
    reason: error.reason,
    ...(error.status ? { status: error.status } : {}),
    ...(error.errorType ? { errorType: clipped(error.errorType, 60) } : {}),
    ...(cause ? { cause: clipped(cause.cause?.code || cause.code || cause.name, 40) } : {}),
  }
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(modelAbortError()); return }
    const onAbort = () => { clearTimeout(timer); reject(modelAbortError()) }
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

// The client with the same stream(request, signal) method, which also takes
// { deadline } (epoch ms, when the answer runs out of time) as a third
// argument. Only a call that failed before yielding anything is tried again,
// so nothing was shown or run for it.
export function withModelCallRetry(client, { provider = null, logger = console, retry: overrides = {}, now = Date.now } = {}) {
  if (!client || typeof client.stream !== 'function') return client
  const retry = { ...MODEL_CALL_RETRY, ...overrides }
  const log = (fields) => {
    try { logger?.warn?.(JSON.stringify({ event: 'assistant_v2_model_call', provider, model: client.model || null, ...fields })) } catch { /* the answer goes on */ }
  }
  return {
    ...client,
    async *stream(request, signal, { deadline = null } = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const started = now()
        // Each try has its own signal, so a try that never starts can be
        // ended without stopping the answer; the answer's signal ends it too.
        const trying = new AbortController()
        const onStop = () => trying.abort()
        if (signal?.aborted) trying.abort()
        else signal?.addEventListener?.('abort', onStop, { once: true })
        const events = client.stream(request, trying.signal)
        // No first event in time: the try is ended and counts as a passing
        // failure. The wait ends before the answer's own deadline, so a last
        // failure still reaches the "try again" notice (2026-11-09 on Flash:
        // a call with no first event for 74 s came back as an empty answer).
        const wait = Math.max(0, Math.min(retry.firstEventMs, Number.isFinite(deadline) ? deadline - now() - retry.deadlineMarginMs : Infinity))
        let timer
        const noFirstEvent = new Promise((_, reject) => {
          timer = setTimeout(() => {
            trying.abort()
            reject(new AssistantModelError('first_event_timeout'))
          }, wait)
        })
        let first
        try {
          first = await Promise.race([events.next(), noFirstEvent])
        } catch (error) {
          signal?.removeEventListener?.('abort', onStop)
          // A try ended for its wait is let go without waiting on it.
          if (error?.reason === 'first_event_timeout') events.return?.().catch(() => {})
          const fields = { attempt, durationMs: now() - started, phase: 'before_first_event', ...failureFields(error) }
          const timeLeft = !Number.isFinite(deadline) || now() + retry.backoffMs + retry.minTimeLeftMs <= deadline
          if (attempt === 1 && !signal?.aborted && transientModelError(error) && timeLeft) {
            log({ outcome: 'retrying', ...fields })
            await pause(retry.backoffMs, signal)
            continue
          }
          log({ outcome: isAbort(error) ? 'stopped' : 'failed', ...fields })
          throw error
        } finally {
          clearTimeout(timer)
        }
        const firstEventMs = now() - started
        try {
          if (!first.done) {
            yield first.value
            for (;;) {
              const next = await events.next()
              if (next.done) break
              yield next.value
            }
          }
        } catch (error) {
          log({ outcome: isAbort(error) ? 'stopped' : 'failed', attempt, durationMs: now() - started, firstEventMs, phase: 'streaming', ...failureFields(error) })
          throw error
        } finally {
          signal?.removeEventListener?.('abort', onStop)
          await events.return?.()
        }
        const durationMs = now() - started
        if (durationMs >= retry.slowMs) log({ outcome: 'slow', attempt, durationMs, firstEventMs })
        return
      }
    },
  }
}
