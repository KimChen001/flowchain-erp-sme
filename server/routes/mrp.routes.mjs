const MRP_SOURCE_METADATA = Object.freeze({
  generatedFrom: 'caller-supplied-preview-input',
  productSource: 'caller-supplied-or-authoritative-read-model',
  planningProfileSource: 'explicit-input-only',
  bomSource: 'explicit-input-only',
  persistence: 'none',
})

export function roundUpToBatch(value, moq, batchMultiple) {
  if (value <= 0) return 0
  const safeMoq = Math.max(0, Number(moq) || 0)
  const safeMultiple = Math.max(1, Number(batchMultiple) || 1)
  return Math.ceil(Math.max(value, safeMoq) / safeMultiple) * safeMultiple
}

export function futureMonthLabels(periods = 6, startDate = new Date()) {
  const startYear = startDate.getUTCFullYear()
  const startMonth = startDate.getUTCMonth()
  return Array.from({ length: periods }, (_, index) => {
    const date = new Date(Date.UTC(startYear, startMonth + index, 1))
    return `${String(date.getUTCFullYear()).slice(-2)}/${date.getUTCMonth() + 1}月`
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

export function buildMrpPlan(input = {}, options = {}) {
  const periods = Math.max(1, Math.min(12, Number(options.periods || 6)))
  const labels = futureMonthLabels(periods, options.startDate)
  const profiles = options.profiles && typeof options.profiles === 'object' ? options.profiles : {}
  const explicitBomDemand = options.bomDemand && typeof options.bomDemand === 'object' ? options.bomDemand : {}
  const products = Array.isArray(options.products)
    ? options.products
    : Array.isArray(input.products)
      ? input.products
      : []
  const skuFilter = options.sku
    ? new Set(String(options.sku).split(',').map((item) => item.trim()).filter(Boolean))
    : null

  const rows = products
    .filter((product) => !skuFilter || skuFilter.has(product.sku))
    .map((product) => {
      const profile = profiles[product.sku] || {}
      const monthlyDemand = Number(product.monthlyDemand || 0)
      const safetyStock = Number(product.safetyStock || 0)
      const leadTimePeriods = Math.max(1, Number(profile.leadTimePeriods || 1))
      const moq = Math.max(1, Number(profile.moq || 1))
      const batchMultiple = Math.max(1, Number(profile.batchMultiple || 1))
      let projected = Number(product.currentStock || 0) - Number(profile.allocated || 0)
      let totalPlannedReceipt = 0
      let firstShortagePeriod = null
      let maxNetRequirement = 0
      const schedule = labels.map((period, index) => {
        const independentDemand = Math.max(0, Number(profile.demand?.[index] ?? monthlyDemand))
        const dependentDemand = Math.max(0, Number(explicitBomDemand[product.sku]?.[index] || 0))
        const grossRequirement = independentDemand + dependentDemand
        const scheduledReceipt = Math.max(0, Number(profile.inbound?.[index] || 0))
        const { availableBeforePlanning, netRequirement } = calculateNetRequirement({
          projectedAvailable: projected,
          scheduledReceipt,
          grossRequirement,
          safetyStock,
        })
        const plannedReceipt = roundUpToBatch(netRequirement, moq, batchMultiple)
        const exception = classifyMrpException({
          plannedReceipt,
          periodIndex: index,
          leadTimePeriods,
          availableBeforePlanning,
          safetyStock,
          monthlyDemand,
        })
        projected = availableBeforePlanning + plannedReceipt
        totalPlannedReceipt += plannedReceipt
        maxNetRequirement = Math.max(maxNetRequirement, netRequirement)
        if (firstShortagePeriod === null && plannedReceipt > 0) firstShortagePeriod = period
        return {
          period,
          grossRequirement,
          independentDemand,
          dependentDemand,
          scheduledReceipt,
          inventoryPositionBeforePlanning: availableBeforePlanning,
          projectedAvailable: projected,
          netRequirement,
          plannedReceipt,
          plannedRelease: plannedReceipt,
          releasePeriod: plannedReleasePeriodFor(index, leadTimePeriods, labels),
          plannedReleasePeriod: plannedReleasePeriodFor(index, leadTimePeriods, labels),
          exception,
          generatedFrom: MRP_SOURCE_METADATA.generatedFrom,
          dependentDemandSources: [],
        }
      })
      const exception = schedule.some((item) => item.exception === '加急') ? '加急'
        : schedule.some((item) => item.exception === '释放') ? '释放'
          : schedule.some((item) => item.exception === '推迟/取消') ? '推迟/取消'
            : '正常'
      return {
        sku: product.sku,
        name: product.name,
        category: product.category,
        unit: product.unit,
        supplier: profile.supplier || '',
        unitPrice: Number(profile.unitPrice || 0),
        serviceLevel: Number(profile.serviceLevel || 0),
        abc: profile.abc || '',
        xyz: profile.xyz || '',
        onHand: Number(product.currentStock || 0),
        allocated: Number(profile.allocated || 0),
        safetyStock,
        moq,
        batchMultiple,
        leadTimePeriods,
        totalPlannedReceipt,
        firstShortagePeriod,
        maxNetRequirement,
        amount: totalPlannedReceipt * Number(profile.unitPrice || 0),
        exception,
        sourceMetadata: MRP_SOURCE_METADATA,
        bomSources: [],
        schedule,
      }
    })

  const exceptions = rows.filter((row) => row.exception !== '正常').map((row) => ({
    sku: row.sku,
    name: row.name,
    type: row.exception,
    period: row.firstShortagePeriod || labels[0],
    quantity: row.totalPlannedReceipt,
    amount: row.amount,
    action: '人工复核显式 preview 输入后再采取行动',
  }))

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
      bomRootCount: 0,
      bomComponentCount: Object.keys(explicitBomDemand).length,
    },
    rows,
    exceptions,
  }
}

export async function handleMrpRoute() {
  return false
}
