import { withoutUnavailableProductLinks } from '../../shared/unavailable-product-routes.mjs'
import { buildAiSuggestionsWorkbenchV2 } from '../domain/ai-suggestions-workbench-v2.mjs'

export async function handleAiSuggestionsWorkbenchRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/ai-suggestions-workbench') {
    // No suggestion links into frozen or unavailable surfaces (such as the retired imports pages).
    send(res, 200, withoutUnavailableProductLinks(buildAiSuggestionsWorkbenchV2(db)))
    return true
  }

  return false
}
