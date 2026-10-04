import { assertAuthorized } from '../auth/authorization-service.mjs'
import { selectMasterData } from '../domain/master-data-selectors.mjs'
import { maskReferencePrice, maskSupplier, masterDataReadAccess } from '../domain/master-data-read-access.mjs'
import { PilotIdentityError, resolveProvisionedActor } from '../domain/pilot-identity.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { createSupplierInsightsReadService } from '../domain/supplier-insights.mjs'

// Writes are decided by Roles & permissions, never by the legacy User.role, so
// an administrator who narrows someone's roles narrows what they can change.
// An item's supplier links share the item code; the catalog says why.
const WRITE_RULES = Object.freeze({
  'item-master': { permission: 'master_data.item.manage', records: 'items' },
  'item-supplier-relationship': { permission: 'master_data.item.manage', records: "an item's suppliers" },
  'supplier-master': { permission: 'master_data.supplier.manage', records: 'suppliers' },
  'customer-master': { permission: 'master_data.customer.manage', records: 'customers' },
})

function masterDataRepository(ctx) {
  if (!ctx.repositories?.masterData) throw new Error('PostgreSQL master data repository is not configured.')
  return ctx.repositories.masterData
}

export async function handleMasterDataRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  const repository = masterDataRepository(ctx)
  if (!url.pathname.startsWith('/api/master-data')) return false
  const tenantScope = (extra = {}) => ({ ...(ctx.identity?.tenantId ? { tenantId: ctx.identity.tenantId } : {}), ...extra })
  const scopedRepository = new Proxy(repository, {
    get(target, property) {
      if (property === 'listManagedItems' && typeof target[property] !== 'function') {
        return (filters = {}) => target.listItems(tenantScope({ purchasableOnly: true, ...filters }))
      }
      if (!['listManagedItems', 'listWarehouses', 'listPaymentTerms', 'listTaxCodes'].includes(String(property))) return target[property]
      return (filters = {}) => target[property](tenantScope(filters))
    },
  })
  // The provisioned workspace user with the permissions of their active roles,
  // resolved at most once per request. Tests without a database pass
  // ctx.masterDataActor instead.
  let provisioned
  const provisionedActor = async () => (provisioned ??= ctx.masterDataActor || await resolveProvisionedActor(await getPrismaClient(ctx.env || process.env), ctx.identity))
  // Sends the refusal itself and returns false when the signed-in user may not
  // make this change.
  const authorizeWrite = async (resource) => {
    const { permission, records } = WRITE_RULES[resource]
    if (!ctx.identity?.authenticated) {
      send(res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to change master data.', action: 'maintain', resource })
      return false
    }
    try {
      // Checked against the session's workspace, so an actor from any other
      // workspace is refused.
      assertAuthorized({ actor: await provisionedActor(), permission, tenantId: ctx.identity.tenantId })
      return true
    } catch (error) {
      // Not provisioned, disabled, stale session or no workspace.
      if (error instanceof PilotIdentityError) {
        send(res, error.status, { code: error.code, message: error.message, action: 'maintain', resource })
        return false
      }
      if (error?.name !== 'AuthorizationError') throw error
      send(res, 403, {
        code: 'PERMISSION_DENIED',
        message: `Your roles do not allow changing ${records}. A workspace administrator can grant ${permission} in Roles & permissions.`,
        permission,
        reasonCode: error.code,
        action: 'maintain',
        resource,
      })
      return false
    }
  }
  const actor = () => ctx.identity.userId
  // Resolved once per request, only on the routes that return suppliers or
  // reference prices; after a write it reuses the actor the write was
  // authorized with.
  let access
  const readAccess = async () => (access ??= await masterDataReadAccess(ctx, provisioned || ctx.masterDataActor))
  const suppliersFor = async (rows) => { const visible = await readAccess(); return rows.map((row) => maskSupplier(row, visible)) }
  const supplierFor = async (row) => maskSupplier(row, await readAccess())
  const pricesFor = async (rows) => { const visible = await readAccess(); return (rows || []).map((row) => maskReferencePrice(row, visible)) }

  const selectorMatch = url.pathname.match(/^\/api\/master-data\/(departments|currencies|units|commodities|warehouses|payment-terms|tax-codes)\/select$/)
  if (req.method === 'GET' && selectorMatch) {
    const options = await selectMasterData(scopedRepository, selectorMatch[1])
    send(res, 200, { options })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data') {
    const [items, suppliers, customers, warehouses, paymentTerms, taxCodes] =
      await Promise.all([
        repository.listItems(tenantScope()),
        repository.listSuppliers(tenantScope()),
        repository.listCustomers(tenantScope()),
        repository.listWarehouses(tenantScope()),
        repository.listPaymentTerms(tenantScope()),
        repository.listTaxCodes(tenantScope()),
      ])
    send(res, 200, {
      items,
      suppliers: await suppliersFor(suppliers),
      customers,
      warehouses,
      paymentTerms,
      taxCodes,
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/customers') {
    send(res, 200, { customers: await repository.listCustomers(tenantScope({
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || '',
    })) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/customers') {
    if (!(await authorizeWrite('customer-master'))) return true
    try {
      send(res, 201, { customer: await repository.createCustomer(await readBody(req), actor(), tenantScope()) })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  const customerStatusMatch = url.pathname.match(
    /^\/api\/master-data\/customers\/([^/]+)\/(activate|deactivate)$/,
  )
  if (req.method === 'POST' && customerStatusMatch) {
    if (!(await authorizeWrite('customer-master'))) return true
    const body = await readBody(req)
    try {
      const customer = await repository.updateCustomer(customerStatusMatch[1], {
        status: customerStatusMatch[2] === 'activate' ? 'active' : 'inactive',
        expectedVersion: body.expectedVersion,
      }, actor(), tenantScope())
      send(res, 200, { customer })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  const customerMatch = url.pathname.match(
    /^\/api\/master-data\/customers\/([^/]+)$/,
  )
  if (req.method === 'GET' && customerMatch) {
    const customer = await repository.getCustomer(customerMatch[1], tenantScope())
    send(
      res,
      customer ? 200 : 404,
      customer ? { customer } : { error: 'Customer not found' },
    )
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/items') {
    const managed =
      url.searchParams.get('managed') === 'true' ||
      url.searchParams.get('purchasable') === 'true'
    send(res, 200, {
      items: await (managed && repository.listManagedItems
        ? repository.listManagedItems
        : repository.listItems)(tenantScope({
        purchasableOnly: url.searchParams.get('purchasable') === 'true',
      })),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/items') {
    if (!(await authorizeWrite('item-master'))) return true
    if (!repository.createItem) {
      send(res, 501, {
        code: 'ADAPTER_WRITE_UNSUPPORTED',
        message: 'Item writes are not available in this workspace.',
      })
      return true
    }
    try {
      send(res, 201, {
        item: await repository.createItem(await readBody(req), actor(), tenantScope()),
      })
    } catch (error) {
      send(res, error.status || 500, {
        code: error.code || 'PERSISTENCE_ERROR',
        message: error.message,
        details: error.details || [],
      })
    }
    return true
  }

  const itemMatch = url.pathname.match(/^\/api\/master-data\/items\/([^/]+)$/)
  if (req.method === 'GET' && itemMatch) {
    const itemId = itemMatch[1]
    const managedItem = repository.getManagedItem
      ? await repository.getManagedItem(itemId, tenantScope())
      : null
    const item = managedItem || await repository.getItem(itemId, tenantScope())
    if (!item) {
      send(res, 404, { error: 'Item not found' })
      return true
    }
    send(res, 200, { item })
    return true
  }

  if (req.method === 'PATCH' && itemMatch) {
    if (!(await authorizeWrite('item-master'))) return true
    if (!repository.updateItem) {
      send(res, 501, {
        code: 'ADAPTER_WRITE_UNSUPPORTED',
        message: 'Item writes are not available in this workspace.',
      })
      return true
    }
    try {
      send(res, 200, {
        item: await repository.updateItem(
          itemMatch[1],
          await readBody(req),
          actor(),
          tenantScope(),
        ),
      })
    } catch (error) {
      send(res, error.status || 500, {
        code: error.code || 'PERSISTENCE_ERROR',
        message: error.message,
        details: error.details || [],
      })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/suppliers') {
    // Search, status and category narrow every tab; tier (1, 2, 3, none) and
    // owner (a user id, me, none) pick the tab. The counts cover each tab.
    const filters = tenantScope({
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || '',
      category: url.searchParams.get('category') || '',
      tier: url.searchParams.get('tier') || '',
      owner: url.searchParams.get('owner') || '',
      currentUserId: ctx.identity?.userId || '',
    })
    const [suppliers, counts] = await Promise.all([
      repository.listSuppliers(filters),
      typeof repository.supplierTabCounts === 'function' ? repository.supplierTabCounts(filters) : null,
    ])
    send(res, 200, { suppliers: await suppliersFor(suppliers), ...(counts ? { counts } : {}) })
    return true
  }

  // Every supplier's list metrics and tier suggestion, for the signed-in
  // reader: what they may not see comes back null. Read once per list load,
  // not per search.
  if (req.method === 'GET' && url.pathname === '/api/master-data/supplier-insights') {
    if (!ctx.identity?.authenticated) {
      send(res, 401, { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to read supplier metrics.' })
      return true
    }
    try {
      const service = ctx.supplierInsightsService || createSupplierInsightsReadService({
        prisma: await getPrismaClient(ctx.env || process.env),
        listPurchaseOrders: ctx.repositories?.procurementRuntime?.listForReport,
      })
      send(res, 200, await service.read(ctx))
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'SUPPLIER_INSIGHTS_UNAVAILABLE', message: error.status ? error.message : 'Supplier metrics are unavailable. Try again.' })
    }
    return true
  }

  // The people a supplier can be assigned to. Only those who may change a
  // supplier pick an owner, so listing them needs no user administration.
  if (req.method === 'GET' && url.pathname === '/api/master-data/supplier-owners') {
    if (!(await authorizeWrite('supplier-master'))) return true
    send(res, 200, { owners: await repository.listSupplierOwners(tenantScope()) })
    return true
  }

  const supplierTierMatch = url.pathname.match(/^\/api\/master-data\/suppliers\/([^/]+)\/(tier|owner)$/)
  if (req.method === 'PATCH' && supplierTierMatch) {
    if (!(await authorizeWrite('supplier-master'))) return true
    const change = supplierTierMatch[2] === 'tier' ? repository.setSupplierTier : repository.setSupplierOwner
    try {
      send(res, 200, { supplier: await supplierFor(await change(supplierTierMatch[1], await readBody(req), actor(), tenantScope())) })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  if (req.method === 'PATCH' && customerMatch) {
    if (!(await authorizeWrite('customer-master'))) return true
    try {
      send(res, 200, { customer: await repository.updateCustomer(customerMatch[1], await readBody(req), actor(), tenantScope()) })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/suppliers/select') {
    const query = String(url.searchParams.get('query') || '').trim().toLowerCase()
    const suppliers = await suppliersFor(await repository.listSuppliers(tenantScope()))
    send(res, 200, {
      suppliers: suppliers.filter(row => !query || [row.id, row.name].some(value => String(value || '').toLowerCase().includes(query))).map(row => ({
        ...row,
        supplierName: row.name,
        supplierCode: row.id,
      })),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/suppliers') {
    if (!(await authorizeWrite('supplier-master'))) return true
    if (!repository.createSupplier) { send(res,501,{code:'ADAPTER_WRITE_UNSUPPORTED',message:'Supplier writes are not available in this workspace.'}); return true }
    try { send(res,201,{supplier:await supplierFor(await repository.createSupplier(await readBody(req),actor(),tenantScope()))}) } catch(error) { send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]}) }
    return true
  }

  const supplierMatch = url.pathname.match(
    /^\/api\/master-data\/suppliers\/([^/]+)$/,
  )
  if (req.method === 'GET' && supplierMatch) {
    const supplier = await repository.getSupplier(supplierMatch[1], tenantScope())
    if (!supplier) {
      send(res, 404, { error: 'Supplier not found' })
      return true
    }
    const tierHistory = typeof repository.supplierTierHistory === 'function' ? await repository.supplierTierHistory(supplier.id, tenantScope()) : []
    send(res, 200, { supplier: { ...(await supplierFor(supplier)), tierHistory } })
    return true
  }

  if (req.method === 'PATCH' && supplierMatch) {
    if (!(await authorizeWrite('supplier-master'))) return true
    try { send(res,200,{supplier:await supplierFor(await repository.updateSupplier(decodeURIComponent(supplierMatch[1]),await readBody(req),actor(),tenantScope()))}) } catch(error) { send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]}) }
    return true
  }

  const supplierItems = url.pathname.match(/^\/api\/master-data\/suppliers\/([^/]+)\/items$/)
  if (req.method === 'GET' && supplierItems) {
    if (typeof repository.listSupplierItems !== 'function') {
      send(res, 501, {
        code: 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED',
        capability: 'supplier-item-relationships',
        message: 'Supplier item relationships are not available in this workspace.',
        limitations: ['Supplier details can be read, but the items they supply cannot.'],
      })
      return true
    }
    send(res,200,{relationships:await pricesFor(await repository.listSupplierItems(decodeURIComponent(supplierItems[1]), tenantScope()))})
    return true
  }

  const itemSuppliers = url.pathname.match(/^\/api\/master-data\/items\/([^/]+)\/suppliers$/)
  if (req.method === 'GET' && itemSuppliers) {
    if (typeof repository.listItemSuppliers !== 'function' || typeof repository.approvedSuppliersForItem !== 'function') {
      send(res, 501, {
        code: 'FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED',
        capability: 'item-supplier-relationships',
        message: 'Item supplier relationships are not available in this workspace.',
        limitations: ['Item details can be read, but the suppliers they can be bought from cannot.'],
      })
      return true
    }
    const itemId=decodeURIComponent(itemSuppliers[1])
    send(res,200,{relationships:await pricesFor(await repository.listItemSuppliers(itemId, tenantScope())),suppliers:await pricesFor(await repository.approvedSuppliersForItem(itemId, tenantScope()))})
    return true
  }
  if (req.method === 'POST' && itemSuppliers) { if (!(await authorizeWrite('item-supplier-relationship'))) return true; try{send(res,201,{relationship:(await pricesFor([await repository.createItemSupplier(decodeURIComponent(itemSuppliers[1]),await readBody(req),actor(),tenantScope())]))[0]})}catch(error){send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]})} return true }
  const relationshipMatch=url.pathname.match(/^\/api\/master-data\/items\/([^/]+)\/suppliers\/([^/]+)$/)
  if(req.method==='PATCH'&&relationshipMatch){if (!(await authorizeWrite('item-supplier-relationship'))) return true;try{send(res,200,{relationship:(await pricesFor([await repository.updateItemSupplier(decodeURIComponent(relationshipMatch[1]),decodeURIComponent(relationshipMatch[2]),await readBody(req),actor(),tenantScope())]))[0]})}catch(error){send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]})}return true}

  if (req.method === 'GET' && url.pathname === '/api/master-data/warehouses') {
    send(res, 200, { warehouses: await repository.listWarehouses(tenantScope()) })
    return true
  }

  const warehouseMatch = url.pathname.match(
    /^\/api\/master-data\/(warehouses|bins)\/([^/]+)$/,
  )
  if (req.method === 'GET' && warehouseMatch) {
    const rows = await repository.listWarehouses(tenantScope())
    const key = decodeURIComponent(warehouseMatch[2]).toLowerCase()
    const warehouse = rows.find((row) =>
      warehouseMatch[1] === 'bins'
        ? String(row.bin || row.id || '').toLowerCase() === key
        : [row.warehouseCode, row.id, row.warehouseName, row.name].some(
            (value) => String(value || '').toLowerCase() === key,
          ),
    )
    send(
      res,
      warehouse ? 200 : 404,
      warehouse ? { warehouse } : { error: 'Warehouse or bin not found' },
    )
    return true
  }

  if (
    req.method === 'GET' &&
    url.pathname === '/api/master-data/payment-terms'
  ) {
    send(res, 200, { paymentTerms: await repository.listPaymentTerms(tenantScope()) })
    return true
  }

  const paymentTermMatch = url.pathname.match(
    /^\/api\/master-data\/payment-terms\/([^/]+)$/,
  )
  if (req.method === 'GET' && paymentTermMatch) {
    const key = decodeURIComponent(paymentTermMatch[1]).toLowerCase()
    const paymentTerm = (await repository.listPaymentTerms(tenantScope())).find((row) =>
      [row.id, row.code, row.label, row.name].some(
        (value) => String(value || '').toLowerCase() === key,
      ),
    )
    send(
      res,
      paymentTerm ? 200 : 404,
      paymentTerm ? { paymentTerm } : { error: 'Payment term not found' },
    )
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/tax-codes') {
    send(res, 200, { taxCodes: await repository.listTaxCodes(tenantScope()) })
    return true
  }

  const taxCodeMatch = url.pathname.match(
    /^\/api\/master-data\/tax-codes\/([^/]+)$/,
  )
  if (req.method === 'GET' && taxCodeMatch) {
    const key = decodeURIComponent(taxCodeMatch[1]).toLowerCase()
    const taxCode = (await repository.listTaxCodes(tenantScope())).find((row) =>
      [row.id, row.code, row.label, row.name].some(
        (value) => String(value || '').toLowerCase() === key,
      ),
    )
    send(
      res,
      taxCode ? 200 : 404,
      taxCode ? { taxCode } : { error: 'Tax code not found' },
    )
    return true
  }

  return false
}
