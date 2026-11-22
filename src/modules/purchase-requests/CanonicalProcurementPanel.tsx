import { useWorkspaceCopy } from "../../i18n/useWorkspaceCopy";
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { useI18n } from "../../i18n/I18n";
import { formatCalendarDay, formatLocaleAmount, formatQuantity, todayInTimeZone } from "../../lib/format";
import { unitLabel } from "../../i18n/unitLabels";
import { formatInstantDay } from "../business-documents/documentFormat";
import { useWarehouseNames } from "../../lib/useWarehouseNames";
import { usePermissionSet } from "../../lib/usePermissionSet";
import { orderedCurrencyCodes } from "../../lib/currencyOptions";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { CheckCircle2, ClipboardCheck, FileText, Plus, RefreshCw, Truck } from "lucide-react";
import { toast } from "sonner";
import { rememberDocumentNumbers, resolveDocumentNumbers } from "../../lib/documentNumbers";
import { useDetailCrumb } from "../../components/navigation/detailCrumb";
import { ApiError, apiJson, CURRENT_USER_KEY } from "../../lib/api-client";

// The signed-in person's name as the app stored it at sign-in; the server
// still records the requester from the session, whatever this shows.
function signedInName() {
  try {
    const user = JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || "null");
    return typeof user?.name === "string" ? user.name.trim() : "";
  } catch {
    return "";
  }
}
import { A, Card, DocumentHistoryPanel, Field, inputStyle, SectionHeader, useConfirm } from "../../components/ui";
import { DocumentShell, OverviewFields } from "../../components/document/DocumentShell";
import { BackToListLink } from "../procurement/BackToListLink";
import { ListPager, usePagedRows } from "../procurement/listPaging";
import { EntityLink } from "../../components/business/EntityLink";
import { tableBodyTextClass, tableLinkClass, tableScrollClass, tdClass, tdIdClass, tdNameClass, tdNowrapClass, tdNumericClass, tdNumericRightClass, thClass, thRightClass } from "../../components/ui/workbenchTable";
import { ExportButton, ListCard, ListSearchCard, ListStateRow, PrimaryButton, RefreshButton, ResetButton, RowMenu, StatusChip, listButtonClass, listHeadRowStyle, listRowClass, listRowStyle, rowActionClass, statusToneOf, RetryButton } from "../../components/ui/listLayout";
import { ActionableMetricCard } from "../../components/cards/ActionableMetricCard";
import { FormActionBar, FormHeader, FormLineCard, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from "../../components/ui/formLayout";
import { statusCodeLabel } from "../../i18n/statusLabels";
import { exportRowsToCsv } from "../../lib/data-export";
import { createClientTemporaryId } from "../../lib/client-id";
import { PrefillBanner, PrefillSourceChip } from "../../components/prefill/PrefillSource";
import { addCalendarDays, buildSuggestionTrail, parsePrefillLines, planNonCatalogPrefill, planPurchaseRequestPrefill, prefillLineQuery, type PrefillEntry, type PrefillOrigin, type SupplierChoice, type SupplierLastOrder } from "../../lib/prefill";
import { SupplierChoices } from "../../components/procurement/SupplierChoices";
import { SupplierOverrideCount, SupplierOverrideFlag, SupplierOverrideReason, hasSupplierOverride, supplierOverrideIssueText, type SupplierOverride } from "../../components/procurement/SupplierOverrideReason";
import { overrideNeeded, validateSupplierOverride } from "../../../shared/supplier-override-reasons.mjs";
import { PriceHistoryFacts, formatUnitPrice, priceHistoryKey, usePriceHistory } from "../procurement/PriceHistoryFacts";
import { procurementErrorText, type ErrorPair } from "../procurement/procurementErrors";

// Fallback sentences for a failed request; a known error code or HTTP status
// gets its own sentence (procurementErrors.ts), never the server's raw text.
const RETRY: ErrorPair = ["Try again in a moment.", "请稍后重试。"];
const LOAD_FAILED: ErrorPair = ["Purchase requests could not be loaded. Try again.", "采购申请数据加载失败，请重试。"];
const SOURCES_FAILED: ErrorPair = ["The item's supplier sources could not be loaded.", "供应商关系加载失败。"];
const SAVE_FAILED: ErrorPair = ["The purchase request could not be saved.", "采购申请保存失败。"];
const UPDATE_FAILED: ErrorPair = ["The purchase request could not be updated.", "采购申请更新失败。"];
const PREVIEW_FAILED: ErrorPair = ["The purchase orders this would create could not be read. Try again.", "无法读取将生成的采购订单，请重试。"];
// GET /api/procurement/requests/:id/purchase-order-preview.
type PurchaseOrderPreview = {
  purchaseOrderStatus: string;
  orders: { supplierId: string; supplierName: string | null; currency: string; warehouseId: string; lineCount: number; amount: string }[];
  issues: { code: string; message: string }[];
};

type Item = {
  itemId: string;
  id?: string;
  sku: string;
  itemName: string;
  name?: string;
  purchaseUnit: string;
  baseUnit: string;
  // The recorded stock unit; "" when none is (GET /api/master-data/items?purchasable=true).
  stockUnit?: string;
  specification: string;
  category?: string;
  defaultWarehouseId: string;
  defaultSupplierId: string;
};
// A catalog line is built in the item's stock unit: no conversion between
// units is recorded, so the server refuses any other unit
// (PURCHASE_UNIT_CONVERSION_MISSING) and never relabels it. An item without a
// recorded stock unit keeps its purchase unit, as the server does.
const requestLineUnit = (item: Item) => item.stockUnit || item.purchaseUnit || item.baseUnit;
type Supplier = {
  id: string;
  name: string;
  supplierName?: string;
  supplierCode?: string;
  status: string;
  preferred?: boolean;
  defaultCurrency?: string;
};
type SelectorOption = { id: string; code: string; label: string; metadata?: Record<string, unknown> };
type SupplierOption = Supplier & {
  supplierName?: string;
  supplierCode?: string;
  preferred?: boolean;
  referencePrice?: number;
  currency?: string;
  leadTimeDays?: number | null;
  minimumOrderQuantity?: number | string | null;
};
type Line = {
  lineId: string;
  sourceType: "catalog_item" | "non_catalog_item";
  lineBasis: "quantity" | "amount";
  itemId: string | null;
  sku: string | null;
  supplierId: string;
  supplierSnapshot?: { id: string; supplierCode: string; supplierName: string };
  itemNameSnapshot: string;
  unitSnapshot: string | null;
  specificationSnapshot: string;
  commodityId: string;
  quantity: string;
  estimatedUnitPrice: string;
  estimatedAmount: string;
  currency: string;
  targetWarehouseId: string;
  needByDate: string;
  serviceStartDate: string;
  serviceEndDate: string;
  internalLineComment: string;
  // Why the line's supplier is not the item's preferred one; null when not needed.
  supplierOverride?: SupplierOverride | null;
};
type PR = {
  // The internal id: URLs, links and API calls.
  id: string;
  // Whether this reader may approve the request now: it is submitted, they
  // hold the permission, and it is not their own request while someone else
  // may approve it (server/domain/approval-rights.mjs).
  canApprove?: boolean;
  // The document number people read (PR-YYYYMM-NNNN; the id for requests made before numbering).
  number?: string;
  status: string;
  version: number;
  requesterId: string;
  // The requester's name; the id only when the user is not known.
  requesterName?: string;
  departmentId: string;
  defaultCurrency: string;
  defaultNeedByDate: string;
  totalAmount: number;
  lines: Line[];
  linkedPurchaseOrderIds?: string[];
  // Older requests recorded a name here rather than a user id.
  requester?: string;
  createdAt?: string;
};
// The number people read; the id stays in links and calls.
const numberOf = (pr: Pick<PR, "id" | "number">) => pr.number || pr.id;
type FieldError = { field?: string; code?: string; message?: string };
const OVERRIDE_FIELD = /^lines\.(\d+)\.supplierOverride\.(reasonCode|note)$/;
// The message under a field, by field name; a server code with a sentence of
// its own wins (by "CODE.field", then "CODE").
const FIELD_MESSAGES: Record<string, ErrorPair> = {
  itemId: ["Choose an item.", "请选择物料。"],
  itemNameSnapshot: ["Enter the item or service name.", "请填写物料或服务名称。"],
  supplierId: ["Choose a supplier.", "请选择供应商。"],
  unitSnapshot: ["Choose a unit.", "请选择单位。"],
  quantity: ["Enter a quantity above 0.", "请输入大于 0 的数量。"],
  estimatedUnitPrice: ["Enter an estimated unit price (0 or more).", "请输入预计单价（可为 0）。"],
  estimatedAmount: ["Enter an amount above 0.", "请输入大于 0 的金额。"],
  needByDate: ["Choose a need-by date.", "请选择需求日期。"],
  defaultCurrency: ["Choose a currency.", "请选择币种。"],
  defaultNeedByDate: ["Enter a valid date.", "请输入有效日期。"],
};
const CODE_MESSAGES: Record<string, ErrorPair> = {
  "LINE_VALUE_REQUIRED.estimatedUnitPrice": ["Enter a quantity above 0 and an estimated unit price.", "请填写大于 0 的数量和预计单价。"],
  SUPPLIER_NOT_FOUND: ["This supplier is not in the workspace. Choose another.", "工作区中没有该供应商，请重新选择。"],
  SUPPLIER_INACTIVE: ["This supplier is inactive. Choose another.", "该供应商已停用，请选择其他供应商。"],
  ITEM_INACTIVE: ["This item is inactive.", "该物料已停用。"],
  ITEM_NOT_PURCHASABLE: ["This item cannot be purchased.", "该物料不允许采购。"],
  // The item's own problem, under its supplier field (design audit L1-31: it read "Choose a supplier.").
  ITEM_HAS_NO_APPROVED_SUPPLIER: ["This item has no approved supplier yet. Add it under Supplied items on a supplier's page (Suppliers in the sidebar) first.", "该物料还没有已批准的供应商，请先在供应商页面的“可供应物料”中添加（侧栏“供应商”）。"],
  ITEM_SUPPLIER_RELATIONSHIP_INVALID: ["This supplier is not an approved source for the item. Choose another.", "所选供应商不是该物料的已批准供应商，请重新选择。"],
};
const HEADER_FIELDS = new Set(["defaultCurrency", "defaultNeedByDate"]);
const LINE_FIELD = /^lines\.\d+\.(\w+)$/;
// The field an error is shown under, by name; "" when it belongs to the whole form.
const inlineFieldName = (error: FieldError) => {
  const field = error.field || "";
  const name = HEADER_FIELDS.has(field) ? field : LINE_FIELD.exec(field)?.[1] || "";
  return FIELD_MESSAGES[name] ? name : "";
};
// What the server refuses a line without (canonicalPurchaseRequestLines),
// checked before saving so each message shows under its field.
const missingLineFields = (lines: Line[]): FieldError[] =>
  lines.flatMap((line, index) => {
    const byQuantity = line.lineBasis === "quantity";
    const nonCatalog = line.sourceType === "non_catalog_item";
    const missing = [
      !nonCatalog && !line.itemId && "itemId",
      nonCatalog && !line.itemNameSnapshot.trim() && "itemNameSnapshot",
      !line.supplierId.trim() && "supplierId",
      nonCatalog && byQuantity && !String(line.unitSnapshot || "").trim() && "unitSnapshot",
      byQuantity && !(Number(line.quantity) > 0) && "quantity",
      byQuantity && (String(line.estimatedUnitPrice).trim() === "" || !(Number(line.estimatedUnitPrice) >= 0)) && "estimatedUnitPrice",
      !byQuantity && !(Number(line.estimatedAmount) > 0) && "estimatedAmount",
      !line.needByDate && "needByDate",
    ].filter((name): name is string => Boolean(name));
    return missing.map((name) => ({ field: `lines.${index}.${name}`, code: "REQUIRED" }));
  });
// The line fields a handoff (the assistant's purchase request draft) can fill.
type PrefillLineField = "itemId" | "itemNameSnapshot" | "unitSnapshot" | "supplierId" | "quantity" | "estimatedUnitPrice" | "targetWarehouseId" | "needByDate" | "internalLineComment";
// shortfall: the reorder list's shortfall when it raised the quantity to the
// supplier's minimum order, named in the quantity's label.
type LinePrefill = { origin: PrefillOrigin; intent: string | null; lineId: string; fields: Partial<Record<PrefillLineField, PrefillEntry>>; supplierChoices: SupplierChoice[]; shortfall?: number };
// A reorder list row whose shortfall was raised to the supplier's minimum
// order hands over quantityFrom=supplier_minimum and the shortfall
// (ReorderListPage). The quantity it hands over is that minimum, so it is
// labelled as the supplier's minimum, not as the shortfall, while the
// planner keeps it as handed over (a larger minimum of another supplier is
// labelled by the planner itself).
function supplierMinimumPrefill(fields: Partial<Record<PrefillLineField, PrefillEntry>>, query: URLSearchParams) {
  const shortfall = Number(query.get("shortfall"));
  const quantity = fields.quantity;
  if (query.get("origin") !== "reorder_list" || query.get("quantityFrom") !== "supplier_minimum" || quantity?.ref !== "reorder_list:gap" || !(shortfall > 0)) return { fields };
  return { fields: { ...fields, quantity: { ...quantity, source: "default" as const, ref: "reorder_list:supplier_minimum" } }, shortfall };
}
// Today in the workspace timezone (America/New_York when unknown), not UTC.
const today = (timeZone?: string) => todayInTimeZone(timeZone);
const makeLine = (date = ""): Line => ({
  lineId: createClientTemporaryId("pr-line"),
  sourceType: "catalog_item",
  lineBasis: "quantity",
  itemId: "",
  sku: "",
  supplierId: "",
  itemNameSnapshot: "",
  unitSnapshot: "",
  specificationSnapshot: "",
  commodityId: "",
  quantity: "",
  estimatedUnitPrice: "",
  estimatedAmount: "",
  currency: "",
  targetWarehouseId: "",
  needByDate: date,
  serviceStartDate: "",
  serviceEndDate: "",
  internalLineComment: "",
  supplierOverride: null,
});
const PR_STATUSES = ["draft", "submitted", "approved", "converted", "rejected", "withdrawn", "cancelled"];
// A link that opens the form: "New purchase request", or a handoff that
// fills it (the assistant, the reorder list, or several reorder list rows).
const opensForm = (params: URLSearchParams) =>
  params.get("mode") === "create" || params.get("lineType") === "non_catalog" || Boolean(params.get("itemId") || params.get("sku")) || params.getAll("line").length > 0;
// The status-based actions a request offers, on its list row and on its
// detail page alike, each shown only to a person holding the permission the
// server checks for it (PURCHASE_REQUEST_PERMISSIONS in
// server/services/procurement-request-command-service.mjs).
type RequestAction = "edit" | "submit" | "approve" | "reject" | "withdraw" | "reopen" | "cancel" | "generate-purchase-orders";
const REQUEST_ACTION_PERMISSION: Record<RequestAction, string> = {
  edit: "procurement.purchase_request.create",
  submit: "procurement.purchase_request.submit",
  approve: "procurement.purchase_request.approve",
  reject: "procurement.purchase_request.reject",
  withdraw: "procurement.purchase_request.submit",
  reopen: "procurement.purchase_request.create",
  cancel: "procurement.purchase_request.create",
  "generate-purchase-orders": "procurement.purchase_order.revise",
};
const REQUEST_ACTIONS_BY_STATUS: Record<string, RequestAction[]> = {
  // A request can be cancelled, with a reason, until it is turned into a
  // purchase order, and a rejected one goes back to draft to be revised
  // (design audit L1-16).
  draft: ["edit", "submit", "cancel"],
  submitted: ["approve", "reject", "withdraw", "cancel"],
  approved: ["generate-purchase-orders", "cancel"],
  rejected: ["reopen"],
};
// The step that moves a request on: the blue button of the detail header,
// first in a row's More menu.
const DETAIL_PRIMARY = new Set<RequestAction>(["submit", "approve", "reopen", "generate-purchase-orders"]);
// The approver's steps, offered only when the request says canApprove.
const APPROVER_ACTIONS = new Set<RequestAction>(["approve", "reject"]);
// Steps that end or refuse a request: red, as on a PO.
const DANGER_ACTIONS = new Set<RequestAction>(["reject", "cancel"]);
// Rows to a page, as on the purchase order list (design audit U-14).
const PR_LIST_PAGE_SIZE = 50;
const COPY = {
  // The metric tiles name each state as its status chip does, so a state has
  // one name on this page; the note says what it means.
  draftsNote: ["Saved, not yet submitted", "已保存，尚未提交"],
  awaitingApprovalNote: ["Waiting for an approver", "等待审批"],
  readyForPoNote: ["No purchase order yet", "尚未生成采购订单"],
  converted: ["Converted to PO", "已转采购订单"],
  convertedNote: ["Purchase orders created from the request", "已据此生成采购订单"],
  approve: ["Approve", "批准"],
  submit: ["Submit", "提交"],
  createPurchaseOrder: ["Create purchase order", "生成采购订单"],
  approved: ["Approved {number}", "已批准 {number}"],
  // 驳回, as the PO and the language policy say (design audit U-04).
  rejected: ["Rejected {number}", "已驳回 {number}"],
  withdrawn: ["Withdrew {number}; it is a draft again", "已撤回 {number}，已退回草稿"],
  submittedNumber: ["Submitted {number} for approval", "已提交 {number} 审批"],
  createdOrder: ["Created {po} from {number}", "已从 {number} 生成采购订单 {po}"],
  createdOrders: ["Created {count} purchase orders from {number}", "已从 {number} 生成 {count} 张采购订单"],
  createdOn: ["Created", "创建日期"],
  deliverTo: ["Deliver to", "交付地点"],
  searchTitle: ["Purchase request search", "采购申请查询"],
  searchSubtitle: ["Search requests by number, item, requester and status.", "按申请编号、物料、申请人和状态查询采购申请。"],
  requestNumber: ["Request number", "申请编号"],
  itemOrSku: ["Item / SKU", "物料 / SKU"],
  itemPlaceholder: ["SKU or item name", "SKU 或物料名称"],
  requester: ["Requester", "申请人"],
  requesterPlaceholder: ["Requester name", "申请人姓名"],
  status: ["Status", "状态"],
  allStatuses: ["All statuses", "全部状态"],
  listTitle: ["Purchase request list", "采购申请列表"],
  item: ["Item", "物料"],
  supplier: ["Supplier", "供应商"],
  needBy: ["Need by", "需求日期"],
  amount: ["Amount", "金额"],
  purchaseOrders: ["Purchase orders", "采购订单"],
  actions: ["Actions", "操作"],
  view: ["View", "查看"],
  created: ["Created", "创建于"],
  moreLines: ["+{count} more lines", "另 {count} 行"],
  notChosen: ["Not chosen", "未选择"],
  nonCatalog: ["Non-catalog", "非目录"],
  noMatch: ["No purchase requests match these filters", "没有符合筛选条件的采购申请"],
  quantityPrice: ["Quantity × unit price", "数量 × 单价"],
  requestDetails: ["Request details", "申请信息"],
  lines: ["Purchase lines", "采购行"],
  lineAmount: ["Line amount", "行金额"],
  preferred: ["Preferred", "首选"],
  edit: ["Edit", "编辑"],
  submitForApproval: ["Submit for approval", "提交审批"],
  backToRequest: ["Back to the purchase request", "返回采购申请"],
  rejectTitle: ["Reject this purchase request?", "驳回该采购申请？"],
  rejectBody: ["It will not be approved or turned into a purchase order.", "该申请将不会被批准，也不会生成采购订单。"],
  rejectReason: ["Why is it rejected?", "驳回原因"],
  reject: ["Reject", "驳回"],
  goBack: ["Go back", "返回"],
  deleteLineTitle: ["Delete purchase line {line}?", "删除采购行 {line}？"],
  deleteLineBody: ["The line is removed from this form. Nothing is saved until you save the request.", "该行将从表单中移除；保存申请前不会保存任何更改。"],
  deleteLine: ["Delete line", "删除采购行"],
  withdrawTitle: ["Withdraw {number}?", "撤回 {number}？"],
  withdrawBody: ["It leaves the approval queue and goes back to draft. You can edit it and submit it again.", "该申请将退出审批并退回草稿；可以修改后重新提交。"],
  withdraw: ["Withdraw", "撤回"],
  cancel: ["Cancel request", "取消申请"],
  cancelTitle: ["Cancel {number}?", "取消 {number}？"],
  cancelBody: ["It will not be approved or turned into a purchase order, and it cannot be reopened.", "该申请将不会被批准，也不会生成采购订单，且不能恢复。"],
  cancelReason: ["Why is it cancelled?", "取消原因"],
  cancelledNumber: ["Cancelled {number}", "已取消 {number}"],
  reopen: ["Return to draft", "退回草稿"],
  reopenedNumber: ["{number} is a draft again. Edit it and submit it again.", "{number} 已退回草稿，可修改后重新提交。"],
  // L1-26: what "Create purchase order" will make, before it is made.
  convertTitleOne: ["Create a purchase order from {number}?", "从 {number} 生成采购订单？"],
  convertTitleMany: ["Create {count} purchase orders from {number}?", "从 {number} 生成 {count} 张采购订单？"],
  convertApproved: ["Each order starts approved, as the request was. Send it to the supplier, then mark it issued on its page.", "订单随申请一并批准；发给供应商后在订单页标记为已下达。"],
  convertDraft: ["Each order starts as a draft and goes for purchase order approval.", "每张订单以草稿开始，需经采购订单审批。"],
  lineOne: ["1 line", "1 行"],
  lineMany: ["{count} lines", "{count} 行"],
  previewFailed: ["The purchase orders this would create could not be read. Try again.", "无法读取将生成的采购订单，请重试。"],
  // The detail page in the PO's layout (design audit U-09).
  moduleLabel: ["Purchase request", "采购申请"],
  notFound: ["Purchase request not found.", "未找到采购申请。"],
  overview: ["Overview", "概览"],
  estimatedTotal: ["Estimated total", "预计总额"],
  department: ["Department", "部门"],
  currency: ["Currency", "币种"],
  defaultNeedBy: ["Default need by", "默认需求日期"],
  changes: ["Changes", "变更记录"],
  history: ["Changes to this request", "申请变更记录"],
  historyEmpty: ["No changes recorded for this request yet.", "此申请暂无变更记录。"],
  more: ["More", "更多"],
  // L1-31: the item field's label in both languages.
  skuOrOther: ["SKU / other", "SKU / 其他"],
} as const;
const request = <T,>(url: string, method = "GET", body?: unknown) =>
  apiJson<T>(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export default function CanonicalProcurementPanel({
  onNavigate,
  focus,
}: {
  onNavigate?: (id: string, focus?: unknown) => void;
  focus?: { entityType: string; entityId: string; at: number } | null;
}) {
  const copy = useWorkspaceCopy();
  const { timezone, locale, language } = useI18n();
  const errorText = (error: unknown, fallback: ErrorPair) => procurementErrorText(error, language, fallback);
  const warehouseName = useWarehouseNames();
  // Amounts use the document currency; without one they stay a plain number.
  const amount = (value: unknown, currencyCode?: string | null) =>
    value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
      ? "—"
      : formatLocaleAmount(Number(value), currencyCode, locale, { maximumFractionDigits: 2 });
  const dayText = (value?: string | null) => !value ? "—" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDay(value, locale) : formatInstantDay(value, locale, timezone);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // The navigation the form was last filled from: each handoff is a new one,
  // so a handoff while the page is open (the assistant opening another
  // request, or the same one again) fills the form again.
  const prefilled = useRef<string | null>(null);
  // One entry per prefilled line: the address fills one line, or several
  // reorder list rows at once (`line`, design audit L3-24).
  const [prefills, setPrefills] = useState<LinePrefill[]>([]);
  const prefill = prefills[0] ?? null;
  const prefillOf = (line: Line) => prefills.find((entry) => entry.lineId === line.lineId) ?? null;
  const [items, setItems] = useState<Item[]>([]),
    [suppliers, setSuppliers] = useState<Supplier[]>([]),
    [warehouses, setWarehouses] = useState<SelectorOption[]>([]),
    [departments, setDepartments] = useState<SelectorOption[]>([]),
    [currencies, setCurrencies] = useState<SelectorOption[]>([]),
    [units, setUnits] = useState<SelectorOption[]>([]),
    [commodities, setCommodities] = useState<SelectorOption[]>([]),
    [rows, setRows] = useState<PR[]>([]);
  const [itemSuppliers, setItemSuppliers] = useState<
    Record<string, SupplierOption[]>
  >({});
  const [departmentId, setDepartmentId] = useState("operations"),
    [currency, setCurrency] = useState(""),
    [workspaceCurrency, setWorkspaceCurrency] = useState(""),
    // No default need-by date: today is never when goods can arrive. A
    // line's date is today + its supplier's lead time when one is recorded,
    // or the person picks it (design audit L7-09).
    [defaultDate, setDefaultDate] = useState(""),
    [lines, setLines] = useState<Line[]>(() => [makeLine()]),
    [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<PR | null>(null),
    [errors, setErrors] = useState<FieldError[]>([]),
    // Which save is running: the draft or the submit.
    [saving, setSaving] = useState<"" | "draft" | "submit">(""),
    // The list and the selectors have loaded: the list's loading row, and a
    // non-catalog handoff matching its unit and supplier, wait on it.
    [loaded, setLoaded] = useState(false);
  const tr = (key: keyof typeof COPY) => COPY[key][language === "en-US" ? 0 : 1];
  const pair = (value: ErrorPair) => value[language === "en-US" ? 0 : 1];
  const formCopy = useFormCopy();
  const formRef = useRef<HTMLDivElement>(null);
  const confirmDialog = useConfirm();
  // Each action needs the permission the server checks for it
  // (REQUEST_ACTION_PERMISSION: editing and submitting follow PO revise).
  const permissions = usePermissionSet();
  // The request whose detail page opened the edit form, if any.
  const detailEdit = useRef("");
  const [submitting, setSubmitting] = useState(false);
  // A converted request reads "Converted to PO" here, on its chip, tile and
  // filter alike.
  // A submitted request waits for approval and reads as a PO in that state does:
  // "Pending approval / 待审批"; the stored code stays submitted (design audit U-11).
  const statusLabel = (status: string) => (status === "converted" ? tr("converted") : status === "submitted" ? statusCodeLabel("pending_approval", language) || copy(status) : statusCodeLabel(status, language) || copy(status));
  // What this person may do to a request in its status; nothing while the
  // permissions load or when they cannot be read.
  // Approve and Reject only when the server says this reader may approve it,
  // so a requester never meets a button the approval would refuse (C4).
  const actionsFor = (pr: PR) => (REQUEST_ACTIONS_BY_STATUS[pr.status] || []).filter((action) => Boolean(permissions?.has(REQUEST_ACTION_PERMISSION[action])) && (!APPROVER_ACTIONS.has(action) || pr.canApprove === true));
  // The request an action is running on, so its buttons cannot be pressed twice.
  const [acting, setActing] = useState("");
  const actionLabel = (action: RequestAction) =>
    tr(action === "generate-purchase-orders" ? "createPurchaseOrder" : action);
  // The list shows first; the form opens from "New purchase request", Edit,
  // or a link that asks for it.
  const [formOpen, setFormOpen] = useState(() => opensForm(searchParams));
  useEffect(() => {
    if (opensForm(searchParams)) setFormOpen(true);
    // Back from a new request's address (?mode=create) closes its form; an
    // edit has no address of its own and stays open (design audit U-13).
    else if (formOpen && !editing && !detailEdit.current) {
      reset();
      setFormOpen(false);
    }
  }, [location.key]);
  const [filters, setFilters] = useState({ number: "", item: "", requester: "" });
  // The status filter lives in the URL, so the metric cards can set it.
  const statusFilter = searchParams.get("status") || "";
  const setStatusFilter = (status: string) => {
    const params = new URLSearchParams(searchParams);
    if (status) params.set("status", status); else params.delete("status");
    setSearchParams(params, { replace: true });
  };
  const currencyInitialized = useRef(false);
  // A request opens by its id or by its number, as a PO does (design audit U-08).
  const focusKey = focus?.entityType === "purchase_request" ? focus.entityId : "";
  const selected = focusKey
    ? rows.find((row) => row.id === focusKey || (row.number || "").toLowerCase() === focusKey.toLowerCase())
    : null;
  // The breadcrumb names the request by its number, not the id in the address.
  useDetailCrumb(selected ? numberOf(selected) : null);
  const load = async () => {
    try {
      const [prs, catalog, selector, departmentSelector, currencySelector, unitSelector, commoditySelector, warehouseSelector, settings] = await Promise.all([
        request<PR[]>("/api/procurement/requests"),
        request<{ items: Item[] }>("/api/master-data/items?purchasable=true"),
        request<{ suppliers: SupplierOption[] }>(
          "/api/master-data/suppliers/select",
        ),
        request<{ options: SelectorOption[] }>("/api/master-data/departments/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/currencies/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/units/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/commodities/select"),
        request<{ options: SelectorOption[] }>("/api/master-data/warehouses/select"),
        request<{ company: { currency: string } }>("/api/settings-runtime").catch(() => null),
      ]);
      rememberDocumentNumbers("purchase_request", prs, (pr) => [pr.id, pr.number]);
      setRows(prs);
      setItems(catalog.items);
      setSuppliers(
        selector.suppliers.map((s) => ({
          ...s,
          name: s.name || s.supplierName || s.id,
        })),
      );
      setDepartments(departmentSelector.options);
      setCurrencies(currencySelector.options);
      setWorkspaceCurrency(settings?.company.currency || "");
      if (!currencyInitialized.current) {
        currencyInitialized.current = true;
        setCurrency(settings?.company.currency || "");
      }
      setUnits(unitSelector.options);
      setCommodities(commoditySelector.options);
      setWarehouses(warehouseSelector.options);
      setLoaded(true);
      setLoadError("");
    } catch (error: any) {
      setLoadError(errorText(error, RETRY));
      throw error;
    }
  };
  useEffect(() => {
    load().catch((e) => toast.error(errorText(e, LOAD_FAILED)));
  }, []);
  // A handoff opens the form with one line filled from the query: the item,
  // the quantity and reason the assistant computed, and the master data
  // defaults for that item. Every filled field shows where its value came
  // from, and nothing is saved until the user saves.
  // A filled-in request keeps the header's default date on its line's date:
  // on 2026-11-04 the header said today while the line said 11-21.
  const followLineDate = (day: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) setDefaultDate(day);
  };
  // The request line a prefill plan fills for an item: the item's own
  // snapshot and the plan's values (one line, or each of several).
  const lineFromPlan = (item: Item, itemId: string, plan: ReturnType<typeof planPurchaseRequestPrefill>): Line => ({
    ...makeLine(defaultDate),
    itemId,
    sku: item.sku,
    itemNameSnapshot: item.itemName || item.name || "",
    unitSnapshot: requestLineUnit(item),
    specificationSnapshot: item.specification || "",
    commodityId: item.category || "",
    targetWarehouseId: plan.values.targetWarehouseId,
    quantity: plan.values.quantity,
    supplierId: plan.values.supplierId,
    estimatedUnitPrice: plan.values.estimatedUnitPrice,
    currency: plan.values.currency || currency,
    needByDate: plan.values.needByDate,
    internalLineComment: plan.values.internalLineComment,
  });
  useEffect(() => {
    const handoff = location.key;
    if (prefilled.current === handoff) return;
    // An item the workspace does not have (owner, 2026-11-04): one "Other"
    // line with only what the user wrote, each field marked as theirs. The
    // person adds the category and price, and saves.
    if (searchParams.get("lineType") === "non_catalog") {
      if (!loaded) return;
      prefilled.current = handoff;
      const plan = planNonCatalogPrefill({ query: Object.fromEntries(searchParams.entries()), units, suppliers, defaultDate });
      const line: Line = {
        ...makeLine(defaultDate),
        sourceType: "non_catalog_item",
        itemNameSnapshot: plan.values.itemNameSnapshot,
        quantity: plan.values.quantity,
        unitSnapshot: plan.values.unitSnapshot,
        supplierId: plan.values.supplierId,
        currency,
        needByDate: plan.values.needByDate,
        internalLineComment: plan.values.internalLineComment,
      };
      setLines([line]);
      followLineDate(line.needByDate);
      setPrefills([{ origin: plan.origin, intent: plan.intent, lineId: line.lineId, fields: plan.fields, supplierChoices: [] }]);
      return;
    }
    if (!items.length) return;
    // Several reorder list rows: one line each, planned as a single line is,
    // in the order given; rows whose item is not found are left out.
    const many = parsePrefillLines(searchParams.getAll("line"))
      .map((wanted) => ({ wanted, item: items.find((row) => (row.itemId || row.id) === wanted.itemId || row.sku === wanted.itemId) }))
      .filter((row): row is { wanted: typeof row.wanted; item: Item } => Boolean(row.item));
    if (searchParams.getAll("line").length) {
      if (!many.length) return;
      prefilled.current = handoff;
      const shared = Object.fromEntries(searchParams.entries());
      Promise.all(many.map(({ wanted, item }) => {
        const itemId = item.itemId || item.id || "";
        return Promise.all([
          request<{ suppliers: SupplierOption[] }>(`/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`),
          request<{ lastOrders: (SupplierLastOrder & { supplierId: string })[] }>(`/api/procurement/item-supplier-orders?itemId=${encodeURIComponent(itemId)}`)
            .then((payload) => Object.fromEntries(payload.lastOrders.map((row) => [row.supplierId, row])))
            .catch(() => null),
        ]).then(([result, lastOrders]) => ({ wanted, item, itemId, suppliers: result.suppliers, lastOrders }));
      }))
        .then((rows) => {
          setItemSuppliers((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.itemId, row.suppliers])) }));
          const built = rows.map((row) => {
            const query = prefillLineQuery(shared, { ...row.wanted, itemId: row.itemId });
            const plan = planPurchaseRequestPrefill({ query, item: { itemId: row.itemId, defaultWarehouseId: row.item.defaultWarehouseId }, suppliers: row.suppliers, today: today(timezone), defaultDate, lastOrders: row.lastOrders });
            const line = lineFromPlan(row.item, row.itemId, plan);
            return { line, prefill: { origin: plan.origin, intent: plan.intent, lineId: line.lineId, ...supplierMinimumPrefill(plan.fields, new URLSearchParams(query)), supplierChoices: plan.supplierChoices } };
          });
          setLines(built.map((entry) => entry.line));
          // The header's default date is the earliest line's.
          followLineDate(built.map((entry) => entry.line.needByDate).filter(Boolean).sort()[0] || "");
          setPrefills(built.map((entry) => entry.prefill));
        })
        .catch((error) => toast.error(errorText(error, SOURCES_FAILED)));
      return;
    }
    const requestedItem = searchParams.get("itemId") || searchParams.get("sku");
    if (!requestedItem) return;
    const item = items.find(
      (row) =>
        (row.itemId || row.id) === requestedItem || row.sku === requestedItem,
    );
    if (!item) return;
    prefilled.current = handoff;
    const itemId = item.itemId || item.id || "";
    // The last PO date of each source orders the list a person chooses from
    // when none is preferred; without them (no PO read rights, or an error)
    // the list is A-Z and says the dates are not available.
    Promise.all([
      request<{ suppliers: SupplierOption[] }>(
        `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
      ),
      request<{ lastOrders: (SupplierLastOrder & { supplierId: string })[] }>(
        `/api/procurement/item-supplier-orders?itemId=${encodeURIComponent(itemId)}`,
      )
        .then((payload) => Object.fromEntries(payload.lastOrders.map((row) => [row.supplierId, row])))
        .catch(() => null),
    ])
      .then(([result, lastOrders]) => {
        setItemSuppliers((current) => ({
          ...current,
          [itemId]: result.suppliers,
        }));
        const plan = planPurchaseRequestPrefill({
          query: Object.fromEntries(searchParams.entries()),
          item: { itemId, defaultWarehouseId: item.defaultWarehouseId },
          suppliers: result.suppliers,
          today: today(timezone),
          defaultDate,
          lastOrders,
        });
        const line = lineFromPlan(item, itemId, plan);
        setLines([line]);
        followLineDate(line.needByDate);
        setPrefills([{ origin: plan.origin, intent: plan.intent, lineId: line.lineId, ...supplierMinimumPrefill(plan.fields, searchParams), supplierChoices: plan.supplierChoices }]);
      })
      .catch((error) => toast.error(errorText(error, SOURCES_FAILED)));
  }, [items, loaded, searchParams, location.key]);
  const prefillChip = (line: Line, field: PrefillLineField) => {
    const entry = prefillOf(line);
    return entry ? (
      <PrefillSourceChip
        entry={entry.fields[field]}
        current={line[field] ?? ""}
        testId={`prefill-source-${field}`}
        // "Supplier minimum (shortfall 19 pcs)": the shortfall in the line's unit.
        params={field === "quantity" && entry.shortfall ? { shortfall: `${formatQuantity(entry.shortfall)}${line.unitSnapshot ? ` ${unitLabel(line.unitSnapshot, language, entry.shortfall)}` : ""}` } : undefined}
      />
    ) : null;
  };
  // Earlier PO prices for every catalog line, in one request. Never fills a price.
  const priceHistoryKeyOf = (line: Line) => line.sourceType === "catalog_item" ? priceHistoryKey({ itemId: line.itemId, unit: line.unitSnapshot, currency: line.currency || currency }) : "";
  const priceHistory = usePriceHistory(lines.map(priceHistoryKeyOf));
  // A field's message goes once the field changes; Save checks again.
  const clearFieldErrors = (fields: string[]) =>
    setErrors((current) => {
      const kept = current.filter((error) => !fields.includes(error.field || ""));
      return kept.length === current.length ? current : kept;
    });
  const patchLine = (index: number, patch: Partial<Line>) => {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
    clearFieldErrors(Object.keys(patch).map((key) => `lines.${index}.${key}`));
  };
  // The message under a field, or null.
  const fieldError = (field: string) => {
    const error = errors.find((candidate) => candidate.field === field);
    const name = error ? inlineFieldName(error) : "";
    if (!error || !name) return null;
    return pair(CODE_MESSAGES[`${error.code}.${name}`] || CODE_MESSAGES[error.code || ""] || FIELD_MESSAGES[name]);
  };
  const lineError = (index: number, name: string) => fieldError(`lines.${index}.${name}`);
  // A supplier with a recorded lead time moves the line's need-by date from
  // the form's default to today + lead time, so a new order is not due on the
  // day it is placed. A date the person changed is kept.
  const applyLeadTime = (index: number, supplier?: SupplierOption) => {
    const days = Number(supplier?.leadTimeDays);
    if (supplier?.leadTimeDays === null || supplier?.leadTimeDays === undefined || !Number.isInteger(days) || days < 0) return;
    const leadDate = addCalendarDays(today(timezone), days);
    setLines((current) =>
      current.map((line, i) => (i === index && line.needByDate === defaultDate && !keepsUserDate(line) ? { ...line, needByDate: leadDate } : line)),
    );
  };
  // The date the user named in a request the assistant filled in.
  const keepsUserDate = (line: Line) => {
    const entry = prefillOf(line)?.fields.needByDate;
    return entry?.source === "record" && entry.value === line.needByDate;
  };
  const selectItem = async (index: number, value: string) => {
    const item = items.find((row) => (row.itemId || row.id) === value);
    clearOverrideIssues(index);
    if (!item)
      return patchLine(index, {
        itemId: "",
        sku: "",
        supplierId: "",
        itemNameSnapshot: "",
        unitSnapshot: "",
        specificationSnapshot: "",
        commodityId: "",
      });
    const itemId = item.itemId || item.id || "";
    patchLine(index, {
      sourceType: "catalog_item",
      itemId,
      sku: item.sku,
      supplierId: "",
      itemNameSnapshot: item.itemName || item.name || "",
      unitSnapshot: requestLineUnit(item),
      specificationSnapshot: item.specification || "",
      commodityId: item.category || "",
      targetWarehouseId: item.defaultWarehouseId || "",
      estimatedUnitPrice: "",
      supplierOverride: null,
    });
    const result = await request<{ suppliers: SupplierOption[] }>(
      `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
    );
    setItemSuppliers((current) => ({ ...current, [itemId]: result.suppliers }));
    // Only one preferred source is filled in; when master data marks more
    // than one, the person picks (the same rule as the handoff prefill).
    const preferredSources = result.suppliers.filter((s) => s.preferred);
    const preferred = preferredSources.length === 1 ? preferredSources[0] : undefined;
    if (preferred) {
      patchLine(index, {
        supplierId: preferred.id,
        estimatedUnitPrice: preferred.referencePrice
          ? String(preferred.referencePrice)
          : "",
        currency: preferred.currency || currency,
      });
      applyLeadTime(index, preferred);
    }
  };
  const supplierOptions = (line: Line): SupplierOption[] =>
    line.sourceType === "non_catalog_item"
      ? suppliers
      : itemSuppliers[line.itemId || ""] || [];
  // A catalog line whose supplier is not the item's preferred one, while one
  // is preferred, asks why (shared/supplier-override-reasons.mjs). Nothing
  // else does. Master data can mark more than one source preferred; any of
  // them needs no reason, the same rule as the server.
  const preferredOf = (line: Line, options = supplierOptions(line)) =>
    line.sourceType === "catalog_item" ? options.filter((option) => option.preferred) : [];
  const preferredNames = (line: Line) =>
    preferredOf(line).map((option) => option.name || option.supplierName || option.id).join(", ");
  const needsReason = (line: Line) =>
    Boolean(line.supplierId) && overrideNeeded({ supplierId: line.supplierId, preferredIds: preferredOf(line).map((option) => option.id) });
  // A reason given while another supplier was preferred is asked again.
  const keepOverride = (line: Line, options: SupplierOption[]) => {
    const stamped = line.supplierOverride?.preferredSupplierId;
    if (!line.supplierOverride || !stamped) return line.supplierOverride || null;
    return preferredOf(line, options).some((option) => option.id === stamped) ? line.supplierOverride : null;
  };
  const hasOverrideIssue = (index: number) =>
    errors.some((error) => {
      const match = OVERRIDE_FIELD.exec(error.field || "");
      return Boolean(match) && Number(match?.[1]) === index;
    });
  // A refused reason belongs to the supplier it was asked for: a new supplier
  // or item drops it, so the picker follows only the preferred-supplier rule.
  const clearOverrideIssues = (index: number) =>
    setErrors((current) => {
      const kept = current.filter((error) => {
        const match = OVERRIDE_FIELD.exec(error.field || "");
        return !match || Number(match[1]) !== index;
      });
      return kept.length === current.length ? current : kept;
    });
  // A reason belongs to the supplier it was given for.
  const chooseSupplier = (index: number, supplierId: string) => {
    patchLine(index, { supplierId, supplierOverride: null });
    clearOverrideIssues(index);
    const line = lines[index];
    applyLeadTime(index, (itemSuppliers[line?.itemId || ""] || []).find((supplier) => supplier.id === supplierId));
  };
  const overrideIssues = (index: number) =>
    Object.fromEntries(errors.flatMap((error) => {
      const match = OVERRIDE_FIELD.exec(error.field || "");
      return match && Number(match[1]) === index ? [[match[2], error.code || (match[2] === "note" ? "NOTE_LENGTH" : "REASON_REQUIRED")]] : [];
    })) as { reasonCode?: string; note?: string };
  const total = useMemo(
    () =>
      lines.reduce(
        (sum, l) =>
          sum +
          (l.lineBasis === "amount"
            ? Number(l.estimatedAmount || 0)
            : Number(l.quantity || 0) * Number(l.estimatedUnitPrice || 0)),
        0,
      ),
    [lines],
  );
  const reset = () => {
    setEditing(null);
    setPrefills([]);
    setLines([makeLine(defaultDate)]);
    setErrors([]);
  };
  const openNewForm = () => {
    reset();
    setFormOpen(true);
    // Its own address: Back returns to the list and a reload keeps the form (U-13).
    if (!opensForm(searchParams)) setSearchParams({ mode: "create" });
  };
  // Back to the list; a link's form query is dropped so it does not reopen.
  const closeForm = () => {
    detailEdit.current = "";
    reset();
    setFormOpen(false);
    if (opensForm(searchParams)) setSearchParams({}, { replace: true });
  };
  const save = async (submit = false) => {
    setSaving(submit ? "submit" : "draft");
    setErrors([]);
    try {
      // The same rules the server applies, so the person sees each one under
      // its field before saving.
      const missingReasons: FieldError[] = lines.flatMap((line, index) =>
        needsReason(line)
          ? validateSupplierOverride(line.supplierOverride, true).issues.map((issue) => ({ field: `lines.${index}.supplierOverride.${issue.field}`, code: issue.code }))
          : [],
      );
      const missing = [...missingLineFields(lines), ...missingReasons];
      if (missing.length) {
        setErrors(missing);
        focusFirstInvalid(formRef.current);
        return;
      }
      const body = {
        departmentId,
        defaultCurrency: currency,
        defaultNeedByDate: defaultDate,
        lines: lines.map((l) => ({
          ...l,
          quantity: l.lineBasis === "quantity" ? Number(l.quantity) : null,
          estimatedUnitPrice:
            l.lineBasis === "quantity" ? Number(l.estimatedUnitPrice) : null,
          estimatedAmount:
            l.lineBasis === "amount"
              ? Number(l.estimatedAmount)
              : Number(l.quantity) * Number(l.estimatedUnitPrice),
          unitSnapshot: l.lineBasis === "amount" ? null : l.unitSnapshot,
          currency: l.currency || currency,
          // The server keeps a reason only where one is needed.
          supplierOverride: l.sourceType === "catalog_item" && l.supplierOverride?.reasonCode
            ? { reasonCode: l.supplierOverride.reasonCode, note: String(l.supplierOverride.note || "").trim() || null }
            : null,
        })),
      };
      // What became of each prefilled value: codes only, for the audit row.
      // One prefilled line keeps its `line.` fields; several are numbered
      // as the request's lines are (`lines.0.quantity`).
      const prefilledLines = !editing ? prefills.map((entry) => ({ entry, line: lines.find((line) => line.lineId === entry.lineId), index: lines.findIndex((line) => line.lineId === entry.lineId) })).filter((row) => row.line) : [];
      const fieldKey = (index: number, field: string) => (prefills.length === 1 ? `line.${field}` : `lines.${index}.${field}`);
      const suggestionTrail = prefill && !editing
        ? buildSuggestionTrail({
            origin: prefill.origin,
            prefills: Object.fromEntries(prefilledLines.flatMap(({ entry, index }) => Object.entries(entry.fields).map(([field, value]) => [fieldKey(index, field), value]))),
            values: Object.fromEntries(prefilledLines.flatMap(({ entry, line, index }) => Object.keys(entry.fields).map((field) => [fieldKey(index, field), line?.[field as PrefillLineField] ?? ""]))),
          })
        : null;
      const pr = editing
        ? await request<PR>(
            `/api/procurement/requests/${editing.id}`,
            "PATCH",
            { ...body, expectedVersion: editing.version },
          )
        : await request<PR>("/api/procurement/requests", "POST", suggestionTrail ? { ...body, suggestionTrail } : body);
      if (submit)
        await request(`/api/procurement/requests/${pr.id}/submit`, "POST", {
          expectedVersion: pr.version,
        });
      closeForm();
      await load();
      toast.success(copy(submit ? "采购申请已提交" : "采购申请草稿已保存"));
    } catch (error: unknown) {
      const details = error instanceof ApiError ? error.details : [];
      setErrors(
        details.length
          ? details
          : [{ message: errorText(error, SAVE_FAILED) }],
      );
      if ((details as FieldError[]).some((detail) => inlineFieldName(detail) || OVERRIDE_FIELD.test(detail.field || ""))) focusFirstInvalid(formRef.current);
      // The server asked for a reason the form did not: the item's preferred
      // supplier changed since the form read it. Read the sources again so
      // the picker shows, and say it in the interface language.
      const overrideErrors = (details as FieldError[]).flatMap((detail) => {
        const match = OVERRIDE_FIELD.exec(detail.field || "");
        return match ? [{ index: Number(match[1]), code: detail.code }] : [];
      });
      if (overrideErrors.length) {
        const first = overrideErrors[0];
        toast.error(`${copy("采购行")} ${first.index + 1}: ${supplierOverrideIssueText(first.code, language)}`);
        await reloadSuppliers([...new Set(overrideErrors.map(({ index }) => lines[index]?.itemId).filter(Boolean))] as string[]);
      } else {
        toast.error(errorText(error, SAVE_FAILED));
      }
    } finally {
      setSaving("");
    }
  };
  const readSuppliers = (itemIds: string[]) =>
    Promise.all(
      itemIds.map(
        async (itemId) =>
          [
            itemId,
            (
              await request<{ suppliers: SupplierOption[] }>(
                `/api/master-data/items/${encodeURIComponent(itemId)}/suppliers`,
              )
            ).suppliers,
          ] as const,
      ),
    );
  const reloadSuppliers = async (itemIds: string[]) => {
    if (!itemIds.length) return;
    try {
      const fresh: Record<string, SupplierOption[]> = Object.fromEntries(await readSuppliers(itemIds));
      setItemSuppliers((current) => ({ ...current, ...fresh }));
      setLines((current) =>
        current.map((line) =>
          line.itemId && fresh[line.itemId] ? { ...line, supplierOverride: keepOverride(line, fresh[line.itemId]) } : line,
        ),
      );
    } catch {
      // The picker still shows for the refused line (hasOverrideIssue).
    }
  };
  // What "Create purchase order" will make, read from the server's plan:
  // each order's supplier, currency, delivery place, lines and amount, and
  // the status it starts in. A request the server would refuse says why and
  // creates nothing (design audit L1-26, L1-03, L1-28).
  const confirmConversion = async (pr: PR) => {
    let preview: PurchaseOrderPreview;
    try {
      preview = await request<PurchaseOrderPreview>(`/api/procurement/requests/${encodeURIComponent(pr.id)}/purchase-order-preview`);
    } catch (error) {
      toast.error(errorText(error, PREVIEW_FAILED));
      return false;
    }
    if (preview.issues.length) {
      toast.error(errorText({ code: preview.issues[0].code, status: 422 }, UPDATE_FAILED));
      return false;
    }
    const count = preview.orders.length;
    const title = (count === 1 ? tr("convertTitleOne") : tr("convertTitleMany").replace("{count}", String(count))).replace("{number}", numberOf(pr));
    return confirmDialog.confirm({
      title,
      description: (
        <div data-testid="pr-convert-preview">
          <ul className="space-y-1">
            {preview.orders.map((order, index) => (
              <li key={index} data-testid="pr-convert-order">
                {[order.supplierName || order.supplierId, order.currency, warehouseName(order.warehouseId) || order.warehouseId, order.lineCount === 1 ? tr("lineOne") : tr("lineMany").replace("{count}", String(order.lineCount)), amount(order.amount, order.currency)].filter(Boolean).join(" · ")}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">{preview.purchaseOrderStatus === "approved" ? tr("convertApproved") : tr("convertDraft")}</p>
        </div>
      ),
      confirmLabel: tr("createPurchaseOrder"),
      cancelLabel: tr("goBack"),
      testId: "pr-convert-dialog",
    });
  };
  const act = async (pr: PR, action: string) => {
    try {
      if (action === "generate-purchase-orders" && !(await confirmConversion(pr))) return;
      // Rejecting and cancelling each say why (L1-16).
      const reason =
        action === "reject" || action === "cancel"
          ? await confirmDialog.prompt({
              title: action === "reject" ? tr("rejectTitle") : tr("cancelTitle").replace("{number}", numberOf(pr)),
              description: action === "reject" ? tr("rejectBody") : tr("cancelBody"),
              field: { label: action === "reject" ? tr("rejectReason") : tr("cancelReason") },
              confirmLabel: action === "reject" ? tr("reject") : tr("cancel"),
              cancelLabel: tr("goBack"),
              tone: "danger",
              ...(action === "cancel" ? { testId: "cancel-request-dialog" } : {}),
            })
          : "";
      if ((action === "reject" || action === "cancel") && !reason) return;
      // Withdrawing takes a submitted request out of approval, so it asks first.
      if (
        action === "withdraw" &&
        !(await confirmDialog.confirm({
          title: tr("withdrawTitle").replace("{number}", numberOf(pr)),
          description: tr("withdrawBody"),
          confirmLabel: tr("withdraw"),
          cancelLabel: tr("goBack"),
          tone: "danger",
          testId: "withdraw-request-dialog",
        }))
      )
        return;
      setActing(pr.id);
      const result: any = await request(
        `/api/procurement/requests/${pr.id}/${action}`,
        "POST",
        { expectedVersion: pr.version, reason },
      );
      rememberDocumentNumbers("purchase_order", result.createdPurchaseOrders, (po: { id?: string; number?: string }) => [po.id, po.number]);
      // Say what happened, by the request's number (and the order's).
      const number = numberOf(pr);
      const orders: { id?: string; number?: string }[] = result.createdPurchaseOrders || [];
      const done =
        action === "approve" ? tr("approved")
          : action === "reject" ? tr("rejected")
          : action === "withdraw" ? tr("withdrawn")
          : action === "cancel" ? tr("cancelledNumber")
          : action === "reopen" ? tr("reopenedNumber")
          : action === "submit" ? tr("submittedNumber")
          : orders.length > 1 ? tr("createdOrders").replace("{count}", String(orders.length))
          : orders.length ? tr("createdOrder").replace("{po}", orders[0].number || orders[0].id || "")
          : "";
      if (done) toast.success(done.replace("{number}", number));
      if (result.createdPurchaseOrders?.[0])
        onNavigate?.("procurement:orders", {
          entityType: "purchase_order",
          entityId: result.createdPurchaseOrders[0].id,
        });
      await load();
    } catch (e: any) {
      toast.error(errorText(e, UPDATE_FAILED));
      // Changed elsewhere (a newer version or another status): show it as it is now.
      if (e instanceof ApiError && e.status === 409) await load().catch(() => undefined);
    } finally {
      setActing("");
    }
  };
  const edit = async (pr: PR) => {
    const itemIds = [
      ...new Set(pr.lines.map((line) => line.itemId).filter(Boolean)),
    ] as string[];
    const payloads: Record<string, SupplierOption[]> = Object.fromEntries(await readSuppliers(itemIds));
    setItemSuppliers((current) => ({
      ...current,
      ...payloads,
    }));
    setEditing(pr);
    setDepartmentId(pr.departmentId);
    setCurrency(pr.defaultCurrency || "");
    setDefaultDate(pr.defaultNeedByDate || "");
    setLines(
      pr.lines.map((l) => ({
        ...l,
        quantity: String(l.quantity ?? ""),
        estimatedUnitPrice: String(l.estimatedUnitPrice ?? ""),
        estimatedAmount: String(l.estimatedAmount ?? ""),
        // A reason given while another supplier was preferred is asked again.
        supplierOverride: l.itemId && payloads[l.itemId] ? keepOverride(l, payloads[l.itemId]) : l.supplierOverride || null,
      })),
    );
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // An edit opened from a request's detail page belongs to that page: moving
  // to another request or to the list closes it (a link there that opens the
  // form still does).
  const focusedRequestId = focus?.entityType === "purchase_request" ? focus.entityId : "";
  useEffect(() => {
    if (!detailEdit.current || detailEdit.current === focusedRequestId) return;
    detailEdit.current = "";
    reset();
    setFormOpen(opensForm(searchParams));
  }, [focusedRequestId]);
  const editFromDetail = (pr: PR) => {
    detailEdit.current = pr.id;
    edit(pr).catch((error) => {
      detailEdit.current = "";
      toast.error(errorText(error, SOURCES_FAILED));
    });
  };
  // Submits a saved draft as it is, the same command as the list's Submit.
  const submitDraft = async (pr: PR) => {
    setSubmitting(true);
    try {
      await request(`/api/procurement/requests/${encodeURIComponent(pr.id)}/submit`, "POST", { expectedVersion: pr.version });
      toast.success(copy("采购申请已提交"));
      await load();
    } catch (error: unknown) {
      toast.error(errorText(error, SAVE_FAILED));
      // Changed elsewhere (a newer version or no longer a draft): show it as it is now.
      if (error instanceof ApiError && error.status === 409) await load().catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  };
  const requesterOf = (pr: PR) => pr.requesterName || pr.requester || pr.requesterId || "—";
  const suppliersOf = (pr: PR) =>
    [...new Set(pr.lines.map((line) => line.supplierSnapshot?.supplierName).filter(Boolean))].join(", ");
  const needByOf = (pr: PR) => pr.lines.map((line) => line.needByDate).filter(Boolean).sort()[0] || pr.defaultNeedByDate;
  const lineAmountOf = (line: Line) =>
    line.lineBasis === "amount" ? Number(line.estimatedAmount || 0) : Number(line.quantity || 0) * Number(line.estimatedUnitPrice || 0);
  const contains = (value: unknown, needle: string) => String(value || "").toLowerCase().includes(needle.trim().toLowerCase());
  const shownRows = rows.filter((pr) =>
    (!statusFilter || pr.status === statusFilter)
    && (!filters.number.trim() || contains(numberOf(pr), filters.number) || contains(pr.id, filters.number))
    && (!filters.item.trim() || pr.lines.some((line) => contains(line.sku, filters.item) || contains(line.itemNameSnapshot, filters.item)))
    && (!filters.requester.trim() || contains(requesterOf(pr), filters.requester)),
  );
  const paged = usePagedRows(shownRows, PR_LIST_PAGE_SIZE, JSON.stringify([filters, statusFilter]));
  const resetFilters = () => {
    setFilters({ number: "", item: "", requester: "" });
    setStatusFilter("");
  };
  const reload = () => load().catch((error) => toast.error(errorText(error, LOAD_FAILED)));
  // Document numbers, not internal ids, in the file.
  const exportRequests = async () => {
    const orderNumbers = await resolveDocumentNumbers("purchase_order", shownRows.flatMap((pr) => pr.linkedPurchaseOrderIds || []));
    exportRowsToCsv("purchase-requests-export.csv", shownRows.map((pr) => ({
      [tr("requestNumber")]: numberOf(pr),
      [tr("item")]: pr.lines.map((line) => [line.sku, line.itemNameSnapshot].filter(Boolean).join(" ")).join("; "),
      [tr("supplier")]: suppliersOf(pr),
      [tr("requester")]: requesterOf(pr),
      [tr("needBy")]: needByOf(pr) || "",
      [tr("amount")]: pr.totalAmount ?? "",
      [tr("currency")]: pr.defaultCurrency,
      [tr("status")]: statusLabel(pr.status),
      [tr("purchaseOrders")]: (pr.linkedPurchaseOrderIds || []).map((id) => orderNumbers.get(id) || id).join("; "),
    })), timezone);
  };
  if (loadError)
    return (
      <Card className="p-12 text-center">
        <h1 className="text-sm font-semibold" style={{ color: A.label }}>{copy("采购申请数据加载失败")}</h1>
        <p className="mt-2 text-xs" style={{ color: A.sub }}>
          {copy(loadError)}
        </p>
        <RetryButton onClick={() => void load().catch((error) => toast.error(errorText(error, LOAD_FAILED)))} label={copy("重试")} />
      </Card>
    );
  const editingSelected = Boolean(selected && formOpen && editing?.id === selected.id);
  // A label, then its value: "Requester: Kim" in English, "申请人：Kim" in Chinese.
  const labelled = (label: string, value: string) => `${label}${language === "en-US" ? ": " : "："}${value}`;
  // "60 pcs", "60 件": the quantity with its unit in the interface language.
  const quantityText = (line: Line) => {
    const quantity = Number(line.quantity);
    const unit = line.unitSnapshot ? ` ${unitLabel(line.unitSnapshot, language, Number.isFinite(quantity) ? quantity : null)}` : "";
    return `${formatQuantity(line.quantity)}${unit}`;
  };
  if (selected && !editingSelected) {
    // The detail header offers what the list row offers for this status, the
    // main step first, as on a PO; a draft's Submit asks for approval as it is.
    const detailActions = [...actionsFor(selected)].sort((a, b) => Number(DETAIL_PRIMARY.has(b)) - Number(DETAIL_PRIMARY.has(a)));
    const busy = submitting || acting === selected.id;
    const runDetailAction = (action: RequestAction) => {
      if (action === "edit") return editFromDetail(selected);
      if (action === "submit") return void submitDraft(selected);
      return void act(selected, action);
    };
    const departmentName = departments.find((option) => option.id === selected.departmentId)?.label;
    // The PO's header card and overview (DocumentShell, OverviewFields): the
    // number with its status, "Purchase request · requester", the steps in the
    // card, then the facts the form asked for (design audit U-09, U-17).
    return (
      <div className="space-y-3 pb-16">
        <BackToListLink list="requests" />
        <DocumentShell
          title={numberOf(selected)}
          moduleLabel={tr("moduleLabel")}
          status={statusLabel(selected.status)}
          statusTone={statusToneOf(selected.status)}
          subtitle={<span data-testid="pr-detail-meta">{[labelled(tr("requester"), requesterOf(selected)), selected.createdAt ? labelled(tr("createdOn"), dayText(selected.createdAt)) : ""].filter(Boolean).join(" · ")}</span>}
          header={detailActions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="pr-detail-actions">
              {detailActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  data-testid={action === "generate-purchase-orders" ? "pr-detail-create-po" : `pr-detail-${action}`}
                  disabled={busy}
                  onClick={() => runDetailAction(action)}
                  className={DETAIL_PRIMARY.has(action) ? listButtonClass.primary : DANGER_ACTIONS.has(action) ? listButtonClass.danger : listButtonClass.secondary}
                >
                  {action === "submit" ? tr("submitForApproval") : actionLabel(action)}
                </button>
              ))}
            </div>
          ) : undefined}
        >
        <div>
          <SectionHeader title={tr("overview")} />
          <OverviewFields testId="pr-overview" fields={[
            { label: tr("estimatedTotal"), value: amount(selected.totalAmount, selected.defaultCurrency) },
            { label: tr("department"), value: departmentName ? copy(departmentName) : selected.departmentId || "—" },
            { label: tr("currency"), value: selected.defaultCurrency || "—" },
            { label: tr("defaultNeedBy"), value: dayText(selected.defaultNeedByDate) },
          ]} />
        </div>
        <ListCard title={tr("lines")}>
          {/* Fits a 1440 px window: the item, supplier, place and notes wrap
              to two lines instead of widening the table; on a phone each line
              is a card (ListCard). */}
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[860px] text-left ${tableBodyTextClass}`} data-testid="pr-detail-lines">
              <thead>
                <tr style={listHeadRowStyle}>
                  {[tr("item"), tr("supplier"), tr("quantityPrice"), tr("needBy"), tr("deliverTo"), copy("行级内部备注")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("amount")}</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((line, index) => (
                  <tr key={line.lineId} className={`${listRowClass} align-top`} style={listRowStyle(index, selected.lines.length)} data-testid="pr-detail-line">
                    <td className={`${tdClass} min-w-[150px] max-w-[240px]`}>
                      <div className="line-clamp-2 font-medium" style={{ color: A.label }} title={line.itemNameSnapshot}>{line.itemNameSnapshot || "—"}</div>
                      <div className="text-[11px]" style={{ color: A.sub }}>{line.sku || tr("nonCatalog")}</div>
                    </td>
                    <td className={`${tdClass} min-w-[130px] max-w-[220px]`}>
                      <div>{line.supplierSnapshot?.supplierName || line.supplierId || "—"}</div>
                      <SupplierOverrideFlag override={line.supplierOverride} testId="pr-line-supplier-override" />
                    </td>
                    <td className={tdNumericClass} data-testid="pr-detail-line-quantity">
                      {line.lineBasis === "quantity"
                        // The unit price to 4 decimals when it has them, so quantity × price is the amount (fresh walk 11/18).
                        ? `${quantityText(line)} × ${line.estimatedUnitPrice === null || line.estimatedUnitPrice === undefined || line.estimatedUnitPrice === "" ? "—" : formatUnitPrice(Number(line.estimatedUnitPrice), line.currency || selected.defaultCurrency, locale)}`
                        : copy("金额 / 服务型")}
                    </td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{dayText(line.needByDate || selected.defaultNeedByDate)}</td>
                    <td className={`${tdClass} min-w-[110px] max-w-[200px]`}>{warehouseName(line.targetWarehouseId) || "—"}</td>
                    {/* Two lines in the table; whole on a phone card, where there is no tooltip to read the rest. */}
                    <td className={`${tdClass} min-w-[150px] max-w-[240px] max-sm:max-w-none`}><div className="line-clamp-2 max-sm:line-clamp-none max-sm:whitespace-normal max-sm:break-words" title={line.internalLineComment} data-testid="pr-detail-line-note">{line.internalLineComment || "—"}</div></td>
                    <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{amount(line.estimatedAmount, line.currency || selected.defaultCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ListCard>
        <Card className="p-5">
          <h2 className="fc-section-title" style={{ color: A.label }}>{copy("关联采购订单")}</h2>
          {!selected.linkedPurchaseOrderIds?.length ? (
            <div className="py-8 text-center text-xs" style={{ color: A.sub }}>{copy("暂无关联采购订单")}</div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {selected.linkedPurchaseOrderIds.map((id) => (
                <EntityLink key={id} kind="purchase_order" id={id} className="text-sm text-blue-600" />
              ))}
            </div>
          )}
        </Card>
        <div>
          <SectionHeader title={tr("changes")} />
          <DocumentHistoryPanel
            entityType="purchaseRequest"
            entityId={selected.id}
            title={tr("history")}
            emptyText={tr("historyEmpty")}
            refreshKey={`${selected.version}:${selected.status}`}
          />
        </div>
        </DocumentShell>
        {confirmDialog.element}
      </div>
    );
  }
  // An address naming no request in this workspace says so, as the PO page
  // does, rather than showing the list (design audit U-08).
  if (focusKey && loaded && !selected && !formOpen) {
    return (
      <div className="space-y-3">
        <BackToListLink list="requests" />
        <Card className="p-8 text-center text-xs" style={{ color: A.gray2 }} data-testid="pr-not-found">{tr("notFound")}</Card>
      </div>
    );
  }
  if (!formOpen) {
    const count = (status: string) => (loaded ? String(rows.filter((row) => row.status === status).length) : "—");
    const menuItemClass = "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-50 disabled:opacity-60 max-sm:min-h-9";
    const statusLink = (status: string) => `/app/procurement/requests?status=${status}`;
    return (
      <div className="space-y-5 pb-16" data-testid="purchase-request-list-page">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* "—" until the requests load, as on the other lists (design audit U-15). */}
          <ActionableMetricCard label={statusLabel("draft")} value={count("draft")} description={tr("draftsNote")} to={statusLink("draft")} icon={FileText} color={A.gray1} />
          <ActionableMetricCard label={statusLabel("submitted")} value={count("submitted")} description={tr("awaitingApprovalNote")} to={statusLink("submitted")} icon={ClipboardCheck} color={A.orange} />
          <ActionableMetricCard label={statusLabel("approved")} value={count("approved")} description={tr("readyForPoNote")} to={statusLink("approved")} icon={CheckCircle2} color={A.success} />
          <ActionableMetricCard label={statusLabel("converted")} value={count("converted")} description={tr("convertedNote")} to={statusLink("converted")} icon={Truck} color={A.success} />
        </div>

        <ListSearchCard
          title={tr("searchTitle")}
          subtitle={tr("searchSubtitle")}
          activeFilters={[filters.item, filters.requester, statusFilter].filter(Boolean).length}
          actions={<>
            <ResetButton onClick={resetFilters} />
            <RefreshButton onClick={reload} />
            <ExportButton onClick={exportRequests} />
            <PrimaryButton onClick={openNewForm} testId="pr-new">{copy("新建采购申请")}</PrimaryButton>
          </>}
        >
          <Field label={tr("requestNumber")}>
            <input value={filters.number} onChange={(event) => setFilters({ ...filters, number: event.target.value })} placeholder="PR-…" style={inputStyle} />
          </Field>
          <Field label={tr("itemOrSku")}>
            <input value={filters.item} onChange={(event) => setFilters({ ...filters, item: event.target.value })} placeholder={tr("itemPlaceholder")} style={inputStyle} />
          </Field>
          <Field label={tr("requester")}>
            <input value={filters.requester} onChange={(event) => setFilters({ ...filters, requester: event.target.value })} placeholder={tr("requesterPlaceholder")} style={inputStyle} />
          </Field>
          <Field label={tr("status")}>
            <select aria-label={tr("status")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={inputStyle}>
              <option value="">{tr("allStatuses")}</option>
              {PR_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
          </Field>
        </ListSearchCard>

        {/* Total: the requests the filters match; shown: those on this page (design audit U-14). */}
        <ListCard title={tr("listTitle")} total={loaded ? shownRows.length : undefined} shown={paged.pageRows.length} all={loaded ? rows.length : undefined} testId="purchase-request-list">
          <div className={tableScrollClass}>
            <table className={`w-full min-w-[1100px] text-left ${tableBodyTextClass}`}>
              <thead>
                <tr style={listHeadRowStyle}>
                  <th className={`${thClass} sticky left-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("requestNumber")}</th>
                  {[tr("item"), tr("supplier"), tr("requester"), tr("needBy")].map((label) => <th key={label} className={thClass} style={{ color: A.gray1 }}>{label}</th>)}
                  <th className={thRightClass} style={{ color: A.gray1 }}>{tr("amount")}</th>
                  <th className={thClass} style={{ color: A.gray1 }}>{tr("status")}</th>
                  <th className={`${thClass} sticky right-0 z-20 bg-white`} style={{ color: A.gray1 }}>{tr("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {!loaded && <ListStateRow colSpan={8} state="loading" />}
                {loaded && shownRows.length === 0 && (
                  rows.length === 0
                    ? <ListStateRow colSpan={8} state="empty" title={copy("暂无采购申请")} detail={copy("点击“新建采购申请”开始录入。")} />
                    : <ListStateRow colSpan={8} state="empty" title={tr("noMatch")} />
                )}
                {paged.pageRows.map((pr, index) => {
                  const overrides = pr.lines.filter((line) => hasSupplierOverride(line.supplierOverride));
                  const suppliers = suppliersOf(pr);
                  const rowActions = actionsFor(pr);
                  return (
                    <tr key={pr.id} className={listRowClass} style={listRowStyle(index, paged.pageRows.length)}>
                      <td className={`${tdIdClass} sticky left-0 z-10 bg-white`}>
                        <EntityLink kind="purchase_request" id={pr.id} number={numberOf(pr)} className={tableLinkClass} />
                        {pr.createdAt && <div className="text-[11px] font-normal" style={{ color: A.sub }}>{tr("created")} {dayText(pr.createdAt)}</div>}
                      </td>
                      <td className={`${tdNameClass} max-w-[240px]`}>
                        <div className="truncate font-medium" style={{ color: A.label }} title={pr.lines[0]?.itemNameSnapshot}>{pr.lines[0]?.itemNameSnapshot || "—"}</div>
                        <div className="text-[11px]" style={{ color: A.sub }}>
                          {[pr.lines[0]?.sku, pr.lines.length > 1 ? tr("moreLines").replace("{count}", String(pr.lines.length - 1)) : ""].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className={`${tdNameClass} max-w-[200px] truncate`} title={suppliers}>{suppliers || <span style={{ color: A.gray2 }}>{tr("notChosen")}</span>}</td>
                      <td className={tdNowrapClass}>{requesterOf(pr)}</td>
                      <td className={tdNowrapClass} style={{ color: A.sub }}>{dayText(needByOf(pr))}</td>
                      <td className={`${tdNumericRightClass} font-semibold`} style={{ color: A.label }}>{amount(pr.totalAmount, pr.defaultCurrency)}</td>
                      <td className={tdNameClass}>
                        <StatusChip label={statusLabel(pr.status)} tone={statusToneOf(pr.status)} />
                        <SupplierOverrideCount count={overrides.length} testId="pr-row-supplier-overrides" />
                        {/* Approve on this row skips the detail, so the row shows each reason too. */}
                        {overrides.length ? (
                          <div className="mt-1 flex max-w-[280px] flex-col items-start gap-1 whitespace-normal">
                            {overrides.map((line, lineIndex) => (
                              <SupplierOverrideFlag
                                key={line.lineId || lineIndex}
                                override={line.supplierOverride}
                                prefix={`${line.sku || line.itemNameSnapshot} · ${line.supplierSnapshot?.supplierName || line.supplierId}`}
                                testId="pr-row-supplier-override"
                              />
                            ))}
                          </div>
                        ) : null}
                        {pr.linkedPurchaseOrderIds?.length ? (
                          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px]">
                            {pr.linkedPurchaseOrderIds.map((id) => <EntityLink key={id} kind="purchase_order" id={id} className="text-[11px] font-medium" />)}
                          </div>
                        ) : null}
                      </td>
                      <td className={`${tdNowrapClass} sticky right-0 z-10 bg-white`}>
                        {/* One blue View and, when the request has steps left, a More
                            menu holding them by the detail page's names (design audit U-10). */}
                        <div className="flex items-center gap-1.5">
                          <EntityLink kind="purchase_request" id={pr.id} className={`${rowActionClass.primary} !font-medium !no-underline`}>{tr("view")}</EntityLink>
                          {rowActions.length > 0 && (
                            <RowMenu label={tr("more")} testId={`pr-row-more-${pr.id}`}>
                              {[...rowActions].sort((a, b) => Number(DETAIL_PRIMARY.has(b)) - Number(DETAIL_PRIMARY.has(a))).map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  data-testid={`pr-row-${action}`}
                                  disabled={acting === pr.id}
                                  className={`${menuItemClass} ${DETAIL_PRIMARY.has(action) ? "font-semibold text-blue-700" : DANGER_ACTIONS.has(action) ? "text-red-700" : ""}`}
                                  onClick={() => (action === "edit" ? void edit(pr) : void act(pr, action))}
                                >
                                  {action === "submit" ? tr("submitForApproval") : actionLabel(action)}
                                </button>
                              ))}
                            </RowMenu>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {loaded && <ListPager page={paged.page} pageSize={PR_LIST_PAGE_SIZE} total={shownRows.length} onPage={paged.setPage} testId="pr-list-pager" />}
        </ListCard>
        {confirmDialog.element}
      </div>
    );
  }
  // Messages about the whole form: what has no field of its own. Field
  // messages sit under their fields (Field's error, the reason picker).
  const fieldIssues = errors.some((error) => inlineFieldName(error) || OVERRIDE_FIELD.test(error.field || ""));
  const formIssues = errors.filter((error) => !inlineFieldName(error) && !OVERRIDE_FIELD.test(error.field || ""));
  const formMessage = fieldIssues || formIssues.length ? (
    <>
      {fieldIssues && <div>{formCopy("checkFields")}</div>}
      {formIssues.map((error, index) => <div key={index}>{error.message ? copy(error.message) : pair(SAVE_FAILED)}</div>)}
    </>
  ) : null;
  return (
    <div ref={formRef} className="space-y-5" data-testid="purchase-request-form">
      <FocusFirstField />
      <FormHeader
        title={editing ? `${copy("编辑采购申请")} ${numberOf(editing)}` : copy("新建采购申请")}
        intro={copy("每一行均需明确物料或服务、供应商、金额、交付地点和需求日期。")}
        back={{ label: editingSelected ? tr("backToRequest") : copy("返回采购申请列表"), onClick: closeForm }}
        aside={
          <button
            type="button"
            aria-label={copy("刷新基础资料")}
            title={copy("刷新基础资料")}
            onClick={() => load()}
            className={listButtonClass.secondary}
          >
            <RefreshCw size={13} />
          </button>
        }
      >
        {prefill && !editing ? <PrefillBanner origin={prefill.origin} intent={prefill.intent} /> : null}
      </FormHeader>

      <FormSection title={tr("requestDetails")}>
        <div className={formGridClass}>
          <Field label={copy("申请人")}>
            <input
              aria-label={copy("申请人")}
              readOnly
              value={signedInName() || copy("由服务端当前用户确定")}
              style={{ ...inputStyle, background: A.gray6, color: A.sub }}
            />
          </Field>
          <Field label={copy("部门")}>
            <select
              aria-label={copy("部门")}
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              style={inputStyle}
            >
              {departments.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}
            </select>
          </Field>
          <Field label={copy("默认币种")} error={fieldError("defaultCurrency")}>
            <select
              aria-label={copy("默认币种")}
              value={currency}
              onChange={(e) => { setCurrency(e.target.value); clearFieldErrors(["defaultCurrency"]); }}
              style={inputStyle}
            >
              <option value="">{copy("选择币种")}</option>
              {orderedCurrencyCodes(workspaceCurrency, currencies.map((option) => option.id), currency).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label={copy("默认需求日期")} error={fieldError("defaultNeedByDate")}>
            <input
              aria-label={copy("默认需求日期")}
              type="date"
              value={defaultDate}
              onChange={(e) => { setDefaultDate(e.target.value); clearFieldErrors(["defaultNeedByDate"]); }}
              style={inputStyle}
            />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title={tr("lines")}
        right={<span className="text-sm font-semibold tabular-nums" style={{ color: A.label }}>{copy("预计总额")} {amount(total, currency)}</span>}
      >
        <div className="space-y-3">
          {lines.map((line, index) => (
            <FormLineCard
              key={line.lineId}
              label={`${copy("采购行")} ${index + 1}`}
              aside={<>{tr("lineAmount")} <strong style={{ color: A.label }}>{amount(lineAmountOf(line), line.currency || currency)}</strong></>}
              remove={{
                label: `${copy("删除采购行")} ${index + 1}`,
                disabled: lines.length < 2,
                onClick: async () => {
                  if (lines.length < 2) return;
                  const confirmed = await confirmDialog.confirm({
                    title: tr("deleteLineTitle").replace("{line}", String(index + 1)),
                    description: tr("deleteLineBody"),
                    confirmLabel: tr("deleteLine"),
                    tone: "danger",
                  });
                  if (!confirmed) return;
                  setLines((current) => current.filter((candidate) => candidate.lineId !== line.lineId));
                  // Line messages are kept by position, so they go with any removed line.
                  setErrors((current) => current.filter((error) => !(error.field || "").startsWith("lines.")));
                },
              }}
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Field label={copy("采购类型")}>
                  <select
                    value={line.sourceType}
                    onChange={(e) => {
                      const sourceType = e.target.value as Line["sourceType"];
                      patchLine(index, {
                        ...makeLine(defaultDate),
                        lineId: line.lineId,
                        sourceType,
                        currency,
                      });
                    }}
                    style={inputStyle}
                  >
                    <option value="catalog_item">{copy("目录物料")}</option>
                    <option value="non_catalog_item">{copy("其他（非目录物料）")}</option>
                  </select>
                </Field>
                <Field label={copy("计价方式")}>
                  <select
                    value={line.lineBasis}
                    onChange={(e) =>
                      patchLine(index, {
                        lineBasis: e.target.value as Line["lineBasis"],
                        quantity: "",
                        estimatedUnitPrice: "",
                        estimatedAmount: "",
                      })
                    }
                    style={inputStyle}
                  >
                    <option value="quantity">{copy("数量型")}</option>
                    <option value="amount">{copy("金额 / 服务型")}</option>
                  </select>
                </Field>
                <div className="md:col-span-1 xl:col-span-2">
                  <Field label={tr("skuOrOther")} required={line.sourceType === "catalog_item"} error={line.sourceType === "catalog_item" ? lineError(index, "itemId") : null}>
                    {line.sourceType === "catalog_item" ? (
                      <select
                        aria-label={`SKU ${index + 1}`}
                        value={line.itemId || ""}
                        onChange={(e) => selectItem(index, e.target.value)}
                        style={inputStyle}
                      >
                        <option value="">{copy("搜索或选择 SKU")}</option>
                        {items.map((i) => (
                          <option key={i.itemId || i.id} value={i.itemId || i.id}>
                            {i.sku} · {i.itemName || i.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input readOnly value={copy("非目录")} style={{ ...inputStyle, background: A.gray6, color: A.sub }} />
                    )}
                    {prefillChip(line, "itemId")}
                  </Field>
                </div>
                <div className="md:col-span-3 xl:col-span-2">
                  <Field label={copy("物料名称 / 描述")} required={line.sourceType === "non_catalog_item"} error={lineError(index, "itemNameSnapshot")}>
                    <input
                      readOnly={line.sourceType === "catalog_item"}
                      value={line.itemNameSnapshot}
                      onChange={(e) =>
                        patchLine(index, { itemNameSnapshot: e.target.value })
                      }
                      style={line.sourceType === "catalog_item" ? { ...inputStyle, background: A.gray6 } : inputStyle}
                    />
                    {prefillChip(line, "itemNameSnapshot")}
                  </Field>
                </div>
                <div className="md:col-span-3 xl:col-span-2">
                  <Field label={tr("supplier")} required error={lineError(index, "supplierId")}>
                    <select
                      aria-label={`${tr("supplier")} ${index + 1}`}
                      value={line.supplierId}
                      onChange={(e) => chooseSupplier(index, e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">{copy("选择供应商")}</option>
                      {supplierOptions(line).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.preferred ? ` · ${tr("preferred")}` : ""}
                        </option>
                      ))}
                    </select>
                    {prefillChip(line, "supplierId")}
                    {prefillOf(line) && !editing && line.itemId && line.itemId === prefillOf(line)?.fields.itemId?.value ? (
                      <SupplierChoices
                        choices={prefillOf(line)?.supplierChoices || []}
                        preferredOnly={prefillOf(line)?.fields.supplierId?.ref === "item_supplier:choose_preferred"}
                        selectedId={line.supplierId}
                        onChoose={(supplierId) => { if (supplierId !== line.supplierId) chooseSupplier(index, supplierId); }}
                      />
                    ) : null}
                    {needsReason(line) || (line.sourceType === "catalog_item" && hasOverrideIssue(index)) ? (
                      <SupplierOverrideReason
                        testId={`supplier-override-reason-${index + 1}`}
                        preferredName={preferredNames(line)}
                        preferredCount={preferredOf(line).length}
                        value={line.supplierOverride}
                        issues={overrideIssues(index)}
                        onChange={(supplierOverride) =>
                          patchLine(index, {
                            supplierOverride: {
                              ...supplierOverride,
                              missingReason: false,
                              preferredSupplierId: preferredOf(line)[0]?.id || null,
                              preferredSupplierIds: preferredOf(line).map((option) => option.id),
                              preferredSupplierName: preferredNames(line) || null,
                            },
                          })
                        }
                      />
                    ) : null}
                    {line.sourceType === "catalog_item" &&
                      line.itemId &&
                      supplierOptions(line).length === 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            onNavigate?.("master-data:items", {
                              entityType: "item",
                              entityId: line.itemId,
                            })
                          }
                          className="mt-1 text-xs text-blue-600"
                        >{copy("维护 SKU 供应商")}</button>
                      )}
                  </Field>
                </div>
                <div className="md:col-span-1 xl:col-span-2">
                  <Field label={copy("品类")}>
                    {line.sourceType === "catalog_item" ? <input readOnly value={line.commodityId} style={{ ...inputStyle, background: A.gray6 }} /> : <select value={line.commodityId} onChange={(e) => patchLine(index, { commodityId: e.target.value })} style={inputStyle}><option value="">{copy("选择品类")}</option>{commodities.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
                  </Field>
                </div>
                <div className="md:col-span-2 xl:col-span-2">
                  <Field label={copy("规格")}>
                    <input
                      readOnly={line.sourceType === "catalog_item"}
                      value={line.specificationSnapshot}
                      onChange={(e) =>
                        patchLine(index, {
                          specificationSnapshot: e.target.value,
                        })
                      }
                      style={line.sourceType === "catalog_item" ? { ...inputStyle, background: A.gray6 } : inputStyle}
                    />
                  </Field>
                </div>
                {line.lineBasis === "quantity" && (
                  <>
                    <Field label={copy("单位")} required={line.sourceType === "non_catalog_item"} error={line.sourceType === "non_catalog_item" ? lineError(index, "unitSnapshot") : null}>
                      {/* The item's unit in the interface language ("件" for pcs); the stored code stays. */}
                      {line.sourceType === "catalog_item" ? <input readOnly value={line.unitSnapshot ? unitLabel(line.unitSnapshot, language) : ""} data-testid="pr-line-unit" style={{ ...inputStyle, background: A.gray6 }} /> : <select value={line.unitSnapshot || ""} onChange={(e) => patchLine(index, { unitSnapshot: e.target.value })} style={inputStyle}><option value="">{copy("选择单位")}</option>{units.map((option) => <option key={option.id} value={option.id}>{copy(option.label)}</option>)}</select>}
                      {prefillChip(line, "unitSnapshot")}
                    </Field>
                    <Field label={copy("数量")} required error={lineError(index, "quantity")}>
                      <input
                        type="number"
                        min="0"
                        value={line.quantity}
                        onChange={(e) =>
                          patchLine(index, { quantity: e.target.value })
                        }
                        style={inputStyle}
                      />
                      {prefillChip(line, "quantity")}
                    </Field>
                    <Field label={copy("预计单价")} required error={lineError(index, "estimatedUnitPrice")}>
                      <input
                        aria-label={`${copy("预计单价")} ${index + 1}`}
                        type="number"
                        min="0"
                        placeholder={copy("请输入")}
                        value={line.estimatedUnitPrice}
                        onChange={(e) =>
                          patchLine(index, {
                            estimatedUnitPrice: e.target.value,
                          })
                        }
                        style={inputStyle}
                      />
                      {prefillChip(line, "estimatedUnitPrice")}
                    </Field>
                  </>
                )}
                {line.lineBasis === "amount" && (
                  <div className="md:col-span-3 xl:col-span-3">
                    <Field label={copy("预计总金额")} required error={lineError(index, "estimatedAmount")}>
                      <input
                        type="number"
                        min="0"
                        value={line.estimatedAmount}
                        onChange={(e) =>
                          patchLine(index, { estimatedAmount: e.target.value })
                        }
                        style={inputStyle}
                      />
                    </Field>
                  </div>
                )}
                <div className="md:col-span-2 xl:col-span-2">
                  <Field label={copy("目标仓库或服务地点")}>
                    <select
                      value={line.targetWarehouseId}
                      onChange={(e) =>
                        patchLine(index, { targetWarehouseId: e.target.value })
                      }
                      style={inputStyle}
                    >
                      <option value="">{copy("选择地点")}</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                    {prefillChip(line, "targetWarehouseId")}
                  </Field>
                </div>
                <Field label={copy("需求日期")} required error={lineError(index, "needByDate")}>
                  <input
                    type="date"
                    value={line.needByDate}
                    onChange={(e) =>
                      patchLine(index, { needByDate: e.target.value })
                    }
                    style={inputStyle}
                  />
                  {prefillChip(line, "needByDate")}
                </Field>
              </div>
              {/* Earlier PO prices for the item, beside the estimated unit price. Display only. */}
              {line.lineBasis === "quantity" && priceHistoryKeyOf(line) && (
                <div className="mt-3">
                  <PriceHistoryFacts history={priceHistory.histories.get(priceHistoryKeyOf(line))} state={priceHistory.state} testId={`pr-line-price-history-${index + 1}`} />
                </div>
              )}
              <div className="mt-3">
                <Field label={copy("行级内部备注")}>
                  <textarea
                    aria-label={`${copy("行级内部备注")} ${index + 1}`}
                    value={line.internalLineComment}
                    onChange={(e) =>
                      patchLine(index, { internalLineComment: e.target.value })
                    }
                    rows={2}
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                  {prefillChip(line, "internalLineComment")}
                </Field>
              </div>
            </FormLineCard>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setLines([...lines, makeLine(defaultDate)])}
            className={listButtonClass.secondary}
          >
            <Plus size={13} />{copy("新增采购行")}</button>
          <strong className="text-sm tabular-nums" style={{ color: A.label }}>{copy("预计总额")} {amount(total, currency)}
          </strong>
        </div>
      </FormSection>

      <FormActionBar
        onCancel={closeForm}
        draft={{ label: copy("保存草稿"), onClick: () => void save(false), busy: saving === "draft" }}
        submit={{ label: copy("保存并提交"), onClick: () => void save(true), busy: saving === "submit" }}
        message={formMessage}
        messageTestId="purchase-request-form-errors"
      />
      {confirmDialog.element}
    </div>
  );
}
