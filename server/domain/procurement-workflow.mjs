import {
  PROCUREMENT_STATUS_TRANSITIONS,
  PURCHASE_ORDER_STATUS,
  PURCHASE_REQUEST_STATUS,
  RFQ_STATUS,
} from './procurement-status-authority.mjs'
import { overrideNeeded, validateSupplierOverride } from '../../shared/supplier-override-reasons.mjs'

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

// A catalog line whose supplier is not the item's preferred supplier, while
// one is preferred, needs a reason from the fixed list; nothing else does
// (shared/supplier-override-reasons.mjs). The stored value names the
// preferred supplier as it was when the line was saved. Anything sent for a
// line that needs no reason is dropped.
const OVERRIDE_ISSUE_MESSAGES = Object.freeze({
  REASON_REQUIRED: 'Choose a reason',
  REASON_UNKNOWN: 'Choose a reason',
  NOTE_LENGTH: 'Add a note of 3 to 500 characters',
})
function supplierOverrideFor(line, index, supplierId, preferred) {
  const needed = overrideNeeded({ supplierId, preferredId: preferred?.id })
  const { value, issues } = validateSupplierOverride(line.supplierOverride, needed)
  if (!value) {
    if (!issues.length) return null
    const name = preferred.name || preferred.supplierName || preferred.id
    throw procurementError(
      'SUPPLIER_OVERRIDE_REASON_REQUIRED',
      `Line ${index + 1} does not use the item's preferred supplier (${name}). Choose a reason from the list; Other needs a note.`,
      issues.map((issue) => ({ field: `lines.${index}.supplierOverride.${issue.field}`, code: issue.code, message: OVERRIDE_ISSUE_MESSAGES[issue.code] })),
      400,
    )
  }
  return { ...value, preferredSupplierId: preferred.id, preferredSupplierName: preferred.name || preferred.supplierName || preferred.id }
}

