const mrpProfiles = {
  'SKU-00412': { allocated: 11, inbound: [0, 40, 0, 0, 30, 0], moq: 20, batchMultiple: 5, leadTimePeriods: 1, serviceLevel: 99, abc: 'A', xyz: 'X', supplier: '深圳新元电气', unitPrice: 2980, bomDemand: [18, 20, 22, 24, 20, 18] },
  'SKU-00623': { allocated: 6, inbound: [0, 20, 0, 0, 10, 0], moq: 10, batchMultiple: 5, leadTimePeriods: 1, serviceLevel: 99, abc: 'A', xyz: 'Y', supplier: '深圳新元电气', unitPrice: 12400, bomDemand: [6, 8, 10, 10, 8, 6] },
  'SKU-00287': { allocated: 180, inbound: [500, 0, 0, 300, 0, 0], moq: 500, batchMultiple: 100, leadTimePeriods: 2, serviceLevel: 97, abc: 'A', xyz: 'Y', supplier: '江苏铝合金集团', unitPrice: 142, bomDemand: [120, 140, 150, 160, 150, 130] },
  'SKU-00142': { allocated: 120, inbound: [300, 0, 0, 0, 0, 0], moq: 200, batchMultiple: 50, leadTimePeriods: 1, serviceLevel: 95, abc: 'B', xyz: 'X', supplier: '华东精工机械', unitPrice: 86, bomDemand: [80, 90, 100, 100, 90, 80] },
  'SKU-00815': { allocated: 18, inbound: [0, 0, 40, 0, 0, 0], moq: 20, batchMultiple: 5, leadTimePeriods: 2, serviceLevel: 95, abc: 'B', xyz: 'Y', supplier: '华东精工机械', unitPrice: 4600, bomDemand: [12, 14, 16, 18, 16, 14] },
  'SKU-00744': { allocated: 80, inbound: [600, 0, 0, 0, 0, 0], moq: 200, batchMultiple: 50, leadTimePeriods: 1, serviceLevel: 92, abc: 'C', xyz: 'Y', supplier: '广州化工耗材', unitPrice: 320, bomDemand: [20, 20, 24, 24, 22, 20] },
}

const bomMaster = {
  'FG-ROBOT-ARM': {
    name: '工业机器人关节模组',
    unit: '套',
    demand: [18, 20, 22, 24, 22, 20],
    children: [
      { sku: 'SA-DRIVE-KIT', qty: 1, scrapPct: 0.02, leadTimeOffset: 0 },
      { sku: 'SKU-00623', qty: 1, scrapPct: 0.01, leadTimeOffset: 0 },
      { sku: 'SKU-00287', qty: 4, scrapPct: 0.03, leadTimeOffset: 0 },
      { sku: 'SKU-00142', qty: 2, scrapPct: 0.02, leadTimeOffset: 0 },
    ],
  },
  'SA-DRIVE-KIT': {
    name: '伺服驱动套件',
    unit: '套',
    phantom: true,
    children: [
      { sku: 'SKU-00412', qty: 2, scrapPct: 0.02, leadTimeOffset: 0 },
      { sku: 'SKU-00815', qty: 1, scrapPct: 0.01, leadTimeOffset: 1 },
      { sku: 'SKU-00744', qty: 0.4, scrapPct: 0.05, leadTimeOffset: 0 },
    ],
  },
  'FG-HYDRAULIC-STATION': {
    name: '液压工装站',
    unit: '套',
    demand: [8, 10, 12, 12, 10, 9],
    children: [
      { sku: 'SKU-00815', qty: 3, scrapPct: 0.01, leadTimeOffset: 0 },
      { sku: 'SKU-00287', qty: 6, scrapPct: 0.02, leadTimeOffset: 0 },
      { sku: 'SKU-00744', qty: 0.8, scrapPct: 0.03, leadTimeOffset: 0 },
    ],
  },
}

