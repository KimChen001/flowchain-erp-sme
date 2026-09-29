import type { ExcelBusinessSchema } from "./excelSchemas";
import { todayInTimeZone } from "../format";
type XlsxModule = typeof import("xlsx");
const loadXlsx = () => import("xlsx");

export type ParsedWorkbook = { fileName: string; fileSize: number; sheetNames: string[]; sheets: Record<string, Record<string, unknown>[]>; headers: Record<string, string[]> };

export async function parseExcelFile(file: File): Promise<ParsedWorkbook> {
  const XLSX = await loadXlsx();
  const isCsv = /\.csv$/i.test(file.name);
  const data = isCsv ? await file.text() : await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: isCsv ? "string" : "array", cellDates: true });
  const sheets: ParsedWorkbook["sheets"] = {};
  const headers: ParsedWorkbook["headers"] = {};
  const normalizeCell = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
  workbook.SheetNames.forEach((name) => {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true });
    const header = (matrix[0] || []).map((value) => String(value).trim()).filter(Boolean);
    headers[name] = header;
    sheets[name] = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true }).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCell(value)])));
  });
  return { fileName: file.name, fileSize: file.size, sheetNames: workbook.SheetNames, sheets, headers };
}

function downloadWorkbook(XLSX: XlsxModule, workbook: import("xlsx").WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename, { compression: true });
  return filename;
}

function fitColumns(rows: Record<string, unknown>[], headers: string[]) {
  return headers.map((header) => ({ wch: Math.min(36, Math.max(12, header.length * 2 + 2, ...rows.slice(0, 50).map((row) => String(row[header] ?? "").length + 2))) }));
}

export async function downloadExcelTemplate(schema: ExcelBusinessSchema) {
  const XLSX = await loadXlsx();
  const dataRow = Object.fromEntries(schema.fields.map((item) => [item.label, item.example]));
  const dataSheet = XLSX.utils.json_to_sheet([dataRow], { header: schema.fields.map((item) => item.label) });
  dataSheet["!cols"] = fitColumns([dataRow], schema.fields.map((item) => item.label));
  dataSheet["!autofilter"] = { ref: dataSheet["!ref"] || "A1:A2" };
  (dataSheet as Record<string, unknown>)["!freeze"] = { xSplit: 0, ySplit: 1 };
  const definitions = schema.fields.map((item) => ({ 中文字段名: item.label, 系统字段名: item.key, 是否必填: item.required ? "是" : "否", 数据类型: item.type, 字段说明: item.description, 示例值: item.example, 可选值: item.options?.join("、") || "", 关联主数据对象: item.masterData || "", 校验规则: item.validation || "" }));
  const definitionSheet = XLSX.utils.json_to_sheet(definitions);
  definitionSheet["!cols"] = fitColumns(definitions, Object.keys(definitions[0]));
  const guide = [
    { 项目: "日期格式", 说明: "统一使用 YYYY-MM-DD，例如 2026-07-11" }, { 项目: "金额格式", 说明: "使用 Excel 数值，不输入货币符号和千分位文本" },
    { 项目: "数量格式", 说明: "使用大于或等于 0 的数值，业务要求正数时不可为 0" }, { 项目: "编码规则", 说明: "编号在当前业务对象内唯一，关联编号必须存在" },
    { 项目: "空值处理", 说明: "必填字段不可为空；可选字段留空，不使用 N/A" }, { 项目: "常见错误", 说明: "重复编号、日期格式错误、负数、未知主数据、币种或状态无效" },
    { 项目: "导入步骤", 说明: "选择文件 → 选择 Sheet → 字段映射 → 校验预览 → 确认导入" }, { 项目: "支持文件格式", 说明: ".xlsx、.xls、.csv" },
  ];
  const guideSheet = XLSX.utils.json_to_sheet(guide);
  guideSheet["!cols"] = [{ wch: 18 }, { wch: 68 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, "导入数据");
  XLSX.utils.book_append_sheet(workbook, definitionSheet, "字段说明");
  XLSX.utils.book_append_sheet(workbook, guideSheet, "导入说明");
  return downloadWorkbook(XLSX, workbook, schema.filename);
}

// timeZone: the workspace timezone for the filename date (America/New_York when not given).
export async function exportRowsToWorkbook(businessObject: string, rows: Record<string, unknown>[], sheetName = "当前结果", timeZone?: string) {
  const XLSX = await loadXlsx();
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers, cellDates: true });
  sheet["!cols"] = fitColumns(rows, headers);
  sheet["!autofilter"] = { ref: sheet["!ref"] || "A1:A1" };
  (sheet as Record<string, unknown>)["!freeze"] = { xSplit: 0, ySplit: 1 };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31));
  const date = todayInTimeZone(timeZone);
  return downloadWorkbook(XLSX, workbook, `${businessObject}-${date}.xlsx`);
}

export async function exportWorkbookSheets(businessObject: string, sheets: Array<{ name: string; rows: Record<string, unknown>[] }>, timeZone?: string) {
  const XLSX = await loadXlsx();
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const safeRows = rows.length ? rows : [{ 说明: "当前筛选范围暂无数据" }];
    const headers = Array.from(new Set(safeRows.flatMap((row) => Object.keys(row))));
    const sheet = XLSX.utils.json_to_sheet(safeRows, { header: headers, cellDates: true });
    sheet["!cols"] = fitColumns(safeRows, headers);
    sheet["!autofilter"] = { ref: sheet["!ref"] || "A1:A1" };
    (sheet as Record<string, unknown>)["!freeze"] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
  });
  const date = todayInTimeZone(timeZone);
  return downloadWorkbook(XLSX, workbook, `${businessObject}-${date}.xlsx`);
}
