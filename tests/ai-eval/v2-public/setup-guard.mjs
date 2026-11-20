// --setup writes records (a supplier reply pasted and dismissed) through the
// app's routes, so it never runs against the walkthrough people use: its app
// ports 15231/15232 and their APIs 18831/18832 are refused, whatever else is
// passed. A test instance runs on other ports (walkthrough:local defaults to
// 15201/18801).
export const WALKTHROUGH_DEMO_PORTS = Object.freeze([15231, 15232, 18831, 18832])

// Why --setup may not run against this port, or null when it may.
export function setupRefusal({ setup, port }) {
  if (!setup) return null
  const value = Number(port)
  if (WALKTHROUGH_DEMO_PORTS.includes(value)) return `--setup writes records, so it does not run against the walkthrough on port ${value}. Start a test instance on other ports.`
  return null
}