const MRP_SOURCE_METADATA = Object.freeze({
  generatedFrom: 'json-products-plus-static-planning-profile',
  productSource: 'postgresql:item-master',
  demoPlanningProfile: 'server/routes/mrp.routes.mjs:mrpProfiles',
  staticBomSource: 'server/routes/mrp.routes.mjs:bomMaster',
  persistence: 'read-only-generated-plan',
})

export function roundUpToBatch(value, moq, batchMultiple) {
  if (value <= 0) return 0
  const safeMoq = Math.max(0, Number(moq) || 0)
  const safeMultiple = Math.max(1, Number(batchMultiple) || 1)
  return Math.ceil(Math.max(value, safeMoq) / safeMultiple) * safeMultiple
}

export function futureMonthLabels(periods = 6) {
  return Array.from({ length: periods }, (_, index) => {
    const total = 2026 * 12 + 5 + index
    return `${String(Math.floor(total / 12)).slice(-2)}/${(total % 12) + 1}月`
  })
}

export function calculateNetRequirement({
  projectedAvailable = 0,
  scheduledReceipt = 0,
  grossRequirement = 0,
  safetyStock = 0,
} = {}) {
  const availableBeforePlanning = Number(projectedAvailable || 0) + Number(scheduledReceipt || 0) - Number(grossRequirement || 0)
  const netRequirement = Math.max(0, Number(safetyStock || 0) - availableBeforePlanning)
  return { availableBeforePlanning, netRequirement }
}

export function plannedReleasePeriodFor(periodIndex, leadTimePeriods, labels = []) {
  const releaseIndex = Number(periodIndex || 0) - Number(leadTimePeriods || 1)
  return releaseIndex >= 0 ? labels[releaseIndex] : '立即释放'
}

export function classifyMrpException({
  plannedReceipt = 0,
  periodIndex = 0,
  leadTimePeriods = 1,
  availableBeforePlanning = 0,
  safetyStock = 0,
  monthlyDemand = 0,
} = {}) {
  const releaseIndex = Number(periodIndex || 0) - Number(leadTimePeriods || 1)
  if (plannedReceipt > 0 && releaseIndex < 0) return '加急'
  if (plannedReceipt > 0) return '释放'
  if (availableBeforePlanning > Number(safetyStock || 0) + Number(monthlyDemand || 0) * 1.5) return '推迟/取消'
  return '正常'
}

function createBomBucket(periods) {
  return {
    total: Array.from({ length: periods }, () => 0),
    sourcesByPeriod: Array.from({ length: periods }, () => []),
    parents: new Map(),
  }
}

function addBomDemand(target, sku, periodIndex, quantity, source, periods) {
  if (!target.has(sku)) target.set(sku, createBomBucket(periods))
  const bucket = target.get(sku)
  bucket.total[periodIndex] += quantity
  bucket.sourcesByPeriod[periodIndex].push({
    ...source,
    demand: quantity,
    quantityContribution: quantity,
    requirementPeriodIndex: periodIndex,
  })

  const parentKey = `${source.parent}|${source.top}`
  const previous = bucket.parents.get(parentKey) || {
    parent: source.parent,
    parentName: source.parentName,
    top: source.top,
    topName: source.topName,
    level: source.level,
    qtyPer: source.qtyPer,
    scrapPct: source.scrapPct,
    leadTimeOffset: source.leadTimeOffset,
    sourcePeriods: [],
    demand: 0,
  }
  previous.demand += quantity
  previous.level = Math.min(previous.level, source.level)
  if (!previous.sourcePeriods.includes(periodIndex)) previous.sourcePeriods.push(periodIndex)
  bucket.parents.set(parentKey, previous)
}

