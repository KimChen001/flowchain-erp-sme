export function buildWorkspaceMarketMeta(extra = {}) {
  return {
    provider: null,
    configured: false,
    isDemo: false,
    isRealtime: false,
    note: 'No external market-data provider is configured.',
    ...extra,
  }
}

export function normalizeMarketPrice(item = {}) {
  return {
    ...item,
    sourceType: item.sourceType || 'caller_supplied_preview',
    provider: item.provider || 'caller',
    isDemo: false,
    isRealtime: item.isRealtime === true,
    provenanceNote: item.provenanceNote || 'Caller-supplied preview input; not an authoritative workspace fact.',
  }
}

export function normalizeMarketSignal(item = {}) {
  return {
    ...item,
    sourceType: item.sourceType || 'caller_supplied_preview',
    provider: item.provider || 'caller',
    isDemo: false,
    isRealtime: item.isRealtime === true,
    provenanceNote: item.provenanceNote || 'Caller-supplied preview input; not an authoritative workspace fact.',
  }
}

export function ensureMarketPrices(db = {}) {
  return Array.isArray(db.marketPrices) ? db.marketPrices.map(normalizeMarketPrice) : []
}

export function ensureMarketSignals(db = {}) {
  return Array.isArray(db.marketSignals) ? db.marketSignals.map(normalizeMarketSignal) : []
}

export function marketPriceReply(question, db = {}) {
  const query = String(question || '').toLowerCase()
  const matches = ensureMarketPrices(db).filter((item) => {
    const searchable = `${item.symbol || ''} ${item.name || ''} ${item.category || ''}`.toLowerCase()
    return query && searchable && query.split(/\s+/).some((term) => term.length > 1 && searchable.includes(term))
  })
  if (matches.length === 0) return null
  return matches.map((item) => `${item.name || item.symbol}: ${item.price ?? ''}${item.unit || ''}`).join('\n')
}

export async function fetchExternalSignals() {
  return {
    fetchedAt: null,
    fx: null,
    news: [],
    signals: [],
    meta: buildWorkspaceMarketMeta(),
  }
}

export async function handleMarketRoute() {
  return false
}
