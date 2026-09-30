import { randomUUID } from "node:crypto";
import {
  PR_TRANSITIONS,
  PO_TRANSITIONS,
  RFQ_TRANSITIONS,
  PURCHASE_ORDER_STATUS,
  PURCHASE_REQUEST_STATUS,
  RFQ_STATUS,
  assertVersion,
  canonicalPurchaseRequestLines,
  procurementError,
  recommendProcurementPath,
  transition,
  validateDirectPo,
} from "../domain/procurement-workflow.mjs";
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
export function createProcurementWorkflowService({
  repository,
  policyProvider = async () => ({}),
  permission = async () => true,
  itemRepository,
}) {
  const audit = (doc, entry) => {
    const record = { id: id("AUD"), timestamp: now(), ...entry };
    doc.auditEntries.push(record);
    return record.id;
  };
  const requirePermission = async (actor, action, entity) => {
    if (!(await permission(actor, action, entity)))
      throw procurementError(
        "PERMISSION_DENIED",
        "当前用户无权执行此操作",
        [],
        403,
      );
  };
  const canonicalLines = (lines = []) => canonicalPurchaseRequestLines(lines, itemRepository);
  return {
    async createPurchaseRequest(input, actor) {
      await requirePermission(actor, "pr.create", input);
      const lines = await canonicalLines(input.lines);
      return repository.transact((doc) => {
        const t = now();
        const pr = {
          id: input.id || id("PR"),
          workspaceId: input.workspaceId || "default",
          companyId: input.companyId || "default",
          status: PURCHASE_REQUEST_STATUS.DRAFT,
          procurementPath: "undecided",
          procurementPathDecision: null,
          requesterId: actor,
          departmentId: input.departmentId || "",
          defaultCurrency: input.defaultCurrency || input.currency || "CNY",
          currency: input.defaultCurrency || input.currency || "CNY",
          defaultNeedByDate: input.defaultNeedByDate || input.expectedDeliveryDate || "",
          totalAmount: lines.reduce((sum, line) => sum + Number(line.estimatedAmount), 0),
          lines,
          version: 1,
          createdAt: t,
          createdBy: actor,
          updatedAt: t,
          updatedBy: actor,
          auditTrailIds: [],
        };
        pr.auditTrailIds.push(
          audit(doc, {
            actor,
            entityType: "purchase_request",
            entityId: pr.id,
            action: "PR_CREATED",
            after: pr,
            result: "success",
          }),
        );
        doc.purchaseRequests.push(pr);
        return pr;
      });
    },
    async updatePurchaseRequestDraft(prId, input, actor) {
      await requirePermission(actor, "pr.update", { id: prId });
      const lines =
        input.lines === undefined
          ? undefined
          : await canonicalLines(input.lines);
      return repository.transact((doc) => {
        const pr = doc.purchaseRequests.find((x) => x.id === prId);
        if (!pr)
          throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
        assertVersion(pr, input.expectedVersion);
        if (pr.status !== PURCHASE_REQUEST_STATUS.DRAFT)
          throw procurementError(
            "INVALID_STATE_TRANSITION",
            "只有草稿可以编辑",
            [],
            409,
          );
        const before = structuredClone(pr);
        for (const key of [
          "departmentId",
          "defaultCurrency",
          "defaultNeedByDate",
          "lines",
          "emergencyPurchase",
          "singleSource",
          "reason",
        ])
          if (input[key] !== undefined)
            pr[key] = structuredClone(key === "lines" ? lines : input[key]);
        if (lines) { pr.totalAmount = lines.reduce((sum, line) => sum + Number(line.estimatedAmount), 0); pr.currency = input.defaultCurrency || pr.defaultCurrency; }
        pr.version++;
        pr.updatedAt = now();
        pr.updatedBy = actor;
        pr.auditTrailIds.push(
          audit(doc, {
            actor,
            entityType: "purchase_request",
            entityId: pr.id,
            action: "PR_UPDATED",
            before,
            after: pr,
            result: "success",
          }),
        );
        return pr;
      });
    },
    async transitionPurchaseRequest(
      prId,
      next,
      { expectedVersion, actor, reason = "" },
    ) {
      await requirePermission(
        actor,
        ["approved", "rejected"].includes(next) ? "pr.approve" : `pr.${next}`,
        { id: prId },
      );
      return repository.transact((doc) => {
        const pr = doc.purchaseRequests.find((x) => x.id === prId);
        if (!pr)
          throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
        const event = transition(
          pr,
          next,
          PR_TRANSITIONS,
          expectedVersion,
          actor,
          `PR_${next.toUpperCase()}`,
        );
        pr.auditTrailIds.push(
          audit(doc, {
            actor,
            entityType: "purchase_request",
            entityId: pr.id,
            reason,
            ...event,
            result: "success",
          }),
        );
        return pr;
      });
    },
    async recommendPath(prId, actor) {
      const pr = await repository.get("pr", prId);
      if (!pr)
        throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
      const result = recommendProcurementPath(
        pr,
        await policyProvider(pr),
        {},
        {},
      );
      await repository.transact((doc) => {
        audit(doc, {
          actor,
          entityType: "purchase_request",
          entityId: prId,
          action: "PROCUREMENT_PATH_RECOMMENDED",
          after: result,
          result: "success",
        });
        return result;
      });
      return result;
    },
    async recordPathDecision(prId, input, actor) {
      return repository.transact(async (doc) => {
        const pr = doc.purchaseRequests.find((x) => x.id === prId);
        if (!pr)
          throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
        assertVersion(pr, input.expectedVersion);
        if (
          (await repository.findLinkedPo(prId)) ||
          (await repository.findLinkedRfq(prId))
        )
          throw procurementError(
            "DOWNSTREAM_OBJECT_ALREADY_EXISTS",
            "已存在下游采购对象",
            [],
            409,
          );
        const rec = recommendProcurementPath(
          pr,
          await policyProvider(pr),
          {},
          {},
        );
        if (
          input.path === "direct_po" &&
          rec.recommendation === "rfq" &&
          !input.overrideReason
        )
          throw procurementError(
            "RFQ_REQUIRED_BY_POLICY",
            "选择直接采购需要填写覆盖原因",
          );
        pr.procurementPath = input.path;
        pr.procurementPathDecision = {
          path: input.path,
          selectedBy: actor,
          selectedAt: now(),
          reason: input.reason || "",
          recommendation: rec.recommendation,
          recommendationReasons: rec.recommendationReasons,
          policySnapshot: rec.policySnapshot,
          overrideReason: input.overrideReason || "",
        };
        pr.version++;
        pr.updatedAt = now();
        pr.updatedBy = actor;
        pr.auditTrailIds.push(
          audit(doc, {
            actor,
            entityType: "purchase_request",
            entityId: pr.id,
            action: input.overrideReason
              ? "PROCUREMENT_PATH_OVERRIDDEN"
              : "PROCUREMENT_PATH_SELECTED",
            after: pr.procurementPathDecision,
            policySnapshot: rec.policySnapshot,
            result: "success",
          }),
        );
        return pr;
      });
    },
    async createRfqFromPurchaseRequest(prId, input, actor) {
      const key = `purchase-request:${prId}:create-rfq`;
      const replay = await repository.idempotency(key);
      if (replay) return { ...replay.result, replayed: true };
      return repository.transact((doc) => {
        const pr = doc.purchaseRequests.find((x) => x.id === prId);
        if (!pr)
          throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
        assertVersion(pr, input.expectedVersion);
        if (pr.status !== PURCHASE_REQUEST_STATUS.APPROVED)
          throw procurementError(
            "INVALID_STATE_TRANSITION",
            "只有已批准采购申请可以发起询价",
            [],
            409,
          );
        const po = doc.purchaseOrders.find(
          (x) => x.sourcePrId === prId && x.status !== PURCHASE_ORDER_STATUS.CANCELLED,
        );
        if (po)
          throw procurementError(
            "DOWNSTREAM_OBJECT_ALREADY_EXISTS",
            "已存在采购订单",
            [],
            409,
          );
        const existing = doc.rfqs.find(
          (x) =>
            x.sourcePrId === prId &&
            ![RFQ_STATUS.CANCELLED, RFQ_STATUS.CLOSED].includes(x.status),
        );
        if (existing)
          return { purchaseRequest: pr, rfq: existing, replayed: true };
        const t = now();
        const rfq = {
          id: id("RFQ"),
          sourcePrId: pr.id,
          buyerId: pr.buyerId,
          title: input.title || `询价 ${pr.id}`,
          currency: pr.currency,
          dueDate: input.dueDate || pr.expectedDeliveryDate,
          invitedSupplierIds: input.invitedSupplierIds || [],
          lines: structuredClone(pr.lines),
          comments: pr.comments || "",
          sourcePurchaseRequestId: pr.id,
          status: RFQ_STATUS.DRAFT,
          version: 1,
          createdAt: t,
          createdBy: actor,
          updatedAt: t,
          updatedBy: actor,
          auditTrailIds: [],
        };
        pr.procurementPath = "rfq";
        pr.procurementPathDecision = {
          path: "rfq",
          selectedBy: actor,
          selectedAt: t,
          reason: input.reason || "",
          recommendation: input.recommendation || "rfq",
          recommendationReasons: input.recommendationReasons || [],
          policySnapshot: input.policySnapshot || {},
          overrideReason: "",
        };
        pr.version++;
        pr.updatedAt = t;
        pr.updatedBy = actor;
        rfq.auditTrailIds.push(
          audit(doc, {
            actor,
            entityType: "rfq",
            entityId: rfq.id,
            action: "RFQ_CREATED_FROM_PR",
            relatedEntityIds: [pr.id],
            idempotencyKey: key,
            after: rfq,
            result: "success",
          }),
        );
        doc.rfqs.push(rfq);
        const result = { purchaseRequest: pr, rfq };
        doc.idempotencyRecords.push({ key, result, createdAt: t });
        return result;
      });
    },
    async createDirectPoFromPurchaseRequest(prId, input, actor) {
      const key = `purchase-request:${prId}:create-direct-po`;
      const replay = await repository.idempotency(key);
      if (replay) return { ...replay.result, replayed: true };
      return repository.transact(async (doc) => {
        const pr = doc.purchaseRequests.find((x) => x.id === prId);
        if (!pr)
          throw procurementError("ENTITY_NOT_FOUND", "采购申请不存在", [], 404);
        assertVersion(pr, input.expectedVersion);
        const existing = doc.purchaseOrders.filter((x) => x.sourcePrId === prId && x.status !== PURCHASE_ORDER_STATUS.CANCELLED);
        if (existing.length) return { purchaseRequest: pr, createdPurchaseOrders: existing, replayed: true };
        if (
          doc.rfqs.some(
            (x) =>
              x.sourcePrId === prId &&
              ![RFQ_STATUS.CANCELLED, RFQ_STATUS.CLOSED].includes(x.status),
          )
        )
          throw procurementError(
            "DOWNSTREAM_OBJECT_ALREADY_EXISTS",
            "已存在活动询价",
            [],
            409,
          );
        if (pr.status !== PURCHASE_REQUEST_STATUS.APPROVED) throw procurementError("INVALID_STATE_TRANSITION", "只有已批准采购申请可以生成采购订单", [], 409);
        if (!pr.lines?.length || pr.lines.some((line) => !line.supplierId || !line.currency || !(line.targetWarehouseId || line.warehouseId || line.serviceLocationId)))
          throw procurementError("DIRECT_PO_NOT_ALLOWED", "采购行缺少供应商、币种或交付地点", [{ field: "lines" }]);
        const t = now();
        const groups = new Map();
        for (const line of pr.lines) {
          const warehouseId = line.targetWarehouseId || line.warehouseId || line.serviceLocationId;
          const groupKey = [line.supplierId, line.currency, warehouseId, line.legalEntityId || "", line.paymentTermsId || "", line.shippingTermsId || "", line.selectedContractId || ""].join("::");
          if (!groups.has(groupKey)) groups.set(groupKey, { supplierId: line.supplierId, currency: line.currency, warehouseId, paymentTermsId: line.paymentTermsId || "", shippingTermsId: line.shippingTermsId || "", selectedContractId: line.selectedContractId || "", lines: [] });
          groups.get(groupKey).lines.push(line);
        }
        const createdPurchaseOrders = [...groups.values()].map((group) => {
          const lines = group.lines.map((line) => ({ ...structuredClone(line), sourcePurchaseRequestLineId: line.lineId }));
          const totalAmount = lines.reduce((sum, line) => sum + Number(line.estimatedAmount), 0);
          const po = { id: id("PO"), sourcePrId: pr.id, sourcePurchaseRequestId: pr.id, sourceRfqId: null, procurementPath: "direct_po", supplierId: group.supplierId, supplierSnapshot: lines[0]?.supplierSnapshot || { id: group.supplierId, supplierCode: group.supplierId, supplierName: group.supplierId }, currency: group.currency, targetWarehouseId: group.warehouseId, paymentTermsId: group.paymentTermsId, shippingTermsId: group.shippingTermsId, selectedContractId: group.selectedContractId, orderDate: t.slice(0, 10), subtotal: totalAmount, taxAmount: 0, totalAmount, lines, supplierFacingNote: "", internalContext: lines.map((line) => ({ sourceLineId: line.lineId, internalLineComment: line.internalLineComment || null })), status: PURCHASE_ORDER_STATUS.DRAFT, transmissionStatus: "not_sent", version: 1, createdAt: t, createdBy: actor, updatedAt: t, updatedBy: actor, auditTrailIds: [] };
          po.auditTrailIds.push(audit(doc, { actor, entityType: "purchase_order", entityId: po.id, action: "PO_CREATED_FROM_PR", relatedEntityIds: [pr.id], idempotencyKey: key, after: po, result: "success" }));
          return po;
        });
        pr.procurementPath = "direct_po";
        pr.status = PURCHASE_REQUEST_STATUS.CONVERTED;
        pr.linkedPurchaseOrderIds = createdPurchaseOrders.map((po) => po.id);
        pr.version++;
        pr.updatedAt = t;
        pr.updatedBy = actor;
        doc.purchaseOrders.push(...createdPurchaseOrders);
        const result = { purchaseRequestId: pr.id, purchaseRequest: pr, createdPurchaseOrders };
        doc.idempotencyRecords.push({ key, result, createdAt: t });
        return result;
      });
    },
    validateDirectPo,
    transitionPurchaseOrder: async (poId, next, args) => {
      if (!(await permission(args.actor, `po.${next}`, { id: poId })))
        throw procurementError(
          "PERMISSION_DENIED",
          "当前用户无权执行此操作",
          [],
          403,
        );
      return repository.transact((doc) => {
        const po = doc.purchaseOrders.find((x) => x.id === poId);
        if (!po)
          throw procurementError("ENTITY_NOT_FOUND", "采购订单不存在", [], 404);
        const event = transition(
          po,
          next,
          PO_TRANSITIONS,
          args.expectedVersion,
          args.actor,
          `PO_${next.toUpperCase()}`,
        );
        po.auditTrailIds.push(
          audit(doc, {
            actor: args.actor,
            entityType: "purchase_order",
            entityId: po.id,
            ...event,
            result: "success",
          }),
        );
        return po;
      });
    },
    transitionRfq: async (rfqId, next, args) =>
      repository.transact((doc) => {
        const rfq = doc.rfqs.find((x) => x.id === rfqId);
        if (!rfq)
          throw procurementError("ENTITY_NOT_FOUND", "询价单不存在", [], 404);
        assertVersion(rfq, args.expectedVersion);
        if (!RFQ_TRANSITIONS[rfq.status]?.includes(next))
          throw procurementError(
            "INVALID_STATE_TRANSITION",
            `不能从 ${rfq.status} 转换为 ${next}`,
            [],
            409,
          );
        const before = structuredClone(rfq);
        rfq.status = next;
        rfq.version++;
        rfq.updatedAt = now();
        rfq.updatedBy = args.actor;
        rfq.auditTrailIds.push(
          audit(doc, {
            actor: args.actor,
            entityType: "rfq",
            entityId: rfq.id,
            action: `RFQ_${next.toUpperCase()}`,
            before,
            after: rfq,
            result: "success",
          }),
        );
        return rfq;
      }),
  };
}