function explodeBomChildren(parentSku, demandByPeriod, output, periods, trail = []) {
  const parent = bomMaster[parentSku]
  if (!parent?.children?.length) return

  const topSku = trail[0]?.sku || parentSku
  const topName = trail[0]?.name || parent.name || parentSku

  parent.children.forEach((child) => {
    const childDemand = Array.from({ length: periods }, () => 0)

    demandByPeriod.slice(0, periods).forEach((parentDemand, periodIndex) => {
      if (!parentDemand) return
      const requiredPeriod = Math.max(0, Math.min(periods - 1, periodIndex - Number(child.leadTimeOffset || 0)))
      const requiredQty = Math.ceil(Number(parentDemand || 0) * Number(child.qty || 0) * (1 + Number(child.scrapPct || 0)))
      if (requiredQty <= 0) return
      childDemand[requiredPeriod] += requiredQty
      addBomDemand(output, child.sku, requiredPeriod, requiredQty, {
        parent: parentSku,
        parentName: parent.name || parentSku,
        top: topSku,
        topName,
        level: trail.length,
        qtyPer: Number(child.qty || 0),
        scrapPct: Number(child.scrapPct || 0),
        leadTimeOffset: Number(child.leadTimeOffset || 0),
        sourcePeriodIndex: periodIndex,
      }, periods)
    })

    if (bomMaster[child.sku]?.children?.length) {
      explodeBomChildren(child.sku, childDemand, output, periods, [...trail, { sku: parentSku, name: parent.name || parentSku }])
    }
  })
}

function buildBomExplosion(periods) {
  const output = new Map()
  Object.entries(bomMaster)
    .filter(([, item]) => Array.isArray(item.demand))
    .forEach(([sku, item]) => {
      explodeBomChildren(sku, item.demand, output, periods, [{ sku, name: item.name || sku }])
    })

  for (const bucket of output.values()) {
    bucket.total = bucket.total.map((value) => Math.round(value))
    bucket.sourcesByPeriod = bucket.sourcesByPeriod.map((sources) => sources
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 4))
    bucket.summary = Array.from(bucket.parents.values())
      .sort((a, b) => b.demand - a.demand)
      .slice(0, 6)
  }

  return output
}

