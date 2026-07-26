import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import {
  parseCsvArtifact,
  parsePasteJson,
  parsePasteTable,
  parseXlsxArtifact,
} from "./structured-intake-parser.mjs";

test("CSV parser handles UTF-8 BOM, quoted delimiters, and formula-like literals", () => {
  const parsed = parseCsvArtifact(Buffer.from("\ufeff供应商编码,名称,备注\r\nSUP-1,\"苏州,组件\",\"=2+2\"\r\n"), {});
  assert.equal(parsed.encoding, "utf-8");
  assert.equal(parsed.delimiter, ",");
  assert.equal(parsed.records[0].source.名称, "苏州,组件");
  assert.equal(parsed.records[0].source.备注, "=2+2");
});

test("CSV parser supports explicit GB18030 and rejects ambiguous or duplicate headers", () => {
  const parsed = parseCsvArtifact(iconv.encode("编码;名称\nSUP-1;苏州组件\n", "gb18030"), { encoding: "gb18030" });
  assert.equal(parsed.encoding, "gb18030");
  assert.throws(() => parseCsvArtifact(Buffer.from("name,name\none,two\n")), error => error.code === "INTAKE_HEADER_DUPLICATE");
  assert.throws(() => parseCsvArtifact(Buffer.from("single\nvalue\n")), error => error.code === "INTAKE_CSV_DELIMITER_REQUIRED");
});

test("Paste Table prefers deterministic tabular parsing and preserves provenance", () => {
  const parsed = parsePasteTable("code\tname\nSUP-1\tSuzhou Components\n");
  assert.equal(parsed.sourceFormat, "paste_table");
  assert.equal(parsed.records[0].sourceLocator.sourceFormat, "paste_table");
  assert.equal(parsed.checksumSha256.length, 64);
});

test("Paste JSON accepts only safe object arrays and blocks control, secret, and prototype keys", () => {
  const parsed = parsePasteJson('[{"code":"SUP-1","name":"Suzhou Components"}]');
  assert.deepEqual(parsed.sourceFieldNames, ["code", "name"]);
  assert.throws(() => parsePasteJson('{"records":[{"tenantId":"other"}]}'), error => error.code === "INTAKE_JSON_CONTROL_FIELD_FORBIDDEN");
  assert.throws(() => parsePasteJson('[{"password":"no"}]'), error => error.code === "INTAKE_PAYLOAD_SECRET_FIELD");
  assert.throws(() => parsePasteJson('[{"__proto__":{"polluted":true}}]'), error => error.code === "INTAKE_PAYLOAD_PROTOTYPE_KEY");
  assert.equal({}.polluted, undefined);
});

test("XLSX parser profiles a visible selected sheet without executing formulas", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["sku", "name"], ["ITEM-1", "Precision Part"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Items");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const parsed = await parseXlsxArtifact(bytes);
  assert.equal(parsed.selectedSheet, "Items");
  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.records[0].source.sku, "ITEM-1");
});

test("XLSX parser rejects hidden-only workbooks and merged data regions", async () => {
  const hiddenBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(hiddenBook, XLSX.utils.aoa_to_sheet([["sku"], ["A"]]), "Hidden");
  hiddenBook.Workbook = { Sheets: [{ Hidden: 1 }] };
  const hiddenBytes = XLSX.write(hiddenBook, { type: "buffer", bookType: "xlsx" });
  await assert.rejects(() => parseXlsxArtifact(hiddenBytes), error => error.code === "INTAKE_XLSX_SHEET_REQUIRED");

  const mergedBook = XLSX.utils.book_new();
  const merged = XLSX.utils.aoa_to_sheet([["sku", "name"], ["A", "Part"]]);
  merged["!merges"] = [XLSX.utils.decode_range("A1:B1")];
  XLSX.utils.book_append_sheet(mergedBook, merged, "Items");
  const mergedBytes = XLSX.write(mergedBook, { type: "buffer", bookType: "xlsx" });
  await assert.rejects(() => parseXlsxArtifact(mergedBytes), error => error.code === "INTAKE_XLSX_MERGED_CELL_UNSUPPORTED");
});
