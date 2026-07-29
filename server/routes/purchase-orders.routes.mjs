export async function handlePurchaseOrdersRoute(ctx) {
  const {
    req, res, url, db, send, readBody, event, todayLabel, repositories, identity,
    normalizePurchaseOrders, nextSequenceId, normalizePoLine,
    normalizePurchaseOrder, calculatePoHeaderFromLines,
    purchaseOrderStatuses, priorities, recordWorkflowCreation,
    actorFromBody, applyWorkflowTransition, recordValidationBlocked,
  } = ctx

  if (req.method === 'GET' && url.pathname === '/api/purchase-orders') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' })
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' })
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, snapshot.purchaseOrders)
  }

  if (req.method === 'GET' && url.pathname === '/api/purchase-orders-workbench') {
    if (!identity?.authenticated || !identity.tenantId) return send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' })
    if (!repositories?.procurementRead?.snapshot) return send(res, 503, { code: 'FLOWCHAIN_POSTGRESQL_READ_MODEL_UNAVAILABLE', message: 'The PostgreSQL procurement read model is unavailable.' })
    const snapshot = await repositories.procurementRead.snapshot({ tenantId: identity.tenantId })
    return send(res, 200, {
      purchaseOrders: snapshot.purchaseOrders,
      receivingDocs: snapshot.receivingDocs,
      supplierInvoices: snapshot.supplierInvoices,
      documentLinks: snapshot.documentLinks,
      procurementFollowups: snapshot.procurementFollowups,
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/purchase-orders') {
    const body = await readBody(req)
    if (body.source === 'forecast' && body.sourceSku) {
      const duplicate = db.purchaseOrders.find((item) =>
        item.source === 'forecast' &&
        item.sourceSku === body.sourceSku &&
        !['已完成', '已取消'].includes(item.status)
      )
      if (duplicate) {
        return send(res, 409, {
          error: 'forecast purchase order already exists',
          po: duplicate.po,
          message: `${body.sourceSku} 已存在预测来源采购订单 ${duplicate.po}`,
        })
      }
    }
    const poId = body.po || nextSequenceId(db.purchaseOrders, 'po', 'PO-2026-', 1300)
    const po = {
      po: poId,
      supplier: body.supplier || '未选择供应商',
      created: body.created || todayLabel(),
      eta: body.eta || '6月15日',
      owner: body.owner || '张磊',
      amount: Number(body.amount || 0),
      items: Number(body.items || 1),
      received: Number(body.received || 0),
      status: body.status || '待审批',
      priority: body.priority || '中',
      paid: Boolean(body.paid),
      source: body.source || 'manual',
      sourceSku: body.sourceSku || '',
      sourceName: body.sourceName || '',
      recommendedQty: Number(body.recommendedQty || 0),
      unit: body.unit || '',
      unitPrice: Number(body.unitPrice || 0),
      reason: body.reason || '',
      lines: Array.isArray(body.lines) && body.lines.length > 0
        ? body.lines.map((line, index) => normalizePoLine(line, { ...body, po: poId, supplier: body.supplier || '未选择供应商' }, index))
        : [normalizePoLine({
            sku: body.sourceSku || '',
            itemName: body.sourceName || body.reason || '',
            quantityOrdered: Number(body.recommendedQty || body.items || 1),
            quantityReceived: Number(body.received || 0),
            quantityAccepted: Number(body.accepted || body.received || 0),
            quantityRejected: Number(body.rejected || 0),
            unit: body.unit || '',
            unitPrice: Number(body.unitPrice || 0),
            currency: body.currency || 'CNY',
            requiredDate: body.eta || '6月15日',
            promisedDate: body.promisedDate || body.eta || '6月15日',
          }, { ...body, po: poId, supplier: body.supplier || '未选择供应商' }, 0)],
      approvalSnapshot: body.approvalSnapshot || null,
    }
    normalizePurchaseOrder(po)
    if (po.amount < 0 || po.items <= 0 || po.received < 0 || po.received > po.items) {
      return send(res, 400, { error: 'amount/items/received values are invalid' })
    }
    if (!purchaseOrderStatuses.has(po.status)) {
      return send(res, 400, { error: `invalid purchase order status: ${po.status}` })
    }
    if (!priorities.has(po.priority)) {
      return send(res, 400, { error: `invalid priority: ${po.priority}` })
    }
    recordWorkflowCreation(db, 'purchaseOrder', po, {
      actor: actorFromBody(body, po.owner || 'system'),
      source: po.source || 'api',
      reason: po.reason || 'purchase order created',
      metadata: { sourceSku: po.sourceSku, lineCount: po.lines.length, amount: po.amount },
    })
    db.purchaseOrders.unshift(po)
    event(db, 'purchase_order_created', `采购订单 ${po.po} 已提交审批`, po.po)
    throw Object.assign(new Error('Legacy purchase order mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, po)
  }

  const poStatusMatch = url.pathname.match(/^\/api\/purchase-orders\/([^/]+)\/status$/)
  if (req.method === 'PATCH' && poStatusMatch) {
    const poId = decodeURIComponent(poStatusMatch[1])
    const body = await readBody(req)
    const po = db.purchaseOrders.find((item) => item.po === poId)
    if (!po) return send(res, 404, { error: 'PO not found' })
    normalizePurchaseOrder(po)
    const nextStatus = body.status || po.status
    const nextReceived = typeof body.received === 'number' ? body.received : po.received
    if (!purchaseOrderStatuses.has(nextStatus)) {
      return send(res, 400, { error: `invalid purchase order status: ${nextStatus}` })
    }
    if (nextReceived < 0 || nextReceived > po.items) {
      return send(res, 400, { error: 'received quantity is invalid' })
    }
    if (['已完成', '已取消'].includes(po.status) && (
      Array.isArray(body.lines) ||
      body.received !== undefined ||
      (body.status !== undefined && body.status !== po.status)
    )) {
      const message = `PO ${po.po} is ${po.status}; closed or cancelled orders cannot be edited as open`
      recordValidationBlocked(db, 'purchaseOrder', po, 'edit_closed_po', message, {
        actor: actorFromBody(body, po.owner || 'system'),
        source: 'api',
        requestedStatus: nextStatus,
      })
      throw Object.assign(new Error('Legacy purchase order mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
      return send(res, 409, { error: message })
    }
    if (Array.isArray(body.lines)) {
      po.lines = body.lines.map((line, index) => normalizePoLine(line, po, index))
      calculatePoHeaderFromLines(po)
    }
    po.received = nextReceived
    try {
      applyWorkflowTransition(db, 'purchaseOrder', po, nextStatus, {
        action: nextStatus === '已审批' ? 'purchase_order_approved'
          : nextStatus === '已驳回' ? 'purchase_order_rejected'
            : nextStatus === '已发出' ? 'purchase_order_issued'
              : nextStatus === '已取消' ? 'purchase_order_cancelled'
                : 'purchase_order_status_changed',
        actor: actorFromBody(body, po.owner || 'system'),
        source: 'api',
        reason: body.reason || '',
        metadata: { received: nextReceived, lineCount: po.lines.length },
      })
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    event(db, 'purchase_order_status', `${po.po} 状态更新为 ${po.status}`, po.po)
    throw Object.assign(new Error('Legacy purchase order mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 200, normalizePurchaseOrder(po))
  }

  return false
}
