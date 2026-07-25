import { ITEM_MASTER, SUPPLIER_MASTER, WAREHOUSE_BINS } from "../../data/master-data";
import { purchaseOrders, receivingDocs, SUPPLIER_INVOICES } from "../../data/empty-business-state";
import type { ExcelBusinessSchema, ExcelFieldSchema } from "./excelSchemas";

export type ValidationLevel = "valid" | "warning" | "error";
export type ImportValidationIssue = { rowNumber: number; field: string; level: Exclude<ValidationLevel, "valid">; reason: string; suggestion: string };
export type ValidatedImportRow = { rowNumber: number; original: Record<string, unknown>; normalized: Record<string, unknown>; level: ValidationLevel; issues: ImportValidationIssue[] };
export type ImportValidationResult = { rows: ValidatedImportRow[]; validRows: number; warningRows: number; errorRows: number; unknownHeaders: string[] };

export function autoMapHeaders(headers: string[], schema: ExcelBusinessSchema) {
  return Object.fromEntries(schema.fields.map((field) => {
    const candidates = [field.label, field.key, ...(field.aliases || [])].map((value) => value.toLowerCase().replace(/\s/g, ""));
    const match = headers.find((header) => candidates.includes(header.toLowerCase().replace(/\s/g, ""))) || "";
    return [field.key, match];
  }));
}

function issue(rowNumber: number, field: ExcelFieldSchema, level: "warning" | "error", reason: string, suggestion: string): ImportValidationIssue {
  return { rowNumber, field: field.label, level, reason, suggestion };
}

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateMasterData(field: ExcelFieldSchema, value: string) {
  if (!value) return true;
  if (field.key === "supplierCode") return SUPPLIER_MASTER.some((item) => item.code === value || item.name === value);
  if (field.key === "sku" || field.key === "sourceSku") return ITEM_MASTER.some((item) => item.sku === value);
  if (field.key === "warehouse" || field.key === "defaultWarehouse") return WAREHOUSE_BINS.some((item) => item.warehouseName === value || item.warehouseCode === value);
  if (field.key === "relatedPo") return purchaseOrders.some((item) => item.po === value);
  if (field.key === "relatedGrn") return receivingDocs.some((item) => item.grn === value);
  if (field.key === "relatedInvoice") return SUPPLIER_INVOICES.some((item) => item.invoiceNumber === value);
  return true;
}

export function validateImportRows(rows: Record<string, unknown>[], headers: string[], schema: ExcelBusinessSchema, mapping: Record<string, string>): ImportValidationResult {
  const duplicateKeys = ["invoiceNumber", "statementNo", "pr", "code", "sku"].filter((key) => schema.fields.some((field) => field.key === key));
  const seen = new Set<string>();
  const knownMapped = new Set(Object.values(mapping).filter(Boolean));
  const unknownHeaders = headers.filter((header) => !knownMapped.has(header));
  const validated = rows.map((original, index): ValidatedImportRow => {
    const rowNumber = index + 2;
    const normalized = Object.fromEntries(schema.fields.map((field) => [field.key, mapping[field.key] ? original[mapping[field.key]] : ""]));
    const issues: ImportValidationIssue[] = [];
    schema.fields.forEach((field) => {
      const raw = normalized[field.key];
      const text = String(raw ?? "").trim();
      if (field.required && !text) issues.push(issue(rowNumber, field, "error", "必填字段缺失", `请填写${field.label}`));
      if (!text) return;
      if (field.type === "date" && !isValidDate(text)) issues.push(issue(rowNumber, field, "error", "日期格式错误", "使用 YYYY-MM-DD，例如 2026-07-11"));
      if (["number", "amount"].includes(field.type)) {
        const number = Number(String(raw).replace(/,/g, ""));
        if (!Number.isFinite(number)) issues.push(issue(rowNumber, field, "error", "数字格式错误", "使用 Excel 数值格式"));
        else if (number < 0) issues.push(issue(rowNumber, field, "error", field.type === "amount" ? "负金额" : "负数量", "改为大于或等于 0 的数值"));
        else normalized[field.key] = number;
      }
      if (field.type === "currency" && !["CNY", "USD", "EUR"].includes(text)) issues.push(issue(rowNumber, field, "error", "币种无效", "使用 CNY、USD 或 EUR"));
      if (field.options && !field.options.includes(text)) issues.push(issue(rowNumber, field, "error", "状态值无效", `可选值：${field.options.join("、")}`));
      if (!validateMasterData(field, text)) issues.push(issue(rowNumber, field, "error", `未知${field.masterData || field.label}`, `请先维护${field.masterData || "关联主数据"}或修正编号`));
    });
    duplicateKeys.forEach((key) => {
      const value = String(normalized[key] || "");
      if (!value) return;
      const token = `${key}:${value}`;
      const field = schema.fields.find((item) => item.key === key)!;
      if (seen.has(token)) issues.push(issue(rowNumber, field, "error", "重复编号", "删除重复行或修正编号")); else seen.add(token);
    });
    unknownHeaders.forEach((header) => issues.push({ rowNumber, field: header, level: "warning", reason: "无法识别的字段", suggestion: "可忽略或在字段映射中手工选择" }));
    const level = issues.some((item) => item.level === "error") ? "error" : issues.length ? "warning" : "valid";
    return { rowNumber, original, normalized, issues, level };
  });
  return { rows: validated, validRows: validated.filter((row) => row.level === "valid").length, warningRows: validated.filter((row) => row.level === "warning").length, errorRows: validated.filter((row) => row.level === "error").length, unknownHeaders };
}
