// Assigns document numbers inside the transaction that creates the document
// (rules in shared/document-numbering.mjs). The sequence row is created or
// advanced with one INSERT … ON CONFLICT … RETURNING, so two documents saved
// at once get different numbers; under a serializable transaction the loser
// retries with the rest of its write. A number already taken in the
// workspace (one typed in before this rule, for example) is skipped.
import { documentNumberPrefix, documentNumberType, formatDocumentNumber, numberingPeriod } from '../../shared/document-numbering.mjs'

const MAX_SKIPS = 50

export async function nextDocumentSequence(tx, { tenantId, documentType, period }) {
  const rows = await tx.$queryRaw`
    INSERT INTO "DocumentNumberSequence" ("tenantId", "documentType", "period", "lastValue", "updatedAt")
    VALUES (${tenantId}, ${documentType}, ${period}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "documentType", "period")
    DO UPDATE SET "lastValue" = "DocumentNumberSequence"."lastValue" + 1, "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "lastValue"`
  return Number(rows?.[0]?.lastValue)
}

// `isTaken(number)` says whether the workspace already has a document of
// this type with that number; it is called inside the same transaction.
// `at` is the moment the document is created (the month it is numbered in).
export async function allocateDocumentNumber(tx, { tenantId, documentType, at = new Date(), isTaken = async () => false, sequence = nextDocumentSequence }) {
  if (!tenantId) throw Object.assign(new Error('A workspace is required for a document number.'), { code: 'DOCUMENT_NUMBER_TENANT_REQUIRED' })
  if (!documentNumberType(documentType)) throw Object.assign(new Error(`Unknown document type for numbering: ${documentType}`), { code: 'DOCUMENT_NUMBER_TYPE_UNKNOWN' })
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true, operationalSettings: true } })
  const prefix = documentNumberPrefix(tenant?.operationalSettings?.numbering, documentType)
  const period = numberingPeriod(at, tenant?.timezone)
  for (let attempt = 0; attempt <= MAX_SKIPS; attempt += 1) {
    const number = formatDocumentNumber(prefix, period, await sequence(tx, { tenantId, documentType, period }))
    if (!(await isTaken(number))) return number
  }
  throw Object.assign(new Error('No free document number was found.'), { code: 'DOCUMENT_NUMBER_EXHAUSTED', status: 409 })
}
