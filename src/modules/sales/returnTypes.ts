export type SalesReturnStatus = "草稿" | "待审核" | "待收货" | "处理中" | "已完成" | "已驳回";

// Stored status values (they also appear in the status= URL parameter).
// Translate only their display text, never these values.
export const SALES_RETURN_ALL_STATUSES = "全部";
export const SALES_RETURN_STATUSES: SalesReturnStatus[] = ["草稿", "待审核", "待收货", "处理中", "已完成", "已驳回"];
export const SALES_RETURN_OPEN_STATUSES: SalesReturnStatus[] = ["待审核", "待收货", "处理中"];
export const SALES_RETURN_TONE: Record<SalesReturnStatus, "green" | "red" | "orange" | "blue"> = {
  "草稿": "blue",
  "待审核": "blue",
  "待收货": "orange",
  "处理中": "orange",
  "已完成": "green",
  "已驳回": "red",
};

export type SalesReturnLine = {
  sku: string;
  itemName: string;
  shippedQty: number;
  returnQty: number;
  receivedQty: number;
  unit: string;
  condition: string;
  remarks?: string;
};

export type SalesReturnNote = {
  id: string;
  returnNo: string;
  customer: string;
  salesOrderNo: string;
  deliveryNo: string;
  returnDate: string;
  returnReason: string;
  status: SalesReturnStatus;
  totalQuantity: number;
  warehouse: string;
  lines: SalesReturnLine[];
  remarks?: string;
  createdBy: string;
  reviewedBy?: string;
};
