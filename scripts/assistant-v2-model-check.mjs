#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAssistantV2ModelClient } from '../server/domain/ai-assistant-v2-model/index.mjs'

// One short question with one small tool through the configured assistant v2
// model client (docs/ai-assistant-v2-design.md §3.4, §10 P1 day 1-2). When
// the model calls the tool, the result goes back for a second call, so the
// replay of the first call's content is exercised too. Prints, per call, the
// time to the first text, the total time, the stop reason and the token
// counts; never the key or the endpoint.
//
//   node scripts/assistant-v2-model-check.mjs --provider-env=<env file with FLOWCHAIN_AI_PROVIDER_*>
//   node scripts/assistant-v2-model-check.mjs     (reads the same settings from the environment)

// As in tests/ai-eval/run-eval.mjs: only the provider and assistant settings
// are taken from the file.
const PROVIDER_SETTING = /^(FLOWCHAIN_AI_PROVIDER_[A-Z_]+|FLOWCHAIN_AI_RUNTIME_MODE|FLOWCHAIN_AI_ASSISTANT_(?!MODE)[A-Z_]+)$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readProviderEnv(path) {
  if (!existsSync(path)) fail(`--provider-env: ${path} does not exist.`)
  const settings = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && PROVIDER_SETTING.test(match[1])) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return settings
}

const fileArgument = process.argv.slice(2).find((value) => value.startsWith('--provider-env='))
const env = { ...process.env, ...(fileArgument ? readProviderEnv(resolve(fileArgument.slice('--provider-env='.length))) : {}) }
let client
try {
  client = createAssistantV2ModelClient(env)
} catch (error) {
  fail(`The model client was refused: ${error.reason || error.message}.`)
}
if (!client) fail('No assistant model client is configured: set FLOWCHAIN_AI_RUNTIME_MODE=provider_assisted and the FLOWCHAIN_AI_PROVIDER_* settings, or FLOWCHAIN_AI_ASSISTANT_SCRIPTED.')

const system = 'You answer questions for a small business. Use the tools when they help. Answer in one short sentence.'
const tools = [{
  name: 'workspace_clock',
  description: "The workspace's current date and time.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
}]
const messages = [{ role: 'user', content: "What is today's date? Check the workspace clock." }]
const round = (value) => `${Math.round(value)} ms`

console.log(`Client: ${client.kind}, model ${client.model}`)
for (let call = 1; call <= 2; call += 1) {
  const started = performance.now()
  let firstText = null
  let answer = ''
  let end = null
  const calls = []
  try {
    for await (const event of client.stream({ system, messages, tools, maxTokens: 1000 }, AbortSignal.timeout(60_000))) {
      if (event.type === 'text_delta') {
        firstText ??= performance.now() - started
        answer += event.text
      } else if (event.type === 'tool_use_end') calls.push(event)
      else if (event.type === 'message_end') end = event
    }
  } catch (error) {
    fail(`Call ${call} failed: ${error.name}${error.reason ? ` ${error.reason}` : ''}${error.status ? ` ${error.status}` : ''}${error.errorType ? ` ${error.errorType}` : ''}.`)
  }
  console.log(`Call ${call}: first text ${firstText === null ? 'none' : round(firstText)}, total ${round(performance.now() - started)}, stop reason ${end.stopReason}`)
  console.log(`  usage ${JSON.stringify(end.usage)}`)
  if (calls.length) console.log(`  tools called: ${calls.map((entry) => entry.name).join(', ')}`)
  if (answer) console.log(`  text: ${answer.slice(0, 300)}`)
  if (end.stopReason !== 'tool_use' || !calls.length) break
  messages.push(
    { role: 'assistant', content: end.content },
    { role: 'user', content: calls.map((entry) => ({ type: 'tool_result', tool_use_id: entry.id, content: JSON.stringify({ now: new Date().toISOString() }) })) },
  )
}
