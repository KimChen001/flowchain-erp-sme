import {
  capabilityDisabledRoute,
  capabilityNotImplementedPayload,
} from '../domain/runtime-route-authority.mjs'

export function handleRuntimeCapabilityRoute({ req, res, url, send }) {
  const route = capabilityDisabledRoute(req.method, url.pathname)
  if (!route) return false
  send(res, 501, capabilityNotImplementedPayload(route))
  return true
}
