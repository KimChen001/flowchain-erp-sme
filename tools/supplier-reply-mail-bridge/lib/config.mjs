// The bridge's settings, from an env file kept OUTSIDE the FlowChain
// checkout: it holds a mailbox password and an integration token. Only
// FLOWCHAIN_MAIL_BRIDGE_* names are read, and nothing read is ever printed.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const inside = (path, folder) => path.toLowerCase() === folder.toLowerCase() || path.toLowerCase().startsWith(`${folder.toLowerCase()}${sep}`)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function parseBridgeEnv(textValue) {
  const env = {}
  for (const line of String(textValue ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(FLOWCHAIN_MAIL_BRIDGE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match) env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

// The settings from a file outside `checkout`.
export function readBridgeConfig(file, { checkout }) {
  const path = resolve(file)
  if (inside(path, resolve(checkout))) throw new Error('The config file must be outside the FlowChain checkout, so no password or token is ever kept in it.')
  return bridgeConfig(parseBridgeEnv(readFileSync(path, 'utf8')), { stateFile: join(dirname(path), 'flowchain-mail-bridge-state.json') })
}

// The settings, checked:
//   ENDPOINT        the FlowChain endpoint, e.g.
//                   http://localhost:18831/api/integrations/supplier-replies.
//                   The token goes only over https, or to this machine.
//   TOKEN           the workspace's integration token (fcsr.…), made by an admin.
//   IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASSWORD, IMAP_MAILBOX (INBOX),
//   IMAP_DONE_FOLDER (optional: sent messages are moved there)
//   ORDER_PREFIX    the order numbers' prefix (PO): only messages naming an
//                   order number (PO-202611-0012) are sent.
//   FROM            optional: only these senders (addresses or domains,
//                   comma-separated).
//   TIME_ZONE       the workspace's time zone, for the day a reply was
//                   received (default: this machine's).
//   STATE_FILE      where handled messages are remembered (default: next to
//                   the config file).
export function bridgeConfig(env, defaults = {}) {
  const value = (name) => String(env[`FLOWCHAIN_MAIL_BRIDGE_${name}`] ?? '').trim()
  let endpoint
  try { endpoint = new URL(value('ENDPOINT')) } catch { throw new Error('Set FLOWCHAIN_MAIL_BRIDGE_ENDPOINT to the FlowChain endpoint URL.') }
  if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && LOCAL_HOSTS.has(endpoint.hostname)))) throw new Error('The endpoint must use https, or be on this machine (localhost): the token is not sent in the clear.')
  const token = value('TOKEN')
  if (!token.startsWith('fcsr.')) throw new Error('Set FLOWCHAIN_MAIL_BRIDGE_TOKEN to the integration token (it starts with "fcsr.").')
  const orderPrefix = value('ORDER_PREFIX') || 'PO'
  if (!/^[A-Z][A-Z0-9]{0,9}$/i.test(orderPrefix)) throw new Error('FLOWCHAIN_MAIL_BRIDGE_ORDER_PREFIX is letters and digits, e.g. PO.')
  const timeZone = value('TIME_ZONE') || Intl.DateTimeFormat().resolvedOptions().timeZone
  try { new Intl.DateTimeFormat('en-CA', { timeZone }) } catch { throw new Error(`FLOWCHAIN_MAIL_BRIDGE_TIME_ZONE is not a time zone: ${timeZone}`) }
  const port = Number(value('IMAP_PORT') || 993)
  return {
    endpoint: endpoint.href,
    token,
    orderPrefix: orderPrefix.toUpperCase(),
    from: value('FROM').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    timeZone,
    stateFile: value('STATE_FILE') || defaults.stateFile || null,
    imap: {
      host: value('IMAP_HOST') || null,
      port: Number.isInteger(port) && port > 0 ? port : 993,
      user: value('IMAP_USER') || null,
      password: value('IMAP_PASSWORD') || null,
      mailbox: value('IMAP_MAILBOX') || 'INBOX',
      doneFolder: value('IMAP_DONE_FOLDER') || null,
    },
  }
}

// The IMAP settings are needed only when reading a mailbox.
export function requireImap(config) {
  const missing = ['host', 'user', 'password'].filter((key) => !config.imap[key])
  if (missing.length) throw new Error(`Set ${missing.map((key) => `FLOWCHAIN_MAIL_BRIDGE_IMAP_${key.toUpperCase()}`).join(', ')} to read a mailbox (or use --eml-dir).`)
  return config.imap
}
