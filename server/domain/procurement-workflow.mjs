import {
  PROCUREMENT_STATUS_TRANSITIONS,
  PURCHASE_ORDER_STATUS,
  PURCHASE_REQUEST_STATUS,
  RFQ_STATUS,
} from './procurement-status-authority.mjs'

export const PR_TRANSITIONS = PROCUREMENT_STATUS_TRANSITIONS.purchaseRequest
export const PO_TRANSITIONS = PROCUREMENT_STATUS_TRANSITIONS.purchaseOrderWorkflow
export const RFQ_TRANSITIONS = PROCUREMENT_STATUS_TRANSITIONS.rfq
export { PURCHASE_ORDER_STATUS, PURCHASE_REQUEST_STATUS, RFQ_STATUS }
export const PROCUREMENT_PATHS = ['undecided','direct_po','rfq']

export function procurementError(code, message, details = [], status = 422, extra = {}) {
  const error = new Error(message); Object.assign(error, { code, details, status, ...extra }); return error
}
export function assertVersion(entity, expectedVersion) {
  if (Number(expectedVersion) !== Number(entity.version)) throw procurementError('VERSION_CONFLICT','该记录已被其他用户更新，请重新加载后继续。',[],409,{ expectedVersion, currentVersion: entity.version, updatedAt: entity.updatedAt, updatedBy: entity.updatedBy })
}
export function transition(entity, next, transitions, expectedVersion, actor, action) {
  assertVersion(entity, expectedVersion)
  if (!(transitions[entity.status] || []).includes(next)) throw procurementError('INVALID_STATE_TRANSITION',`不能从 ${entity.status} 转换为 ${next}`,[],409,{ currentStatus: entity.status, currentVersion: entity.version })
  const before = structuredClone(entity); entity.status = next; entity.version += 1; entity.updatedAt = new Date().toISOString(); entity.updatedBy = actor
  return { before, after: structuredClone(entity), action }
}
export function recommendProcurementPath(pr, policy = {}, supplier = {}, price = {}) {
  const snapshot = { directPurchaseThreshold: Number(policy.directPurchaseThreshold ?? 50000), rfqRequiredAboveAmount: Number(policy.rfqRequiredAboveAmount ?? 100000), amount: Number(pr.totalAmount || 0), supplierSelected: Boolean(pr.supplierId), validPriceAvailable: Boolean(price.valid ?? pr.lines?.every(x => Number(x.unitPrice) >= 0)), supplierActive: supplier.active !== false, rfqRequiredByPolicy: false, newSupplier: Boolean(supplier.isNew), newItem: Boolean(pr.newItem), highRiskSupplier: supplier.risk === 'high', emergencyPurchase: Boolean(pr.emergencyPurchase), singleSource: Boolean(pr.singleSource), allowManagerOverride: policy.allowManagerOverride !== false }
  const reasons = []
  if (pr.status !== 'approved') reasons.push('采购申请尚未批准')
  if (!snapshot.supplierSelected) reasons.push('尚未确定供应商')
  if (!snapshot.validPriceAvailable) reasons.push('缺少有效价格')
  if (snapshot.amount >= snapshot.rfqRequiredAboveAmount) { snapshot.rfqRequiredByPolicy = true; reasons.push('金额达到强制询价阈值') }
  if (snapshot.newSupplier || snapshot.newItem || snapshot.highRiskSupplier) reasons.push('新供应商、新物料或高风险供应商需要询价')
  const recommendation = pr.status !== 'approved' ? 'manual_review' : reasons.length ? 'rfq' : 'direct_po'
  return { recommendation, recommendationReasons: reasons.length ? reasons : ['供应商、价格和金额满足直接采购条件'], policySnapshot: snapshot }
}
export function validateDirectPo(pr, policy = {}, permission = true) {
  const details = []
  if (pr.status !== 'approved') details.push({ field:'status', message:'采购申请尚未批准' })
  if (pr.procurementPath === 'rfq') details.push({ field:'procurementPath', message:'已选择询价采购' })
  if (!pr.supplierId) details.push({ field:'supplierId', message:'尚未选择供应商' })
  if (!pr.currency) details.push({ field:'currency', message:'尚未设置币种' })
  if (!pr.paymentTermsId) details.push({ field:'paymentTermsId', message:'尚未设置付款条款' })
  if (!pr.expectedDeliveryDate) details.push({ field:'expectedDeliveryDate', message:'尚未设置交付日期' })
  if (!pr.lines?.length || pr.lines.some(x => {
    const catalogValid = x.lineType === 'non_catalog_item'
      ? Boolean(x.itemNameSnapshot)
      : x.lineType === 'catalog_item'
        ? Boolean(x.itemId && x.sku && x.itemNameSnapshot)
        : Boolean(x.sku)
    return !catalogValid || Number(x.quantity) <= 0 || !(x.unitSnapshot || x.unit) || Number(x.unitPrice || 0) < 0
  })) details.push({ field:'lines', message:'采购明细不完整' })
  if (!permission) throw procurementError('PERMISSION_DENIED','无权创建采购订单',[],403)
  if (Number(pr.totalAmount) >= Number(policy.rfqRequiredAboveAmount ?? Infinity) && policy.allowManagerOverride === false) details.push({ field:'totalAmount', message:'公司策略要求询价且不可覆盖' })
  if (details.length) throw procurementError('DIRECT_PO_NOT_ALLOWED','当前采购申请不能直接创建采购订单',details)
  return true
}
