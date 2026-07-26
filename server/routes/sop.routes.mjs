import { buildMrpPlan } from './mrp.routes.mjs'

function buildSopDraft(db, ctx) {
  const {
    ensurePurchaseRequests,
    ensureSopCycles,
    supplierPerformance,
  } = ctx
  const mrp = buildMrpPlan(db)
  const supplierScore = supplierPerformance(db)
  const cycles = ensureSopCycles(db)
  const latestCycle = cycles[0] || null
  const forecastPlans = db.forecastPlans || []
  const purchaseRequests = ensurePurchaseRequests(db)
  const pendingRequests = purchaseRequests.filter((item) => item.status === '待审批')
  const openOrders = (db.purchaseOrders || []).filter((item) => ['待审批', '已审批', '已发出', '部分到货'].includes(item.status))
  const plannedAmount = Number(mrp.summary.plannedAmount || 0)
  const openPoAmount = openOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const requestAmount = pendingRequests.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const budgetLimit = 3_600_000
  const totalCommitment = plannedAmount + requestAmount + openPoAmount
  const constrainedAmount = Math.max(0, totalCommitment - budgetLimit)
  const topRisks = [
    ...mrp.exceptions.slice(0, 4).map((item) => ({
      type: item.type,
      title: `${item.sku} ${item.name}`,
      amount: item.amount,
      action: item.action,
    })),
    ...supplierScore.filter((item) => item.flag === '整改').slice(0, 2).map((item) => ({
      type: '供应商整改',
      title: item.name,
      amount: 0,
      action: `拒收率 ${item.rejectRate}% ，采购前需要复核质检异常。`,
    })),
  ].slice(0, 6)

  return {
    cycle: '2026-06',
    version: latestCycle ? Number(latestCycle.version || 1) + 1 : 1,
    status: latestCycle?.status === '已发布' ? '草案' : (latestCycle?.status || '草案'),
    demandPlan: {
      forecastVersions: forecastPlans.length,
      totalMonthlyDemand: (db.products || []).reduce((sum, item) => sum + Number(item.monthlyDemand || 0), 0),
      highRiskSku: (db.products || []).filter((item) => item.stockoutRisk === '高').length,
      source: forecastPlans[0]?.id || 'MRP profile',
    },
    supplyPlan: {
      plannedQty: mrp.summary.plannedQty,
      plannedAmount,
      exceptionCount: mrp.summary.exceptionCount,
      urgentCount: mrp.summary.urgentCount,
      openPoAmount,
      pendingPrAmount: requestAmount,
    },
    financialConstraint: {
      budgetLimit,
      totalCommitment,
      constrainedAmount,
      budgetUsagePct: Number(((totalCommitment / budgetLimit) * 100).toFixed(1)),
      decision: constrainedAmount > 0 ? '需要削减或分期释放' : '预算内可执行',
    },
    consensus: {
      recommendation: mrp.summary.urgentCount > 0
        ? `优先释放 ${mrp.summary.urgentCount} 条加急 MRP 计划，预算超出部分分期审批。`
        : 'MRP 计划可按常规节奏进入采购申请。',
      approvers: ['销售计划', '供应链计划', '采购', '财务'],
      decisions: topRisks,
    },
    latestPublished: latestCycle,
  }
}

export async function handleSopRoute(ctx) {
  const {
    req, res, url, db, send, readBody, event,
    ensurePurchaseRequests, ensureSopCycles, nextSequenceId, supplierPerformance,
  } = ctx
  const draftContext = { ensurePurchaseRequests, ensureSopCycles, supplierPerformance }

  if (req.method === 'GET' && url.pathname === '/api/sop-cycle') {
    return send(res, 200, {
      draft: buildSopDraft(db, draftContext),
      history: ensureSopCycles(db).slice(0, 8),
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/sop-cycle') {
    const body = await readBody(req)
    const draft = buildSopDraft(db, draftContext)
    const cycle = {
      id: body.id || nextSequenceId(ensureSopCycles(db), 'id', 'SOP-2026-', 1),
      cycle: body.cycle || draft.cycle,
      version: Number(body.version || draft.version),
      status: body.status || '已发布',
      demandPlan: body.demandPlan || draft.demandPlan,
      supplyPlan: body.supplyPlan || draft.supplyPlan,
      financialConstraint: body.financialConstraint || draft.financialConstraint,
      consensus: body.consensus || draft.consensus,
      approvers: Array.isArray(body.approvers) ? body.approvers : draft.consensus.approvers,
      approvedBy: body.approvedBy || '系统工作区用户',
      createdAt: new Date().toISOString(),
    }
    if (!['草案', '待审批', '已发布', '已驳回'].includes(cycle.status)) {
      return send(res, 400, { error: `invalid S&OP status: ${cycle.status}` })
    }
    db.sopCycles = [cycle, ...ensureSopCycles(db)].slice(0, 20)
    event(db, 'sop_cycle_saved', `S&OP ${cycle.cycle} v${cycle.version} ${cycle.status}`, cycle.id)
    throw Object.assign(new Error('Legacy S&OP mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, cycle)
  }

  return false
}
