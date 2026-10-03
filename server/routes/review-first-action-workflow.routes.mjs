import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { buildReviewFirstActionWorkflowV2 } from '../domain/review-first-action-workflow-v2.mjs'

export async function handleReviewFirstActionWorkflowRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/review-first-action-workflow') {
    send(res, 200, withoutUnavailableProductLinks(buildReviewFirstActionWorkflowV2(db)))
    return true
  }

  return false
}
