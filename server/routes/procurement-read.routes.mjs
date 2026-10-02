import { canReadProcurementDocument, maskProcurementRecord, procurementReadAccess } from '../domain/procurement-read-access.mjs'
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

  // What the actor may read, looked up once and only after a request is
  // known to be valid.
  let accessLookup = null
  const readAccess = () => (accessLookup ||= identity ? procurementReadAccess(ctx) : Promise.resolve(null))
  const options = async () => { const access = await readAccess(); return access ? { access } : {} }

  if (req.method === 'GET' && url.pathname === '/api/procurement/documents') {
    const filters = query(url)
    if (filters.type && !repository.normalizeDocumentType(filters.type)) {
      send(res, 200, { documents: [] })
      return true
    }
    send(res, 200, { documents: await repository.listDocuments({ ...filters, ...(tenantId ? { tenantId } : {}) }, await options()) })
    return true
  }

  const documentMatch = url.pathname.match(/^\/api\/procurement\/documents\/([^/]+)\/([^/]+)$/)
  if (req.method === 'GET' && documentMatch) {
    const documentType = repository.normalizeDocumentType(documentMatch[1])
    if (!documentType) {
      send(res, 400, { error: 'Invalid procurement document type' })
      return true
    }
    let documentId
    try {
      documentId = decodeURIComponent(documentMatch[2])
    } catch {
      send(res, 400, { error: 'Invalid procurement document id' })
      return true
    }
    // The type decides, before any lookup: the answer is the same for a real
    // and a made-up number.
    const access = await readAccess()
    if (access && !canReadProcurementDocument(documentType, access)) {
      send(res, 403, { code: 'PERMISSION_DENIED', message: 'Your role cannot view this kind of procurement document.', details: [] })
      return true
    }
    const found = await repository.getDocument(documentType, documentId, tenantId ? { tenantId } : {})
    const document = found && access ? maskProcurementRecord(found, documentType, access) : found
    if (!document) {
      send(res, 404, { error: 'Procurement document not found' })
      return true
    }
    send(res, 200, { document })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/links') {
    send(res, 200, { links: await repository.listLinks({ ...query(url), ...(tenantId ? { tenantId } : {}) }, await options()) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/followups') {
    send(res, 200, { followups: await repository.listFollowups({ ...query(url), ...(tenantId ? { tenantId } : {}) }, await options()) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/procurement/summary') {
    send(res, 200, { summary: await repository.getSummary(tenantId ? { tenantId } : {}, await options()) })
    return true
  }

  return false
}
