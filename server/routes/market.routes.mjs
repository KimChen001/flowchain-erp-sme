let externalCache = { at: 0, data: null }

const marketPriceProvenance = {
  sourceType: 'workspace_snapshot',
  provider: 'workspace-market-signal',
  isDemo: false,
  isRealtime: false,
  confidence: 'workspace_snapshot',
  provenanceNote: 'Workspace market signal snapshot; not real-time market data',
}

const externalSignalProvenance = {
  sourceType: 'workspace_snapshot',
  provider: 'workspace-external-signal',
  isDemo: false,
  isRealtime: false,
  confidence: 'workspace_snapshot',
  provenanceNote: 'Workspace external signal snapshot; not real-time external intelligence',
}

export function buildWorkspaceMarketMeta(extra = {}) {
  return {
    provider: 'workspace-market-signal',
    isDemo: false,
    isRealtime: false,
    note: 'Workspace signal refresh only; no real external API was called.',
    ...extra,
  }
}

export function normalizeMarketPrice(item) {
  const asOfDate = item.asOfDate || item.asOf || 'workspace-snapshot'
  const source = String(item.source || '').replace(/UAT\s*行情数据|UAT行情样本|UAT行情刷新/g, '工作区行情快照')
  return {
    ...item,
    ...marketPriceProvenance,
    asOfDate,
    source,
  }
}

export function normalizeMarketSignal(item) {
  return {
    ...item,
    ...externalSignalProvenance,
  }
}

function workspaceMarketPrices() {
  const asOf = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return [
    {
      symbol: 'FE-ORE-62',
      name: '铁矿石 62%粉矿',
      category: '黑色原料',
      price: 828,
      unit: '元/吨',
      changePct: 1.18,
      direction: 'up',
      asOf,
      source: '工作区行情快照',
      procurementImpact: '影响钢结构件、铝型材替代方案和华东精工机械报价复核。',
    },
    {
      symbol: 'RB-HRB400E',
      name: '螺纹钢 HRB400E',
      category: '黑色成材',
      price: 3420,
      unit: '元/吨',
      changePct: 0.64,
      direction: 'up',
      asOf,
      source: '工作区行情快照',
      procurementImpact: '若连续上涨，建议锁定本周钢材采购报价并复核安全库存。',
    },
    {
      symbol: 'HC-Q235B',
      name: '热轧卷板 Q235B',
      category: '黑色成材',
      price: 3568,
      unit: '元/吨',
      changePct: -0.22,
      direction: 'down',
      asOf,
      source: '工作区行情快照',
      procurementImpact: '价格回落时可暂缓低优先级补采，优先处理高风险缺料订单。',
    },
    {
      symbol: 'AL-SHFE',
      name: '电解铝',
      category: '有色金属',
      price: 20480,
      unit: '元/吨',
      changePct: 0.35,
      direction: 'up',
      asOf,
      source: '工作区行情快照',
      procurementImpact: '关联 SKU-00287 铝合金型材，当前库存低于安全线，应优先补采。',
    },
    {
      symbol: 'CU-SHFE',
      name: '电解铜',
      category: '有色金属',
      price: 78260,
      unit: '元/吨',
      changePct: -0.48,
      direction: 'down',
      asOf,
      source: '工作区行情快照',
      procurementImpact: '可复核电气元件供应商报价，争取铜价回落带来的成本让利。',
    },
    {
      symbol: 'USD-CNY',
      name: '美元兑人民币',
      category: '汇率',
      price: 6.7694,
      unit: 'CNY',
      changePct: 0.12,
      direction: 'up',
      asOf,
      source: 'Frankfurter/缓存',
      procurementImpact: '美元计价进口件需确认报价有效期和锁汇策略。',
    },
  ].map(normalizeMarketPrice)
}

export function ensureMarketPrices(db) {
  if (!Array.isArray(db.marketPrices) || db.marketPrices.length === 0) {
    const prices = workspaceMarketPrices()
    db.marketPrices = prices
    return prices
  }
  return db.marketPrices.map(normalizeMarketPrice)
}

export function ensureMarketSignals(db) {
  if (!Array.isArray(db.marketSignals)) db.marketSignals = []
  return db.marketSignals.map(normalizeMarketSignal)
}

function findMarketPrices(question = '', db) {
  const prices = ensureMarketPrices(db)
  const q = String(question).toLowerCase()
  if (/铁|钢|黑色|螺纹|热轧|iron|steel/.test(q)) {
    return prices.filter((item) => /铁|钢|热轧|螺纹/.test(item.name + item.category))
  }
  if (/铝|aluminium|aluminum/.test(q)) return prices.filter((item) => /铝/.test(item.name))
  if (/铜|copper/.test(q)) return prices.filter((item) => /铜/.test(item.name))
  if (/美元|汇率|usd|cny/.test(q)) return prices.filter((item) => /美元|USD/.test(item.name + item.symbol))
  if (/价格|行情|市场/.test(q)) return prices.slice(0, 5)
  return []
}

