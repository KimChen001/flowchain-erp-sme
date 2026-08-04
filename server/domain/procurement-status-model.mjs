import {
  PROCUREMENT_STATUS_VALUES,
  assertProcurementAuthorityTransition,
  canTransitionProcurementAuthorityStatus,
  normalizeProcurementAuthorityStatus,
} from './procurement-status-authority.mjs'

const LEGACY_DOMAIN_MAP = Object.freeze({
  purchaseRequest: 'purchaseRequestPreview',
  sourcingEvent: 'sourcingEventDraft',
  supplierResponse: 'supplierResponseDraft',
  awardRecommendation: 'awardRecommendationDraft',
  poDraft: 'purchaseOrderDraft',
})

export const PROCUREMENT_STATUS_GROUPS = Object.freeze({
  purchaseRequest: PROCUREMENT_STATUS_VALUES.purchaseRequestPreview,
  sourcingEvent: PROCUREMENT_STATUS_VALUES.sourcingEventDraft,
  supplierResponse: PROCUREMENT_STATUS_VALUES.supplierResponseDraft,
  awardRecommendation: PROCUREMENT_STATUS_VALUES.awardRecommendationDraft,
  poDraft: PROCUREMENT_STATUS_VALUES.purchaseOrderDraft,
})

export function normalizeProcurementStatus(documentType = '', status = '') {
  const domain = LEGACY_DOMAIN_MAP[String(documentType ?? '').trim()]
  if (!domain) return normalizeProcurementAuthorityStatus(documentType, status)
  return normalizeProcurementAuthorityStatus(domain, status)
}

export function isValidProcurementStatus(documentType = '', status = '') {
  try {
    normalizeProcurementStatus(documentType, status)
    return true
  } catch {
    return false
  }
}

export function canTransitionProcurementStatus(documentType = '', fromStatus = '', toStatus = '') {
  const domain = LEGACY_DOMAIN_MAP[String(documentType ?? '').trim()] || documentType
  return canTransitionProcurementAuthorityStatus(domain, fromStatus, toStatus)
}

export function assertSafeProcurementTransition(documentType = '', fromStatus = '', toStatus = '') {
  const domain = LEGACY_DOMAIN_MAP[String(documentType ?? '').trim()] || documentType
  return assertProcurementAuthorityTransition(domain, fromStatus, toStatus)
}
