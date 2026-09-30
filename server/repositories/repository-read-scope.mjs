// Shared guards for the PostgreSQL read repositories.

// Every read is scoped to the caller's workspace. A missing tenant is a
// programming error upstream, so fail closed instead of reading some default
// workspace that may belong to another customer.
export function requireTenantId(filters = {}) {
  const tenantId = String(filters?.tenantId ?? '').trim()
  if (tenantId) return tenantId
  throw Object.assign(new Error('A workspace tenant is required to read business records.'), {
    code: 'TENANT_CONTEXT_REQUIRED',
    status: 403,
  })
}

// Reads at most `limit` rows. One extra row is requested so the caller can be
// told, through `onTruncated`, that more rows exist than were returned.
export async function findManyWithinLimit(delegate, args, { limit, subject, onTruncated } = {}) {
  const rows = await delegate.findMany({ ...args, take: limit + 1 })
  if (rows.length <= limit) return rows
  if (typeof onTruncated === 'function') onTruncated({ subject, limit })
  return rows.slice(0, limit)
}
