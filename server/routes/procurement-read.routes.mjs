function query(url) {
  return {
    q: url.searchParams.get('q') || '',
    type: url.searchParams.get('type') || '',
    status: url.searchParams.get('status') || '',
    supplier: url.searchParams.get('supplier') || '',
    limit: url.searchParams.get('limit') || '',
  }
}

function procurementReadRepository(ctx) {
  if (!ctx.repositories?.procurementRead) throw new Error('PostgreSQL procurement repository is not configured.')
  return ctx.repositories.procurementRead
}

export async function handleProcurementReadRoute(ctx) {
  const { req, res, url, send, identity } = ctx
  if (identity && (!identity.authenticated || !identity.tenantId)) {
    if (url.pathname.startsWith('/api/procurement/')) {
      send(res, 401, { code: 'TENANT_CONTEXT_REQUIRED', message: 'An authenticated tenant context is required.' })
      return true
    }
    return false
  }
  const repository = procurementReadRepository(ctx)
  const tenantId = identity?.tenantId

  if (req.method === 'GET' && url.pathname === '/api/procurement/documents') {
    const filters = query(url)
    if (filters.type && !repository.normalizeDocumentType(filters.type)) {
      send(res, 200, { documents: [] })
      return true
    }
    send(res, 200, { documents: await repository.listDocuments({ ...filters, ...(tenantId ? { tenantId } : {}) }) })
    return true
  }

  const documentMatch = url.pathname.match(/^\/api\/procurement\/documents\/([^/]+)\/([^/]+)$/)
  if (req.method === 'GET' && documentMatch) {
    const documentType = repository.normalizeDocumentType(documentMatch[1])
    if (!documentType) {
      send(res, 400, { error: 'Invalid procurement document type' })
      return true
    }
    const document = await repository.getDocument(documentType, documentMatch[2], tenantId ? { tenantId } : {})
    if (!document) {
      send(res, 404, { error: 'Procurement document not found' })
      return true
    }
    send(res, 200, { document })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/links') {
    send(res, 200, { links: await repository.listLinks({ ...query(url), ...(tenantId ? { tenantId } : {}) }) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/followups') {
    send(res, 200, { followups: await repository.listFollowups({ ...query(url), ...(tenantId ? { tenantId } : {}) }) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/summary') {
    send(res, 200, { summary: await repository.getSummary(tenantId ? { tenantId } : {}) })
    return true
  }

  return false
}
