export async function handleRfqsRoute(ctx) {
  const {
    req, res, url, db, send, readBody, event, todayLabel,
    ensureRfqs, ensurePurchaseRequests, nextSequenceId,
    workflowDefinitions, recordWorkflowCreation, actorFromBody,
    applyWorkflowTransition, createPoLineFromRfq, normalizePurchaseOrder,
  } = ctx

  if (req.method === 'GET' && url.pathname === '/api/rfqs') {
    return send(res, 200, ensureRfqs(db))
  }

  if (req.method === 'POST' && url.pathname === '/api/rfqs') {
    const body = await readBody(req)
    const rfqs = ensureRfqs(db)
    const id = body.id || nextSequenceId(rfqs, 'id', 'RFQ-26-', 47)
    const duplicate = rfqs.find((item) =>
      item.sourceRequest &&
      body.sourceRequest &&
      item.sourceRequest === body.sourceRequest &&
      !['已授标', '已转PO', '已关闭', '已取消'].includes(item.status)
    )
    if (duplicate) {
      return send(res, 409, {
        error: 'RFQ already exists for purchase request',
        rfq: duplicate.id,
        message: `${body.sourceRequest} 已存在进行中的询价单 ${duplicate.id}`,
      })
    }
    const rfq = {
      id,
      title: body.title || `${body.sourceSku || 'SKU'} 询价`,
      category: body.category || '采购询价',
      suppliers: Number(body.suppliers || 0),
      quoted: Number(body.quoted || 0),
      bestPrice: Number(body.bestPrice || 0),
      bestSupplier: body.bestSupplier || '',
      due: body.due || new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      status: body.status || '进行中',
      sourceRequest: body.sourceRequest || '',
      sourceSku: body.sourceSku || '',
      sourceName: body.sourceName || '',
      quantity: Number(body.quantity || 0),
      unit: body.unit || '',
      reason: body.reason || '',
      invitedSuppliers: Array.isArray(body.invitedSuppliers) ? body.invitedSuppliers : [],
      createdAt: new Date().toISOString(),
    }
    if (!rfq.title || rfq.suppliers < 0 || rfq.quoted < 0 || rfq.quoted > rfq.suppliers) {
      return send(res, 400, { error: 'invalid RFQ fields' })
    }
    if (!workflowDefinitions.rfq.statuses.has(rfq.status)) {
      return send(res, 400, { error: `invalid RFQ status: ${rfq.status}` })
    }
    recordWorkflowCreation(db, 'rfq', rfq, {
      actor: actorFromBody(body, 'system'),
      source: 'api',
      reason: body.reason || 'RFQ created',
      metadata: { sourceRequest: rfq.sourceRequest, sourceSku: rfq.sourceSku },
    })
    rfqs.unshift(rfq)
    event(db, 'rfq_created', `询价单 ${rfq.id} 已创建`, rfq.id)
    throw Object.assign(new Error('Legacy RFQ mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 201, rfq)
  }

  const rfqStatusMatch = url.pathname.match(/^\/api\/rfqs\/([^/]+)\/status$/)
  if (req.method === 'PATCH' && rfqStatusMatch) {
    const rfqId = decodeURIComponent(rfqStatusMatch[1])
    const body = await readBody(req)
    const rfq = ensureRfqs(db).find((item) => item.id === rfqId)
    if (!rfq) return send(res, 404, { error: 'RFQ not found' })
    if (body.bestSupplier) rfq.bestSupplier = body.bestSupplier
    if (typeof body.bestPrice === 'number') rfq.bestPrice = body.bestPrice
    const nextStatus = body.status || rfq.status
    try {
      applyWorkflowTransition(db, 'rfq', rfq, nextStatus, {
        action: nextStatus === '已授标' ? 'rfq_awarded' : 'rfq_status_changed',
        actor: actorFromBody(body, 'system'),
        source: 'api',
        reason: body.reason || '',
        metadata: {
          bestSupplier: rfq.bestSupplier || '',
          bestPrice: rfq.bestPrice || 0,
          sourceRequest: rfq.sourceRequest || '',
        },
      })
    } catch (error) {
      return send(res, error.status || 400, { error: error.message })
    }
    if (rfq.status === '已授标' && !rfq.linkedPo) {
      const request = rfq.sourceRequest
        ? ensurePurchaseRequests(db).find((item) => item.pr === rfq.sourceRequest)
        : null
      const quantity = Number(rfq.quantity || request?.quantity || 1)
      const unitPrice = Number(rfq.bestPrice || request?.unitPrice || 0)
      const poId = nextSequenceId(db.purchaseOrders, 'po', 'PO-2026-', 1300)
      const po = {
        po: poId,
        supplier: rfq.bestSupplier || request?.supplier || '未选择供应商',
        created: todayLabel(),
        eta: request?.requiredDate || rfq.due || '6月15日',
        owner: request?.buyer || request?.requester || '张磊',
        amount: Math.max(0, quantity * unitPrice),
        items: 1,
        received: 0,
        status: '待审批',
        priority: request?.priority || '中',
        paid: false,
        source: 'rfq-award',
        sourceRequest: rfq.sourceRequest || '',
        sourceRfq: rfq.id,
        sourceSku: rfq.sourceSku || request?.sourceSku || '',
        sourceName: rfq.sourceName || request?.sourceName || rfq.title,
        recommendedQty: quantity,
        unit: rfq.unit || request?.unit || '',
        unitPrice,
        reason: `RFQ ${rfq.id} 授标生成，来源 ${rfq.sourceRequest || '询价单'}。${rfq.reason || ''}`.trim(),
        lines: [
          createPoLineFromRfq(rfq, request, poId, 0),
        ],
        approvalSnapshot: {
          source: 'rfq-award',
          summary: `${rfq.id} · ${rfq.bestSupplier || '供应商'} · ${quantity.toLocaleString()} ${rfq.unit || request?.unit || ''} · ${unitPrice ? `${unitPrice}/unit` : '待补价'}`,
          explanation: `RFQ 授标后生成 PO 草稿，保留来源 PR、邀请供应商、授标价格和触发原因。`,
          rfq: {
            id: rfq.id,
            sourceRequest: rfq.sourceRequest || '',
            invitedSuppliers: rfq.invitedSuppliers || [],
            bestSupplier: rfq.bestSupplier || '',
            bestPrice: unitPrice,
            due: rfq.due,
          },
          supplier: {
            name: rfq.bestSupplier || request?.supplier || '',
            unitPrice,
            amount: Math.max(0, quantity * unitPrice),
          },
          createdAt: new Date().toISOString(),
        },
      }
      normalizePurchaseOrder(po)
      recordWorkflowCreation(db, 'purchaseOrder', po, {
        action: 'purchase_order_created_from_rfq',
        actor: actorFromBody(body, 'system'),
        source: 'rfq-award',
        reason: `RFQ ${rfq.id} awarded`,
        metadata: { rfqId: rfq.id, sourceRequest: rfq.sourceRequest || '' },
      })
      db.purchaseOrders.unshift(po)
      rfq.linkedPo = po.po
      if (request && !request.linkedPo) request.linkedPo = po.po
      applyWorkflowTransition(db, 'rfq', rfq, '已转PO', {
        action: 'rfq_converted_to_po',
        actor: actorFromBody(body, 'system'),
        source: 'rfq-award',
        reason: `Converted to ${po.po}`,
        metadata: { poId: po.po, sourceRequest: rfq.sourceRequest || '', bestSupplier: rfq.bestSupplier || '' },
      })
      event(db, 'purchase_order_created', `RFQ ${rfq.id} 授标生成 ${po.po}`, po.po)
    }
    event(db, 'rfq_status', `${rfq.id} 状态更新为 ${rfq.status}`, rfq.id)
    throw Object.assign(new Error('Legacy RFQ mutation was removed.'), { code: 'FLOWCHAIN_LEGACY_MUTATION_REMOVED', status: 501 })
    return send(res, 200, rfq)
  }

  return false
}
