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

test("CSV parser fails closed for malformed quotes and oversized rows", () => {
  assert.throws(() => parseCsvArtifact(Buffer.from('code,name\nSUP-1,"unterminated\n'), { delimiter: "comma" }), error => error.code === "INTAKE_CSV_PARSE_FAILED");
  assert.throws(() => parseCsvArtifact(Buffer.from(`code,name\nSUP-1,${"x".repeat(70_000)}\n`), { delimiter: "comma" }), error => error.code === "INTAKE_CSV_PARSE_FAILED");
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

test("Paste adapters reject oversized and excessively nested input", () => {
  assert.throws(() => parsePasteTable(`code\tname\nSUP-1\t${"x".repeat(10 * 1024 * 1024)}`), error => error.code === "INTAKE_PASTE_SIZE_LIMIT");
  assert.throws(() => parsePasteJson('[{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}]'), error => error.code === "INTAKE_PAYLOAD_NESTING_LIMIT");
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

test("XLSX parser records cached formulas but rejects formulas without cached results", async () => {
  const cachedBook = XLSX.utils.book_new();
  const cached = XLSX.utils.aoa_to_sheet([["code", "calculated"], ["SUP-1", null]]);
  cached.B2 = { t: "n", f: "2+2", v: 4 };
  cached["!ref"] = "A1:B2";
  XLSX.utils.book_append_sheet(cachedBook, cached, "Suppliers");
  const cachedResult = await parseXlsxArtifact(XLSX.write(cachedBook, { type: "buffer", bookType: "xlsx" }));
  assert.ok(cachedResult.warnings.some(value => value.code === "INTAKE_XLSX_FORMULA_PRESENT"));

  const missingBook = XLSX.utils.book_new();
  const missing = XLSX.utils.aoa_to_sheet([["code", "calculated"], ["SUP-1", null]]);
  missing.B2 = { t: "n", f: "2+2" };
  missing["!ref"] = "A1:B2";
  XLSX.utils.book_append_sheet(missingBook, missing, "Suppliers");
  await assert.rejects(() => parseXlsxArtifact(XLSX.write(missingBook, { type: "buffer", bookType: "xlsx" })), error => error.code === "INTAKE_XLSX_FORMULA_RESULT_UNAVAILABLE");
});

test("XLSX parser rejects corrupt archives and excessive columns", async () => {
  await assert.rejects(() => parseXlsxArtifact(Buffer.from("not-an-xlsx")), error => error.code === "INTAKE_XLSX_CORRUPT");
  const wideBook = XLSX.utils.book_new();
  const wide = XLSX.utils.aoa_to_sheet([Array.from({ length: 201 }, (_, index) => `field_${index}`), Array.from({ length: 201 }, () => "x")]);
  XLSX.utils.book_append_sheet(wideBook, wide, "Wide");
  await assert.rejects(() => parseXlsxArtifact(XLSX.write(wideBook, { type: "buffer", bookType: "xlsx" })), error => error.code === "INTAKE_COLUMN_LIMIT");
});
