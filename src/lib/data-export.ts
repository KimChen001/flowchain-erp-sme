export type ExportCellValue = string | number | boolean | null | undefined | Date | object;
export type ExportRow = Record<string, ExportCellValue>;

export function flattenExportRow(row: Record<string, unknown>): ExportRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)])
  );
}

export function normalizeCsvRows(rows: Record<string, unknown>[]) {
  const flattened = rows.map(flattenExportRow);
  const headers = Array.from(new Set(flattened.flatMap((row) => Object.keys(row))));
  return { headers, rows: flattened };
}

export function csvEscape(value: ExportCellValue): string {
  const text = stringifyCellValue(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export async function exportRowsToCsv(filename: string, rows: Record<string, unknown>[], timeZone?: string) {
  const businessObject = filename.replace(/\.(csv|xlsx)$/i, "").replace(/-export$/i, "");
  return exportRowsToWorkbook(businessObject, rows, undefined, timeZone);
}

export function downloadTextFile(filename: string, content: string, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function normalizeCellValue(value: unknown): ExportCellValue {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return safeJsonStringify(value);
}

function stringifyCellValue(value: ExportCellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return safeJsonStringify(value);
  return String(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
import { exportRowsToWorkbook } from "./excel/excelWorkbookService";
