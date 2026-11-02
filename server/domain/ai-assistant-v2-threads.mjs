import { createHash } from 'node:crypto'

// Assistant v2 conversation state (docs/ai-assistant-v2-design.md §3.5): the
// transcript the loop replays and the tool results its UI tools render from,
// kept in this process's memory for P1 (a database store is decision V2-12).
//
// A thread belongs to one user in one workspace: it is keyed by
// tenantId:userId:threadId, so another user's thread id finds nothing. It
// expires 2 hours after its last answer and keeps at most 20 turns, the
// oldest dropped first. It also carries the permission fingerprint it was
// built under: when the user's permission codes or warehouse scope change, the
// thread is dropped, so a cached tool result never outlives a permission
// removal. The client sends only its thread id; history and refs from the
// client never authorize anything.

export const ASSISTANT_V2_THREAD_LIMITS = Object.freeze({ ttlMs: 2 * 60 * 60 * 1000, turns: 20 })

const text = (value) => String(value ?? '').trim()
const sorted = (values) => [...new Set([...(values || [])].map(text).filter(Boolean))].sort()

// sha256 over the actor's permission codes and warehouse scope.
export function assistantV2PermissionFingerprint(actor = {}) {
  const scope = {
    permissions: sorted(actor.permissionCodes),
    allWarehouses: actor.allWarehouses === true,
    readWarehouses: actor.readWarehouseIds ? sorted(actor.readWarehouseIds) : null,
    operateWarehouses: actor.operateWarehouseIds ? sorted(actor.operateWarehouseIds) : null,
  }
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex')
}

export function createAssistantV2ThreadStore({ now = () => Date.now(), limits = ASSISTANT_V2_THREAD_LIMITS } = {}) {
  const threads = new Map()
  // A thread with an answer running is never swept: the answer would write
  // into an orphaned entry, and a second request would find no busy thread.
  const sweep = (at) => {
    for (const [key, entry] of threads) if (!entry.busy && at - entry.usedAt >= limits.ttlMs) threads.delete(key)
  }
  return {
    // The thread for this user's thread id: the stored one when it is still
    // fresh and was built under the same permissions, else a new empty one.
    // While an answer runs on a thread, a second request on it gets a
    // detached copy that is never stored, so two answers never interleave in
    // one transcript.
    //
    // `forms` holds the forms whose created request the server confirmed
    // (formId → { purchaseRequestId, status }), shared with a detached copy so
    // a form is noted once; `note` adds one, with its message to the
    // transcript. A note taken on a detached copy is also added to the stored
    // transcript before its next answer, as the client reports each form once.
    open({ tenantId, userId, threadId, fingerprint }) {
      const at = now()
      sweep(at)
      const key = `${text(tenantId)}:${text(userId)}:${text(threadId)}`
      let entry = threads.get(key)
      if (entry && entry.fingerprint !== fingerprint) {
        threads.delete(key)
        entry = null
      }
      if (entry?.busy) {
        const stored = entry
        const thread = { messages: [], results: new Map() }
        return {
          thread,
          forms: stored.forms,
          detached: true,
          note(formId, form, message) {
            stored.forms.set(formId, form)
            stored.pendingNotes.push(message)
            thread.messages.push(message)
          },
          close() {},
        }
      }
      if (!entry) {
        entry = { fingerprint, usedAt: at, busy: false, turnStarts: [], forms: new Map(), pendingNotes: [], thread: { messages: [], results: new Map() } }
        threads.set(key, entry)
      }
      entry.busy = true
      entry.thread.messages.push(...entry.pendingNotes.splice(0))
      const start = entry.thread.messages.length
      return {
        thread: entry.thread,
        forms: entry.forms,
        detached: false,
        note(formId, form, message) {
          entry.forms.set(formId, form)
          entry.thread.messages.push(message)
        },
        // After the answer: the turn is counted when it added to the
        // transcript, and the oldest turns beyond the limit are dropped with
        // the tool results they held.
        close() {
          entry.busy = false
          entry.usedAt = now()
          if (entry.thread.messages.length > start) entry.turnStarts.push(start)
          while (entry.turnStarts.length > limits.turns) {
            const cut = entry.turnStarts[1]
            const dropped = entry.thread.messages.splice(0, cut)
            for (const message of dropped) {
              for (const block of Array.isArray(message.content) ? message.content : []) if (block?.type === 'tool_use') entry.thread.results.delete(block.id)
            }
            entry.turnStarts = entry.turnStarts.slice(1).map((index) => index - cut)
          }
        },
      }
    },
  }
}
