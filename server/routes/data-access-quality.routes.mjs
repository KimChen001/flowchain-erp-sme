import { buildDataAccessQualityV2 } from '../domain/data-access-quality-v2.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'

export async function handleDataAccessQualityRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/data-access-quality') {
    send(res, 200, buildDataAccessQualityV2(db, { timeZone: await readTenantTimezone(ctx) }))
    return true
  }

  return false
}