export function marketPriceReply(question, db) {
  const matches = findMarketPrices(question, db)
  if (!matches.length) return null
  const lines = matches.map((item) => {
    const arrow = item.direction === 'up' ? '上涨' : item.direction === 'down' ? '下跌' : '持平'
    return `${item.name}: ${item.price}${item.unit}，${arrow} ${Math.abs(item.changePct)}%，${item.asOf}，${item.source}`
  })
  const impacts = matches.map((item) => `- ${item.procurementImpact}`).join('\n')
  return [
    '当前系统已有行情数据，可以回答这类问题。',
    lines.join('\n'),
    '',
    '采购影响建议:',
    impacts,
    '',
    '说明: 这是当前工作区行情快照，用于辅助采购复核；接入正式行情源前，应由人工结合交易所、钢联、卓创、Wind 或企业采购行情源复核。',
  ].join('\n')
}

function workspaceExternalNews() {
  return [
    {
      title: '产业链供应链安全与物流韧性成为采购风险关注点',
      url: 'workspace://external-signal/supply-chain-resilience',
      domain: 'workspace-external-signal',
      seendate: 'workspace-snapshot',
      sourcecountry: 'Global',
      ...externalSignalProvenance,
    },
    {
      title: '制造业企业继续关注核心零部件交期与合规要求',
      url: 'workspace://external-signal/component-lead-time',
      domain: 'workspace-external-signal',
      seendate: 'workspace-snapshot',
      sourcecountry: 'Global',
      ...externalSignalProvenance,
    },
  ]
}

export async function fetchExternalSignals() {
  const now = Date.now()
  if (externalCache.data && now - externalCache.at < 15 * 60 * 1000) return externalCache.data

  const fetchedAt = new Date(now).toISOString()
  const fx = {
    base: 'USD',
    date: 'workspace-snapshot',
    rates: {
      CNY: 6.7694,
      EUR: 0.92,
      JPY: 157.2,
    },
    ...externalSignalProvenance,
  }
  const news = workspaceExternalNews()
  const signals = [
    normalizeMarketSignal({
      type: 'fx',
      title: `USD/CNY ${fx.rates.CNY}`,
      severity: '低',
      value: `工作区汇率信号: USD/CNY=${fx.rates.CNY}, USD/EUR=${fx.rates.EUR}, USD/JPY=${fx.rates.JPY}`,
      recommendedAction: '检查美元计价采购合同和进口件报价有效期。',
    }),
    normalizeMarketSignal({
      type: 'news',
      title: '使用供应链风险主题工作区信号',
      severity: '低',
      value: news.map((item) => `${item.title} (${item.domain})`).join('；'),
      recommendedAction: '保留内部 ERP 风险判断，正式环境再接入经审批的外部信号源。',
    }),
  ]

  externalCache = {
    at: now,
    data: {
      fetchedAt,
      fx,
      news,
      signals,
      meta: buildWorkspaceMarketMeta({
        provider: 'workspace-external-signal',
        note: 'Workspace external signal only; no real external API was called.',
      }),
    },
  }
  return externalCache.data
}

export async function handleMarketRoute(ctx) {
  const { req, res, url, db, send, event } = ctx

  if (req.method === 'GET' && url.pathname === '/api/external-signals') {
    const external = await fetchExternalSignals()
    return send(res, 200, external)
  }

  if (req.method === 'GET' && url.pathname === '/api/market-prices') {
    const prices = ensureMarketPrices(db)
    return send(res, 200, {
      asOf: prices[0]?.asOf || null,
      source: '工作区行情数据',
      prices,
      meta: buildWorkspaceMarketMeta(),
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/market-prices/refresh') {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const prices = ensureMarketPrices(db).map((item, index) => {
      const wave = ((Date.now() / 1000 + index * 7) % 9 - 4) / 100
      const nextChange = Number((item.changePct + wave).toFixed(2))
      return normalizeMarketPrice({
        ...item,
        price: Number((item.price * (1 + wave / 100)).toFixed(item.price < 10 ? 4 : 0)),
        changePct: nextChange,
        direction: nextChange > 0 ? 'up' : nextChange < 0 ? 'down' : 'flat',
        asOf: now,
        source: item.source.includes('工作区') ? '工作区行情刷新' : item.source,
      })
    })
    db.marketPrices = prices
    event(db, 'market_prices_refresh', '行情数据已刷新', 'market-prices')
    throw Object.assign(new Error('Legacy market mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 200, {
      asOf: now,
      source: '工作区行情数据',
      prices,
      meta: buildWorkspaceMarketMeta(),
    })
  }

  return false
}