export function buildMrpPlan(db, options = {}) {
  const periods = Math.max(1, Math.min(12, Number(options.periods || 6)))
  const labels = futureMonthLabels(periods)
  const skuFilter = options.sku ? new Set(String(options.sku).split(',').map((item) => item.trim()).filter(Boolean)) : null
  const products = (db.products || []).filter((product) => !skuFilter || skuFilter.has(product.sku))
  const bomExplosion = buildBomExplosion(periods)

  const rows = products.map((product) => {
    const profile = mrpProfiles[product.sku] || {
      allocated: 0,
      inbound: [],
      moq: 1,
      batchMultiple: 1,
      leadTimePeriods: 1,
      serviceLevel: 92,
      abc: 'B',
      xyz: 'Y',
      supplier: '',
      unitPrice: 0,
      bomDemand: [],
    }
    const profileSource = mrpProfiles[product.sku] ? 'static-profile' : 'default-profile'
    const bomBucket = bomExplosion.get(product.sku)
    const monthlyDemand = Number(product.monthlyDemand || 0)
    const safetyStock = Number(product.safetyStock || 0)
    let projected = Number(product.currentStock || 0) - Number(profile.allocated || 0)
    const schedule = []
    let firstShortagePeriod = null
    let maxNetRequirement = 0
    let totalPlannedReceipt = 0

    for (let index = 0; index < periods; index += 1) {
      const seasonalFactor = 1 + Math.sin((index / 6) * Math.PI) * 0.08
      const independentDemand = Math.max(0, Math.round(monthlyDemand * seasonalFactor))
      const dependentDemand = Number(bomBucket?.total?.[index] ?? profile.bomDemand?.[index] ?? 0)
      const grossRequirement = independentDemand + dependentDemand
      const scheduledReceipt = Number(profile.inbound?.[index] || 0)
      const { availableBeforePlanning, netRequirement } = calculateNetRequirement({
        projectedAvailable: projected,
        scheduledReceipt,
        grossRequirement,
        safetyStock,
      })
      const plannedReceipt = roundUpToBatch(netRequirement, Number(profile.moq || 1), Number(profile.batchMultiple || 1))
      const plannedReleasePeriod = plannedReleasePeriodFor(index, Number(profile.leadTimePeriods || 1), labels)
      const exception = classifyMrpException({
        plannedReceipt,
        periodIndex: index,
        leadTimePeriods: Number(profile.leadTimePeriods || 1),
        availableBeforePlanning,
        safetyStock,
        monthlyDemand,
      })

      projected = availableBeforePlanning + plannedReceipt
      if (firstShortagePeriod === null && plannedReceipt > 0) firstShortagePeriod = labels[index]
      maxNetRequirement = Math.max(maxNetRequirement, netRequirement)
      totalPlannedReceipt += plannedReceipt

      schedule.push({
        period: labels[index],
        grossRequirement,
        independentDemand,
        dependentDemand,
        scheduledReceipt,
        inventoryPositionBeforePlanning: Math.round(availableBeforePlanning),
        projectedAvailable: Math.round(projected),
        netRequirement: Math.round(netRequirement),
        plannedReceipt,
        plannedRelease: plannedReceipt,
        releasePeriod: plannedReleasePeriod,
        plannedReleasePeriod,
        exception,
        generatedFrom: MRP_SOURCE_METADATA.generatedFrom,
        bomSource: bomBucket ? MRP_SOURCE_METADATA.staticBomSource : 'none',
        dependentDemandSources: bomBucket?.sourcesByPeriod?.[index] || [],
      })
    }

    const exceptionSummary = schedule.find((item) => item.exception === '加急') ? '加急'
      : schedule.find((item) => item.exception === '释放') ? '释放'
        : schedule.find((item) => item.exception === '推迟/取消') ? '推迟/取消'
          : '正常'

    return {
      sku: product.sku,
      name: product.name,
      category: product.category,
      unit: product.unit,
      supplier: profile.supplier,
      unitPrice: profile.unitPrice,
      serviceLevel: profile.serviceLevel,
      abc: profile.abc,
      xyz: profile.xyz,
      onHand: Number(product.currentStock || 0),
      allocated: Number(profile.allocated || 0),
      safetyStock,
      moq: Number(profile.moq || 1),
      batchMultiple: Number(profile.batchMultiple || 1),
      leadTimePeriods: Number(profile.leadTimePeriods || 1),
      totalPlannedReceipt,
      firstShortagePeriod,
      maxNetRequirement: Math.round(maxNetRequirement),
      amount: totalPlannedReceipt * Number(profile.unitPrice || 0),
      exception: exceptionSummary,
      sourceMetadata: {
        ...MRP_SOURCE_METADATA,
        profileSource,
        hasStaticBom: Boolean(bomBucket),
      },
      bomSources: bomBucket?.summary || [],
      schedule,
    }
  })

  const exceptions = rows
    .filter((row) => row.exception !== '正常')
    .map((row) => ({
      sku: row.sku,
      name: row.name,
      type: row.exception,
      period: row.firstShortagePeriod || row.schedule.find((item) => item.exception !== '正常')?.period || labels[0],
      quantity: row.totalPlannedReceipt,
      amount: row.amount,
      action: row.exception === '加急'
        ? '立即释放计划订单，并复核供应商交期'
        : row.exception === '释放'
          ? '按提前期释放计划订单'
          : '检查在途订单是否可推迟或取消',
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    generatedAt: new Date().toISOString(),
    sourceMetadata: MRP_SOURCE_METADATA,
    horizon: periods,
    periods: labels,
    summary: {
      skuCount: rows.length,
      exceptionCount: exceptions.length,
      urgentCount: exceptions.filter((item) => item.type === '加急').length,
      plannedAmount: rows.reduce((sum, row) => sum + row.amount, 0),
      plannedQty: rows.reduce((sum, row) => sum + row.totalPlannedReceipt, 0),
      bomRootCount: Object.values(bomMaster).filter((item) => Array.isArray(item.demand)).length,
      bomComponentCount: bomExplosion.size,
    },
    rows,
    exceptions,
  }
}

export async function handleMrpRoute(ctx) {
  const { req, res, url, db, send } = ctx

  if (req.method === 'GET' && url.pathname === '/api/mrp-plan') {
    return send(res, 200, buildMrpPlan(db, {
      sku: url.searchParams.get('sku') || '',
      periods: Number(url.searchParams.get('periods') || 6),
    }))
  }

  return false
}
