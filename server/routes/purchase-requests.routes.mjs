export async function handlePurchaseRequestsRoute(ctx) {
  const {
    req, res, url, db, send, readBody, event, todayLabel, repositories, identity,
    ensurePurchaseRequests, systemRequestSources, nextSequenceId,
    purchaseRequestStatuses, priorities, recordWorkflowCreation,
    actorFromBody, applyWorkflowTransition, recordValidationBlocked,
    createPoLineFromRequest, normalizePurchaseOrder,
  } = ctx

  if (req.method === 'GET' && url.pathname === '/api/purchase-requests') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' })
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' })
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, snapshot.purchaseRequests)
  }

  if (req.method === 'POST' && url.pathname === '/api/purchase-requests') {
    const body = await readBody(req)
    if (systemRequestSources.has(body.source) && body.sourceSku) {
      const duplicate = ensurePurchaseRequests(db).find((item) =>
        item.source === body.source &&
        item.sourceSku === body.sourceSku &&
        !['已转PO', '已驳回', '已取消'].includes(item.status)
      )
      if (duplicate) {
        return send(res, 409, {
          error: `${body.source} purchase request already exists`,
          pr: duplicate.pr,
          message: `${body.sourceSku} 已存在未关闭采购申请 ${duplicate.pr}`,
        })
      }
    }
    const request = {
      pr: body.pr || nextSequenceId(ensurePurchaseRequests(db), 'pr', 'PR-2026-', 2400),
      source: body.source || 'manual',
      sourceSku: body.sourceSku || '',
      sourceName: body.sourceName || '',
      supplier: body.supplier || '未选择供应商',
      requester: body.requester || body.owner || '张磊',
      buyer: body.buyer || body.owner || '张磊',
      created: body.created || todayLabel(),
      requiredDate: body.requiredDate || body.eta || '6月15日',
      quantity: Number(body.quantity || body.recommendedQty || 0),
      unit: body.unit || '',
      unitPrice: Number(body.unitPrice || 0),
      amount: Number(body.amount || 0),
      priority: body.priority || '中',
      status: body.status || '待审批',
      reason: body.reason || '',
      forecastBasis: body.forecastBasis || null,
      approvalSnapshot: body.approvalSnapshot || null,
      linkedPo: '',
      approvedAt: '',
      convertedAt: '',
    }
    if (!request.sourceSku && systemRequestSources.has(request.source)) {
      return send(res, 400, { error: `sourceSku is required for ${request.source} purchase requests` })
    }
    if (request.quantity <= 0 || request.amount < 0) {
      return send(res, 400, { error: 'quantity must be positive and amount cannot be negative' })
    }
    if (!purchaseRequestStatuses.has(request.status)) {
      return send(res, 400, { error: `invalid purchase request status: ${request.status}` })
    }
    if (!priorities.has(request.priority)) {
      return send(res, 400, { error: `invalid priority: ${request.priority}` })
    }
    recordWorkflowCreation(db, 'purchaseRequest', request, {
      actor: actorFromBody(body, request.requester || 'system'),
      source: request.source || 'api',
      reason: request.reason || 'purchase request created',
      metadata: { sourceSku: request.sourceSku, quantity: request.quantity, amount: request.amount },
    })
    ensurePurchaseRequests(db).unshift(request)
    event(db, 'purchase_request_created', `采购申请 ${request.pr} 已提交审批`, request.pr)
    throw Object.assign(new Error('Legacy purchase request mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, request)
  }

  const prStatusMatch = url.pathname.match(/^\/api\/purchase-requests\/([^/]+)\/status$/)
  if (req.method === 'PATCH' && prStatusMatch) {
    const prId = decodeURIComponent(prStatusMatch[1])
    const body = await readBody(req)
    const request = ensurePurchaseRequests(db).find((item) => item.pr === prId)
    if (!request) return send(res, 404, { error: 'PR not found' })
    const nextStatus = body.status || request.status
    if (!purchaseRequestStatuses.has(nextStatus)) {
      return send(res, 400, { error: `invalid purchase request status: ${nextStatus}` })
    }
    try {
      applyWorkflowTransition(db, 'purchaseRequest', request, nextStatus, {
        action: nextStatus === '已批准' ? 'purchase_request_approved' : nextStatus === '已驳回' ? 'purchase_request_rejected' : 'purchase_request_status_changed',
        actor: actorFromBody(body, request.buyer || request.requester || 'system'),
        source: 'api',
        reason: body.reason || '',
        metadata: { sourceSku: request.sourceSku || '', linkedPo: request.linkedPo || '' },
      })
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    if (body.reason) request.decisionReason = body.reason
    if (request.status === '已批准') request.approvedAt = new Date().toISOString()
    event(db, 'purchase_request_status', `${request.pr} 状态更新为 ${request.status}`, request.pr)
    throw Object.assign(new Error('Legacy purchase request mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 200, request)
  }

  const prConvertMatch = url.pathname.match(/^\/api\/purchase-requests\/([^/]+)\/convert-to-po$/)
  if (req.method === 'POST' && prConvertMatch) {
    const prId = decodeURIComponent(prConvertMatch[1])
    const request = ensurePurchaseRequests(db).find((item) => item.pr === prId)
    if (!request) return send(res, 404, { error: 'PR not found' })
    if (request.linkedPo) return send(res, 409, { error: 'purchase request already converted', po: request.linkedPo })
    if (request.status !== '已批准') {
      recordValidationBlocked(db, 'purchaseRequest', request, 'convert_to_po', `cannot convert PR with status ${request.status}`, {
        actor: request.buyer || request.requester || 'system',
        source: 'purchase-request',
      })
      throw Object.assign(new Error('Legacy purchase request mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
      return send(res, 409, { error: `cannot convert PR with status ${request.status}` })
    }
    const poId = nextSequenceId(db.purchaseOrders, 'po', 'PO-2026-', 1300)
    const requestLines = Array.isArray(request.lines) && request.lines.length > 0
      ? request.lines.map((line, index) => createPoLineFromRequest({ ...request, ...line }, poId, index))
      : [createPoLineFromRequest(request, poId, 0)]
    const po = {
      po: poId,
      supplier: request.supplier,
      created: todayLabel(),
      eta: request.requiredDate,
      owner: request.buyer || request.requester,
      amount: Number(request.amount || 0),
      items: 1,
      received: 0,
      status: '待审批',
      priority: request.priority || '中',
      paid: false,
      source: 'purchase-request',
      sourceRequest: request.pr,
      sourceSku: request.sourceSku || '',
      sourceName: request.sourceName || '',
      recommendedQty: Number(request.quantity || 0),
      unit: request.unit || '',
      unitPrice: Number(request.unitPrice || 0),
      reason: request.reason || '',
      lines: requestLines,
      approvalSnapshot: request.approvalSnapshot || null,
    }
    normalizePurchaseOrder(po)
    try {
      applyWorkflowTransition(db, 'purchaseRequest', request, '已转PO', {
        action: 'purchase_request_converted_to_po',
        actor: request.buyer || request.requester || 'system',
        source: 'purchase-request',
        reason: `Converted to ${po.po}`,
        metadata: { poId: po.po, lineCount: po.lines.length },
      })
      recordWorkflowCreation(db, 'purchaseOrder', po, {
        action: 'purchase_order_created_from_pr',
        actor: request.buyer || request.requester || 'system',
        source: 'purchase-request',
        reason: `Created from ${request.pr}`,
        metadata: { sourceRequest: request.pr, lineCount: po.lines.length },
      })
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    db.purchaseOrders.unshift(po)
    request.linkedPo = po.po
    request.convertedAt = new Date().toISOString()
    event(db, 'purchase_request_converted', `采购申请 ${request.pr} 已转为 ${po.po}`, po.po)
    throw Object.assign(new Error('Legacy purchase request mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, { request, po })
  }

  return false
}
