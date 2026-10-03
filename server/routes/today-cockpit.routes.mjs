import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { buildTodayCockpit } from '../domain/today-cockpit-read-model.mjs'
import { buildOperationsControlTowerV2 } from '../domain/operations-control-tower-v2.mjs'

export async function handleTodayCockpitRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/today-cockpit') {
    send(res, 200, buildTodayCockpit(db))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/operations-control-tower') {
    send(res, 200, withoutUnavailableProductLinks(buildOperationsControlTowerV2(db)))
    return true
  }

  return false
}
