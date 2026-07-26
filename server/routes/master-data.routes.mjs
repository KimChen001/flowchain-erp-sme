import { selectMasterData } from '../domain/master-data-selectors.mjs'
import { authorizeMutation } from '../domain/mutation-authorization.mjs'

function masterDataRepository(ctx) {
  if (!ctx.repositories?.masterData) throw new Error('PostgreSQL master data repository is not configured.')
  return ctx.repositories.masterData
}

export async function handleMasterDataRoute(ctx) {
  const { req, res, url, send, readBody } = ctx
  const repository = masterDataRepository(ctx)
  const authorizeWrite = resource => authorizeMutation(ctx, {
    allowedRoles: ['admin', 'manager', 'business-specialist', 'procurement-specialist', 'analyst'],
    action: 'maintain',
    resource,
  })
  const actor = () => ctx.identity.userId

  const selectorMatch = url.pathname.match(/^\/api\/master-data\/(departments|currencies|units|commodities|warehouses|payment-terms|tax-codes)\/select$/)
  if (req.method === 'GET' && selectorMatch) {
    const options = await selectMasterData(repository, selectorMatch[1])
    send(res, 200, { options })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data') {
    const [items, suppliers, customers, warehouses, paymentTerms, taxCodes] =
      await Promise.all([
        repository.listItems(),
        repository.listSuppliers(),
        repository.listCustomers(),
        repository.listWarehouses(),
        repository.listPaymentTerms(),
        repository.listTaxCodes(),
      ])
    send(res, 200, {
      items,
      suppliers,
      customers,
      warehouses,
      paymentTerms,
      taxCodes,
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/customers') {
    send(res, 200, { customers: await repository.listCustomers({
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || '',
    }) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/customers') {
    if (authorizeWrite('customer-master').blocked) return true
    try {
      send(res, 201, { customer: await repository.createCustomer(await readBody(req), actor()) })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  const customerStatusMatch = url.pathname.match(
    /^\/api\/master-data\/customers\/([^/]+)\/(activate|deactivate)$/,
  )
  if (req.method === 'POST' && customerStatusMatch) {
    if (authorizeWrite('customer-master').blocked) return true
    const body = await readBody(req)
    try {
      const customer = await repository.updateCustomer(customerStatusMatch[1], {
        status: customerStatusMatch[2] === 'activate' ? 'active' : 'inactive',
        expectedVersion: body.expectedVersion,
      }, actor())
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
    const customer = await repository.getCustomer(customerMatch[1])
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
        : repository.listItems)({
        purchasableOnly: url.searchParams.get('purchasable') === 'true',
      }),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/items') {
    if (authorizeWrite('item-master').blocked) return true
    if (!repository.createItem) {
      send(res, 501, {
        code: 'ADAPTER_WRITE_UNSUPPORTED',
        message: '当前数据适配器尚未启用物料写入',
      })
      return true
    }
    try {
      send(res, 201, {
        item: await repository.createItem(await readBody(req), actor()),
      })
    } catch (error) {
      send(res, error.status || 500, {
        code: error.code || 'PERSISTENCE_ERROR',
        message: error.message,
      })
    }
    return true
  }

  const itemMatch = url.pathname.match(/^\/api\/master-data\/items\/([^/]+)$/)
  if (req.method === 'GET' && itemMatch) {
    const itemId = itemMatch[1]
    const managedItem = repository.getManagedItem
      ? await repository.getManagedItem(itemId)
      : null
    const item = managedItem || await repository.getItem(itemId)
    if (!item) {
      send(res, 404, { error: 'Item not found' })
      return true
    }
    send(res, 200, { item })
    return true
  }

  if (req.method === 'PATCH' && itemMatch) {
    if (authorizeWrite('item-master').blocked) return true
    if (!repository.updateItem) {
      send(res, 501, {
        code: 'ADAPTER_WRITE_UNSUPPORTED',
        message: '当前数据适配器尚未启用物料写入',
      })
      return true
    }
    try {
      send(res, 200, {
        item: await repository.updateItem(
          itemMatch[1],
          await readBody(req),
          actor(),
        ),
      })
    } catch (error) {
      send(res, error.status || 500, {
        code: error.code || 'PERSISTENCE_ERROR',
        message: error.message,
      })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/suppliers') {
    send(res, 200, { suppliers: await repository.listSuppliers({ query:url.searchParams.get('query')||'', status:url.searchParams.get('status')||'', category:url.searchParams.get('category')||'' }) })
    return true
  }

  if (req.method === 'PATCH' && customerMatch) {
    if (authorizeWrite('customer-master').blocked) return true
    try {
      send(res, 200, { customer: await repository.updateCustomer(customerMatch[1], await readBody(req), actor()) })
    } catch (error) {
      send(res, error.status || 500, { code: error.code || 'PERSISTENCE_ERROR', message: error.message, details: error.details || [] })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/master-data/suppliers/select') {
    send(res, 200, { suppliers: await repository.selectSuppliers({ query:url.searchParams.get('query')||'' }) })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/master-data/suppliers') {
    if (authorizeWrite('supplier-master').blocked) return true
    if (!repository.createSupplier) { send(res,501,{code:'ADAPTER_WRITE_UNSUPPORTED',message:'当前数据适配器不支持供应商写入'}); return true }
    try { send(res,201,{supplier:await repository.createSupplier(await readBody(req),actor())}) } catch(error) { send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]}) }
    return true
  }

  const supplierMatch = url.pathname.match(
    /^\/api\/master-data\/suppliers\/([^/]+)$/,
  )
  if (req.method === 'GET' && supplierMatch) {
    const supplier = await repository.getSupplier(supplierMatch[1])
    if (!supplier) {
      send(res, 404, { error: 'Supplier not found' })
      return true
    }
    send(res, 200, { supplier })
    return true
  }

  if (req.method === 'PATCH' && supplierMatch) {
    if (authorizeWrite('supplier-master').blocked) return true
    try { send(res,200,{supplier:await repository.updateSupplier(supplierMatch[1],await readBody(req),actor())}) } catch(error) { send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]}) }
    return true
  }

  const supplierItems = url.pathname.match(/^\/api\/master-data\/suppliers\/([^/]+)\/items$/)
  if (req.method === 'GET' && supplierItems) { send(res,200,{relationships:await repository.listSupplierItems(decodeURIComponent(supplierItems[1]))}); return true }

  const itemSuppliers = url.pathname.match(/^\/api\/master-data\/items\/([^/]+)\/suppliers$/)
  if (req.method === 'GET' && itemSuppliers) { const itemId=decodeURIComponent(itemSuppliers[1]); send(res,200,{relationships:await repository.listItemSuppliers(itemId),suppliers:await repository.approvedSuppliersForItem(itemId)}); return true }
  if (req.method === 'POST' && itemSuppliers) { if(authorizeWrite('item-supplier-relationship').blocked)return true; try{send(res,201,{relationship:await repository.createItemSupplier(decodeURIComponent(itemSuppliers[1]),await readBody(req),actor())})}catch(error){send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]})} return true }
  const relationshipMatch=url.pathname.match(/^\/api\/master-data\/items\/([^/]+)\/suppliers\/([^/]+)$/)
  if(req.method==='PATCH'&&relationshipMatch){if(authorizeWrite('item-supplier-relationship').blocked)return true;try{send(res,200,{relationship:await repository.updateItemSupplier(decodeURIComponent(relationshipMatch[1]),decodeURIComponent(relationshipMatch[2]),await readBody(req),actor())})}catch(error){send(res,error.status||500,{code:error.code||'PERSISTENCE_ERROR',message:error.message,details:error.details||[]})}return true}

  if (req.method === 'GET' && url.pathname === '/api/master-data/warehouses') {
    send(res, 200, { warehouses: await repository.listWarehouses() })
    return true
  }

  const warehouseMatch = url.pathname.match(
    /^\/api\/master-data\/(warehouses|bins)\/([^/]+)$/,
  )
  if (req.method === 'GET' && warehouseMatch) {
    const rows = await repository.listWarehouses()
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
    send(res, 200, { paymentTerms: await repository.listPaymentTerms() })
    return true
  }

  const paymentTermMatch = url.pathname.match(
    /^\/api\/master-data\/payment-terms\/([^/]+)$/,
  )
  if (req.method === 'GET' && paymentTermMatch) {
    const key = decodeURIComponent(paymentTermMatch[1]).toLowerCase()
    const paymentTerm = (await repository.listPaymentTerms()).find((row) =>
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
    send(res, 200, { taxCodes: await repository.listTaxCodes() })
    return true
  }

  const taxCodeMatch = url.pathname.match(
    /^\/api\/master-data\/tax-codes\/([^/]+)$/,
  )
  if (req.method === 'GET' && taxCodeMatch) {
    const key = decodeURIComponent(taxCodeMatch[1]).toLowerCase()
    const taxCode = (await repository.listTaxCodes()).find((row) =>
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
