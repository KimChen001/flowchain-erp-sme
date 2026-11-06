// Every model client fails the same way, so the assistant v2 loop needs no
// provider knowledge: a stopped call (the user pressed Stop, the request
// closed, or the answer ran out of time) throws an AbortError, and any other
// failure throws an AssistantModelError with one of the reason codes the
// gateway's notices already use and, for an HTTP reply, its status. An error
// the provider reports in the body (overloaded_error, api_error) keeps its type.
export class AssistantModelError extends Error {
  constructor(reason, { status, errorType, cause } = {}) {
    super(`The assistant's model call failed (${reason}${status ? ` ${status}` : ''}${errorType ? ` ${errorType}` : ''}).`, cause ? { cause } : undefined)
    this.name = 'AssistantModelError'
    this.reason = reason
    if (status) this.status = status
    if (errorType) this.errorType = errorType
    // 402: the provider's spending limit is reached.
    if (status === 402) this.budgetExceeded = true
  }
}

export const modelAbortError = () => new DOMException('The model call was stopped.', 'AbortError')
