import { createDecisionItemRepository } from '../repositories/decision-item-repository.mjs'
import { databaseClient } from '../domain/today-work-read-service.mjs'
import { tenantCalendarDay } from '../domain/tenant-calendar-day.mjs'
import { readTenantTimezone } from '../domain/tenant-timezone.mjs'

// The first event-raised decision (owner 2026-11-13: act when something
// happens, not when someone opens a page). When a three-way match holds a
// supplier invoice, its decision item is raised at once, with the time of the
// match, so Today and the assistant's welcome count it before anyone reads
// Today. Reading Today still raises it as before (planDecisionSync); the
// unique active key keeps one item either way.
//
// Called after the match has committed and never awaited by the request, like
// the approval emails: a failure here cannot fail or slow the match.

const text = (value) => String(value ?? '').trim()
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(text(value)) ? text(value).slice(0, 10) : null)

export async function raiseInvoiceExceptionDecision(ctx, invoiceId, { now = new Date() } = {}) {
  try {
    const tenantId = text(ctx?.identity?.tenantId)
    const id = text(invoiceId)
    if (!tenantId || !id) return null
    const prisma = await databaseClient(ctx)
    if (!prisma?.decisionItem || !prisma?.supplierInvoice) return null
    const invoice = await prisma.supplierInvoice.findFirst({ where: { id, tenantId }, select: { id: true, status: true, invoiceDate: true } })
    if (text(invoice?.status) !== 'exception') return null
    const timeZone = await readTenantTimezone(ctx).catch(() => undefined)
    const today = tenantCalendarDay(now, timeZone)
    const row = { kind: 'bill_exception', entityType: 'supplier_invoice', recordId: invoice.id, date: day(invoice.invoiceDate) }
    await createDecisionItemRepository({ prisma }).applySync(tenantId, { create: [row], reopen: [], close: [] }, { now, today })
    return row
  } catch (error) {
    ctx?.reportError?.(error)
    return null
  }
}
