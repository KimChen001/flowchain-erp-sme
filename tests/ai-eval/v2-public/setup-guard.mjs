// --setup writes records (a supplier reply pasted and dismissed) through the
// app's routes, so it never runs against the walkthrough people use: its app
// ports 15231/15232 and their APIs 18831/18832 are refused, whatever else is
// passed. A test instance runs on other ports (walkthrough:local defaults to
// 15201/18801).
export const WALKTHROUGH_DEMO_PORTS = Object.freeze([15231, 15232, 18831, 18832])

// Why --setup may not run against this server, or null when it may. The port
// is read the way the runner's requests read it, from the base URL it builds
// (http://127.0.0.1:<port>), so "15231/", "15231#" or "15231?x" is the
// walkthrough's port too; a value that does not make a URL is refused.
export function setupRefusal({ setup, port }) {
  if (!setup) return null
  let url
  try { url = new URL(`http://127.0.0.1:${port}`) } catch { return `--setup needs a test instance's port; "${port}" is not one.` }
  const value = Number(url.port || 80)
  if (WALKTHROUGH_DEMO_PORTS.includes(value)) return `--setup writes records, so it does not run against the walkthrough on port ${value}. Start a test instance on other ports.`
  return null
}
