// Forwards supplier replies from a mailbox (or a folder of .eml files) to
// FlowChain's supplier-reply endpoint (POST /api/integrations/supplier-replies,
// with a workspace integration token). Each reply then goes through the same
// reading, checks and card as a pasted one, and a person records it.
//
//   node bridge.mjs --config=<env file> [--once] [--interval=60]
//   node bridge.mjs --config=<env file> --eml-dir=<folder>
//
// --config    the settings file, OUTSIDE the FlowChain checkout (it holds the
//             mailbox password and the token; README.md lists the names).
// --once      one round, then exit; otherwise a round every --interval seconds.
// --eml-dir   read .eml files from a folder instead of a mailbox (no account
//             needed): sent ones move to sent/, refused ones to refused/.
//
// Exit codes: 0 done, 1 a setting is wrong, 2 FlowChain refused the bridge.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBridgeConfig } from './lib/config.mjs'
import { openState } from './lib/forward.mjs'
import { BridgeStop, runFolder, runImap } from './lib/run.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(here, '..', '..')
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (line) => console.log(`${stamp()} ${line}`)

export function bridgeArgs(argv) {
  const args = Object.fromEntries(argv.map((arg) => arg.replace(/^--/, '').split('=')).map(([key, ...value]) => [key, value.join('=') || true]))
  if (!args.config || args.config === true) throw new Error('Give --config=<settings file outside the checkout>.')
  const interval = Number(args.interval ?? 60)
  if (!Number.isFinite(interval) || interval < 15) throw new Error('--interval is at least 15 seconds.')
  return { config: String(args.config), emlDir: args['eml-dir'] && args['eml-dir'] !== true ? String(args['eml-dir']) : null, once: Boolean(args.once), interval }
}

async function main() {
  const args = bridgeArgs(process.argv.slice(2))
  const config = readBridgeConfig(args.config, { checkout })
  const state = openState(config.stateFile)
  const { simpleParser } = await import('mailparser')
  const parse = (source) => simpleParser(source, { skipImageLinks: true, skipHtmlToText: false })
  const host = new URL(config.endpoint).host
  if (args.emlDir) {
    log(`reading ${resolve(args.emlDir)} → ${host}`)
    const counts = await runFolder({ dir: resolve(args.emlDir), config, parse, state, log })
    log(`done: ${JSON.stringify(counts)}`)
    return
  }
  const { ImapFlow } = await import('imapflow')
  log(`reading ${config.imap.user} (${config.imap.mailbox}) every ${args.once ? '—' : `${args.interval}s`} → ${host}`)
  let stopped = false
  process.on('SIGINT', () => { stopped = true; log('stopping after this round') })
  for (;;) {
    try {
      const counts = await runImap({ config, ImapFlow, parse, state, log })
      if (Object.values(counts).some(Boolean)) log(`round: ${JSON.stringify(counts)}`)
    } catch (error) {
      if (error instanceof BridgeStop) throw error
      log(`round failed: ${error?.message || error} (trying again next round)`)
    }
    if (args.once || stopped) return
    await new Promise((done) => setTimeout(done, args.interval * 1000))
    if (stopped) return
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${stamp()} ${error.message}`)
    process.exit(error instanceof BridgeStop ? 2 : 1)
  })
}
