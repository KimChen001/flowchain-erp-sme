import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { buildReviewFirstActionWorkflowV2 } from '../domain/review-first-action-workflow-v2.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'

export async function handleReviewFirstActionWorkflowRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/review-first-action-workflow') {
    // Overdue is judged on the workspace's calendar day (design audit L6-23).
    send(res, 200, withoutUnavailableProductLinks(buildReviewFirstActionWorkflowV2(db, { timeZone: await readTenantTimezone(ctx) })))
    return true
  }

  return false
}
