import { validateAiToolArgs } from './ai-read-tool-contract.mjs'
import { AI_READ_TOOLS } from './ai-read-tools.mjs'

// The tools the model-first loop offers (docs/ai-model-first-design.md §3–§4):
// only those the asking user's facts can serve, described in the provider's
// format, and run through one door that checks the arguments and the user's
// access again. The loop (S2) hands every result back to the model and keeps
// the refs for the grounding check and the record links. (The older
// ai-tool-registry.mjs serves the legacy /api/ai route and is unrelated.)

export function aiReadToolsFor(facts) {
  if (!facts) return []
  return AI_READ_TOOLS.filter((tool) => tool.available(facts))
}

// The tool definitions for a provider: Anthropic's Messages API
// ({ name, description, input_schema }) or chat completions
// ({ type: 'function', function: { name, description, parameters } }).
export function aiReadToolDefinitions(facts, { format = 'anthropic' } = {}) {
  return aiReadToolsFor(facts).map((tool) => (format === 'chat_completions'
    ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }
    : { name: tool.name, description: tool.description, input_schema: tool.schema }))
}

// Runs one tool call as the asking user. Returns { ok: true, result } or
// { ok: false, error, details? }. An error is handed back to the model as the
// tool's result, so it can correct the call or say what it could not read.
export async function runAiReadTool(name, args, { facts } = {}) {
  const tool = AI_READ_TOOLS.find((entry) => entry.name === name)
  if (!tool) return { ok: false, error: 'unknown_tool' }
  if (!facts || !tool.available(facts)) return { ok: false, error: 'not_allowed' }
  const checked = validateAiToolArgs(tool.schema, args)
  if (!checked.ok) return { ok: false, error: 'invalid_arguments', details: checked.errors }
  try {
    const result = await tool.run(checked.args, { facts })
    if (result?.error) {
      const { error, candidates, details, order } = result
      return { ok: false, error, ...(candidates ? { candidates } : {}), ...(details ? { details } : {}), ...(order ? { order } : {}) }
    }
    return { ok: true, result }
  } catch {
    return { ok: false, error: 'tool_failed' }
  }
}

// Every ref ({ type, id, label }) in a tool result, once each, for the record
// links and the grounding check.
export function aiReadToolRefs(result) {
  const refs = []
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (value.ref && typeof value.ref === 'object' && value.ref.type && value.ref.id) refs.push(value.ref)
    for (const [key, entry] of Object.entries(value)) if (key !== 'ref') walk(entry)
  }
  walk(result)
  const seen = new Set()
  return refs.filter((ref) => !seen.has(`${ref.type}:${ref.id}`) && seen.add(`${ref.type}:${ref.id}`))
}
