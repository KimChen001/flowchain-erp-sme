import { INVENTORY_MOVEMENT_LEDGER, LOTS, TRANSFERS, VARIANCES } from "../../data/empty-business-state";
import type { InventoryMovement } from "../../types/scm";
import { INVENTORY_MOVEMENT_TYPE_LABELS, isInventoryMovementException, netInventoryImpact } from "./movements";

export type InventoryExceptionDocumentType = "库存调整" | "调拨差异" | "盘点差异关闭" | "冻结 / 释放";
export type InventoryExceptionDocumentStatus = "待复核" | "处理中" | "已复核" | "已关闭" | "已驳回";

export type InventoryExceptionDocument = {
  id: string;
  type: InventoryExceptionDocumentType;
  sku: string;
  itemName: string;
  warehouse: string;
  location: string;
  quantityImpact: number;
  unit: string;
  status: InventoryExceptionDocumentStatus;
  owner: string;
  linkedMovement?: string;
  linkedDocument: string;
  reason: string;
  evidence: { label: string; value: string }[];
  nextAction: string;
  timeline: { label: string; status: "done" | "current" | "warning" | "blocked" | "pending"; helper?: string }[];
};

function statusFromMovement(movement: InventoryMovement): InventoryExceptionDocumentStatus {
  if (movement.status === "已关闭") return "已关闭";
  if (movement.status === "已确认") return "已复核";
  if (movement.status === "异常处理") return "处理中";
  if (movement.status === "已取消") return "已驳回";
  return "待复核";
}

function typeFromMovement(movement: InventoryMovement): InventoryExceptionDocumentType {
  if (movement.movementType === "StockTransfer") return "调拨差异";
  if (movement.movementType === "CycleCountVariance") return "盘点差异关闭";
  if (movement.movementType === "StockAdjustment") return "库存调整";
  return "冻结 / 释放";
}

export function buildInventoryExceptionDocuments(): InventoryExceptionDocument[] {
  const movementDocs = INVENTORY_MOVEMENT_LEDGER
    .filter((movement) => isInventoryMovementException(movement) || ["StockAdjustment", "StockTransfer", "CycleCountVariance"].includes(movement.movementType))
    .map((movement, index) => {
      const type = typeFromMovement(movement);
      const status = statusFromMovement(movement);
      return {
        id: `IEX-2026-${String(index + 1).padStart(4, "0")}`,
        type,
        sku: movement.sku,
        itemName: movement.itemName,
        warehouse: movement.warehouse,
        location: movement.location,
        quantityImpact: netInventoryImpact(movement),
        unit: movement.unit,
        status,
        owner: movement.owner,
        linkedMovement: movement.movementId,
        linkedDocument: movement.sourceDocument,
        reason: movement.reason,
        evidence: [
          { label: "来源流水", value: movement.movementId },
          { label: "来源单据", value: movement.sourceDocument },
          { label: "移动类型", value: INVENTORY_MOVEMENT_TYPE_LABELS[movement.movementType] },
          ...movement.evidence,
        ],
        nextAction: status === "已关闭" ? "归档异常证据" : status === "已复核" ? "等待关闭" : type === "调拨差异" ? "确认目的仓签收" : type === "盘点差异关闭" ? "复核盘点原因" : "复核库存影响",
        timeline: [
          { label: "登记", status: "done" as const, helper: movement.date },
          { label: "证据复核", status: status === "待复核" ? "current" as const : "done" as const },
          { label: "关闭", status: status === "已关闭" ? "done" as const : status === "已驳回" ? "blocked" as const : "pending" as const },
        ],
      };
    });

  const frozenLotDocs = LOTS.filter((lot) => lot.status === "冻结").map((lot, index) => ({
    id: `IEX-2026-HOLD-${String(index + 1).padStart(2, "0")}`,
    type: "冻结 / 释放" as const,
    sku: lot.sku,
    itemName: lot.name,
    warehouse: "上海总仓",
    location: lot.warehouse,
    quantityImpact: 0,
    unit: "件",
    status: "处理中" as const,
    owner: "陈思远",
    linkedDocument: lot.lot,
    reason: "批次处于质量复核或冻结状态，需要补充放行证据。",
    evidence: [
      { label: "批次号", value: lot.lot },
      { label: "供应商", value: lot.supplier },
      { label: "COA", value: lot.coa ? "已提供" : "待补充" },
    ],
    nextAction: "复核 COA 与 QA 放行结论",
    timeline: [
      { label: "冻结", status: "done" as const, helper: lot.received },
      { label: "QA复核", status: "current" as const },
      { label: "释放/关闭", status: "pending" as const },
    ],
  }));

  const transferExceptionDocs = TRANSFERS.filter((transfer) => transfer.status === "在途" || transfer.status === "待审批").slice(0, 2).map((transfer, index) => ({
    id: `IEX-2026-TR-${String(index + 1).padStart(2, "0")}`,
    type: "调拨差异" as const,
    sku: transfer.sku,
    itemName: transfer.name,
    warehouse: transfer.from,
    location: `${transfer.from} -> ${transfer.to}`,
    quantityImpact: -transfer.qty,
    unit: "件",
    status: transfer.status === "待审批" ? "待复核" as const : "处理中" as const,
    owner: transfer.requester,
    linkedDocument: transfer.id,
    reason: "调拨状态尚未关闭，需要复核出库、在途和目的仓签收证据。",
    evidence: [
      { label: "调拨单", value: transfer.id },
      { label: "承运商", value: transfer.carrier },
      { label: "ETA", value: transfer.eta },
    ],
    nextAction: transfer.status === "待审批" ? "复核调拨申请" : "确认目的仓签收",
    timeline: [
      { label: "创建", status: "done" as const, helper: transfer.created },
      { label: "在途/审批", status: "current" as const },
      { label: "签收关闭", status: "pending" as const },
    ],
  }));

  return [...movementDocs, ...frozenLotDocs, ...transferExceptionDocs];
}

export function inventoryExceptionSummary(rows = buildInventoryExceptionDocuments()) {
  return {
    pendingAdjustment: rows.filter((row) => row.type === "库存调整" && ["待复核", "处理中"].includes(row.status)).length,
    transferException: rows.filter((row) => row.type === "调拨差异" && row.status !== "已关闭").length,
    countVariance: rows.filter((row) => row.type === "盘点差异关闭" && row.status !== "已关闭").length + VARIANCES.length,
    frozenInventory: rows.filter((row) => row.type === "冻结 / 释放" && row.status !== "已关闭").length,
    closed: rows.filter((row) => row.status === "已关闭").length,
  };
}

export function inventoryExceptionExportRows(rows = buildInventoryExceptionDocuments()) {
  return rows.map((row) => ({
    单据编号: row.id,
    类型: row.type,
    SKU: row.sku,
    品名: row.itemName,
    仓库: row.warehouse,
    库位: row.location,
    数量影响: row.quantityImpact,
    单位: row.unit,
    状态: row.status,
    负责人: row.owner,
    关联流水: row.linkedMovement || "",
    关联单据: row.linkedDocument,
    下一步: row.nextAction,
    原因: row.reason,
  }));
}