// Validates and snapshots purchase request lines against master data. The
// itemRepository must already be scoped to the signed-in workspace; see
// tenantScopedProcurementMasterData.
export const canonicalPurchaseRequestLines = async (lines = [], itemRepository) =>
  Promise.all(
    lines.map(async (line, index) => {
      const lineType = line.sourceType || line.lineType ||
        (line.itemId || line.sku ? "catalog_item" : "non_catalog_item");
      const lineBasis = line.lineBasis || "quantity";
      const supplierId = String(line.supplierId || "").trim();
      if (!supplierId) throw procurementError("SUPPLIER_REQUIRED", "每一条采购行必须选择供应商", [{ field: `lines.${index}.supplierId` }], 400);
      const supplier = itemRepository?.getSupplier ? await itemRepository.getSupplier(supplierId) : { id: supplierId };
      if (!supplier) throw procurementError("SUPPLIER_NOT_FOUND", "供应商不存在", [{ field: `lines.${index}.supplierId` }], 400);
      if (["inactive", "disabled", "停用"].includes(String(supplier.status || "").toLowerCase())) throw procurementError("SUPPLIER_INACTIVE", "供应商已停用", [{ field: `lines.${index}.supplierId` }], 400);
      const supplierSnapshot = {
        id: supplier.id || supplierId,
        supplierCode: supplier.supplierCode || supplier.code || supplierId,
        supplierName: supplier.supplierName || supplier.name || supplierId,
      };
      const estimatedUnitPrice = line.estimatedUnitPrice ?? line.unitPrice;
      const quantity = line.quantity == null || line.quantity === "" ? null : Number(line.quantity);
      const estimatedAmount = lineBasis === "amount" ? Number(line.estimatedAmount) : Number(quantity) * Number(estimatedUnitPrice);
      if (lineBasis === "amount" ? !(estimatedAmount > 0) : !(quantity > 0 && Number(estimatedUnitPrice) >= 0 && estimatedUnitPrice !== "" && estimatedUnitPrice != null))
        throw procurementError("LINE_VALUE_REQUIRED", lineBasis === "amount" ? "预计总金额必须大于 0" : "数量和预计单价必须明确填写", [{ field: `lines.${index}.${lineBasis === "amount" ? "estimatedAmount" : "estimatedUnitPrice"}` }], 400);
      if (!line.needByDate) throw procurementError("NEED_BY_DATE_REQUIRED", "需求日期必填", [{ field: `lines.${index}.needByDate` }], 400);
      if (line.serviceStartDate && line.serviceEndDate && line.serviceStartDate > line.serviceEndDate) throw procurementError("INVALID_SERVICE_DATE_RANGE", "服务开始日期不得晚于结束日期", [{ field: `lines.${index}.serviceEndDate` }], 400);
      if (lineType === "non_catalog_item") {
        if (!String(line.itemNameSnapshot || line.itemName || "").trim())
          throw procurementError(
            "NON_CATALOG_ITEM_NAME_REQUIRED",
            "非目录物料名称必填",
            [{ field: `lines.${index}.itemNameSnapshot` }],
            400,
          );
        if (lineBasis === "quantity" && !String(line.unitSnapshot || line.unit || "").trim())
          throw procurementError(
            "NON_CATALOG_ITEM_UNIT_REQUIRED",
            "非目录物料单位必填",
            [{ field: `lines.${index}.unitSnapshot` }],
            400,
          );
        return {
          ...structuredClone(line),
          lineType, sourceType: lineType, lineBasis, supplierId, supplierSnapshot, quantity: lineBasis === "quantity" ? quantity : null,
          estimatedUnitPrice: lineBasis === "quantity" ? Number(estimatedUnitPrice) : null,
          estimatedAmount,
          itemId: null,
          sku: null,
          itemNameSnapshot: line.itemNameSnapshot || line.itemName,
          unitSnapshot: line.unitSnapshot || line.unit,
          specificationSnapshot:
            line.specificationSnapshot || line.specification || "",
          supplierOverride: null,
        };
      }
  if (!itemRepository)
    return {
      ...structuredClone(line),
          supplierOverride: null,
          itemNameSnapshot: line.itemNameSnapshot || line.itemName || "",
          unitSnapshot: line.unitSnapshot || line.unit || "",
          specificationSnapshot:
            line.specificationSnapshot || line.specification || "",
        };
  const item = await (itemRepository.getManagedItem || itemRepository.getItem)(line.itemId || line.sku);
      if (!item)
        throw procurementError(
          "ITEM_NOT_FOUND",
          "物料不存在",
          [{ field: `lines.${index}.itemId` }],
          400,
        );
      if (item.status !== "active")
        throw procurementError(
          "ITEM_INACTIVE",
          "物料已停用",
          [{ field: `lines.${index}.itemId` }],
          400,
        );
      if (!item.purchasable)
        throw procurementError(
          "ITEM_NOT_PURCHASABLE",
          "物料不允许采购",
          [{ field: `lines.${index}.itemId` }],
          400,
        );
      if (
        (line.itemId && line.itemId !== item.itemId) ||
        (line.sku && line.sku !== item.sku)
      )
        throw procurementError(
          "ITEM_MAPPING_MISMATCH",
          "itemId 与 SKU 不匹配",
          [{ field: `lines.${index}.sku` }],
          400,
        );
      let supplierOverride = null;
      if (itemRepository?.approvedSuppliersForItem) {
        const approved = await itemRepository.approvedSuppliersForItem(item.itemId);
        if (!approved.length) throw procurementError("ITEM_HAS_NO_APPROVED_SUPPLIER", "该 SKU 尚未维护可采购供应商，请先维护 SKU–供应商关系。", [{ field: `lines.${index}.supplierId` }], 400);
        if (!approved.some(row => row.id === supplierId)) throw procurementError("ITEM_SUPPLIER_RELATIONSHIP_INVALID", "所选供应商不是该 SKU 的已批准供应商", [{ field: `lines.${index}.supplierId` }], 400);
        supplierOverride = supplierOverrideFor(line, index, supplierId, approved.find((row) => row.preferred));
      } else if (item.defaultSupplierId && supplierId !== item.defaultSupplierId) {
        throw procurementError("ITEM_SUPPLIER_RELATIONSHIP_INVALID", "所选供应商不是该 SKU 的已批准供应商", [{ field: `lines.${index}.supplierId` }], 400);
      }
      return {
        ...structuredClone(line),
        lineType, sourceType: lineType, lineBasis, supplierId, supplierSnapshot, quantity: lineBasis === "quantity" ? quantity : null,
        estimatedUnitPrice: lineBasis === "quantity" ? Number(estimatedUnitPrice) : null,
        estimatedAmount,
        itemId: item.itemId,
        sku: item.sku,
        itemNameSnapshot: item.itemName,
        unitSnapshot: item.purchaseUnit || item.baseUnit,
        specificationSnapshot: item.specification || "",
        warehouseId: line.warehouseId || item.defaultWarehouseId || "",
        supplierOverride,
      };
    }),
  );

// Master data lookups for procurement commands, pinned to one workspace. The
// repository methods fall back to a default tenant when no scope is passed, so
// commands must never call them unscoped.
export function tenantScopedProcurementMasterData(repository, tenantId) {
  const scope = () => {
    const id = String(tenantId ?? '').trim()
    if (!id) throw procurementError('TENANT_CONTEXT_REQUIRED', 'A server-resolved tenant context is required.', [], 403)
    return { tenantId: id }
  }
  return {
    getSupplier: (id) => repository.getSupplier(id, scope()),
    getItem: (id) => repository.getItem(id, scope()),
    ...(typeof repository.approvedSuppliersForItem === 'function' ? { approvedSuppliersForItem: (itemId) => repository.approvedSuppliersForItem(itemId, scope()) } : {}),
  }
}
