// The one status the sales order list shows for an order, worked out from the
// three statuses it stores (workflow, reservation, fulfillment), with at most
// one hint under it. The stored statuses and the filters that send them do
// not change; the order detail keeps showing them one by one.
//
// A fully shipped order has used up its reservations, so its reservation
// status reads "Not reserved": that is never shown as its status or hint.

export type SalesOrderStatuses = {
  workflowStatus: string;
  reservationStatus: string;
  fulfillmentStatus: string;
};

export type SalesOrderStage =
  | "draft"
  | "confirmed"
  | "partially_reserved"
  | "ready_to_ship"
  | "partially_fulfilled"
  | "fully_fulfilled"
  | "on_hold"
  | "cancelled";

export type StageTone = "success" | "warning" | "info" | "neutral";

// Labels as [English, Chinese]; "Fulfilled" / 已履约 is the same word the order
// detail and the order evidence page use for a fully shipped order.
export const SALES_ORDER_STAGES: Record<SalesOrderStage, { label: [string, string]; tone: StageTone }> = {
  draft: { label: ["Draft", "草稿"], tone: "neutral" },
  confirmed: { label: ["Confirmed", "已确认"], tone: "info" },
  partially_reserved: { label: ["Partly reserved", "部分预留"], tone: "warning" },
  ready_to_ship: { label: ["Ready to ship", "可发货"], tone: "info" },
  partially_fulfilled: { label: ["Partly fulfilled", "部分履约"], tone: "info" },
  fully_fulfilled: { label: ["Fulfilled", "已履约"], tone: "success" },
  on_hold: { label: ["On hold", "暂停"], tone: "warning" },
  cancelled: { label: ["Cancelled", "已取消"], tone: "neutral" },
};

// Cancelled and draft first, then shipped in full (nothing is left to hold or
// reserve), then on hold, then how far shipping and reserving have got.
export function salesOrderStage(order: SalesOrderStatuses): SalesOrderStage {
  if (order.workflowStatus === "cancelled") return "cancelled";
  if (order.workflowStatus === "draft") return "draft";
  if (order.fulfillmentStatus === "fully_fulfilled") return "fully_fulfilled";
  if (order.workflowStatus === "on_hold") return "on_hold";
  if (order.fulfillmentStatus === "partially_fulfilled") return "partially_fulfilled";
  if (order.reservationStatus === "fully_reserved") return "ready_to_ship";
  if (order.reservationStatus === "partially_reserved") return "partially_reserved";
  return "confirmed";
}

// What the status leaves out, for an order on hold or partly shipped: how far
// it had got (part shipped), else whether stock is held for what is left.
export function salesOrderStageHint(order: SalesOrderStatuses, stage = salesOrderStage(order)): [string, string] | null {
  if (stage !== "on_hold" && stage !== "partially_fulfilled") return null;
  if (stage === "on_hold" && order.fulfillmentStatus === "partially_fulfilled") return ["Partly fulfilled", "部分履约"];
  if (order.reservationStatus === "fully_reserved") return ["Stock reserved", "已预留库存"];
  if (order.reservationStatus === "partially_reserved") return ["Partly reserved", "部分预留"];
  return null;
}
