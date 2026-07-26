import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { parse as parseCsvSync } from "csv-parse/sync";
import iconv from "iconv-lite";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import { INTAKE_LIMITS, assertSafePayload, failIntake } from "./intake-contracts.mjs";

export const STRUCTURED_PARSER_VERSION = "flowchain-structured-parser/1";
export const STRUCTURED_LIMITS = Object.freeze({
  maximumSheetCount: 32,
  maximumZipEntries: 2_000,
  maximumUncompressedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 100,
  maximumSampleRows: 10,
});
const delimiters = Object.freeze({ comma: ",", tab: "\t", semicolon: ";" });
const supportedEncodings = new Set(["utf8", "utf-8", "gb18030"]);

const parserFailure = (code, message, status = 422, details) => failIntake(code, message, status, details);
const boundedString = value => String(value ?? "").slice(0, INTAKE_LIMITS.maximumRowPayloadBytes);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function decodeText(bytes, encoding) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.byteLength > INTAKE_LIMITS.maximumArtifactSizeBytes) parserFailure("INTAKE_ARTIFACT_SIZE_LIMIT", "Artifact exceeds 10 MB.", 413);
  const selected = String(encoding || "").trim().toLowerCase();
  if (selected && !supportedEncodings.has(selected)) parserFailure("INTAKE_CSV_ENCODING_UNSUPPORTED", "Only UTF-8 and explicitly selected GB18030 are supported.", 422);
  if (selected === "gb18030") return { text: iconv.decode(buffer, "gb18030"), encoding: "gb18030" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    parserFailure("INTAKE_CSV_ENCODING_REQUIRED", "Encoding could not be verified as UTF-8; select GB18030 explicitly if applicable.", 422);
  }
}

function scoreDelimiter(text, delimiter) {
  try {
    const rows = parseCsvSync(text, {
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      to_line: 8,
    });
    if (!rows.length) return 0;
    const counts = rows.map(row => row.length);
    return counts[0] > 1 && counts.every(count => count === counts[0]) ? counts[0] : 0;
  } catch {
    return 0;
  }
}

function selectDelimiter(text, requested, { ambiguousCode = "INTAKE_CSV_DELIMITER_REQUIRED" } = {}) {
  const explicit = delimiters[String(requested || "").trim().toLowerCase()] || (Object.values(delimiters).includes(requested) ? requested : null);
  if (explicit) return explicit;
  const ranked = Object.values(delimiters).map(delimiter => ({ delimiter, score: scoreDelimiter(text, delimiter) })).sort((a, b) => b.score - a.score);
  if (!ranked[0].score || ranked[0].score === ranked[1].score) parserFailure(ambiguousCode, "Delimiter is ambiguous; select comma, tab, or semicolon.", 422);
  return ranked[0].delimiter;
}

function validateHeaders(rawHeaders) {
  const headers = rawHeaders.map(value => boundedString(value).trim());
  if (!headers.length || headers.every(value => !value)) parserFailure("INTAKE_HEADER_MISSING", "A non-empty header row is required.", 422);
  if (headers.length > INTAKE_LIMITS.maximumFieldCount) parserFailure("INTAKE_COLUMN_LIMIT", "Column count exceeds 200.", 413);
  if (headers.some(value => !value)) parserFailure("INTAKE_HEADER_MISSING", "Every source column requires a header.", 422);
  const normalized = headers.map(value => value.toLocaleLowerCase());
  const duplicate = normalized.find((value, index) => normalized.indexOf(value) !== index);
  if (duplicate) parserFailure("INTAKE_HEADER_DUPLICATE", "Duplicate source headers are not allowed.", 422, { header: headers[normalized.indexOf(duplicate)] });
  return headers;
}

function matrixProfile(matrix, options = {}) {
  const headerIndex = Number.isInteger(options.headerRowNumber) && options.headerRowNumber > 0 ? options.headerRowNumber - 1 : 0;
  if (!matrix.length || !Array.isArray(matrix[headerIndex])) parserFailure("INTAKE_HEADER_MISSING", "Selected header row does not exist.", 422);
  const headers = validateHeaders(matrix[headerIndex]);
  const dataRows = matrix.slice(headerIndex + 1).filter(row => Array.isArray(row) && row.some(value => String(value ?? "").trim()));
  if (dataRows.length > INTAKE_LIMITS.maximumRecordCount) parserFailure("INTAKE_RECORD_COUNT_LIMIT", "Record count exceeds 5,000.", 413);
  const records = dataRows.map((row, index) => {
    const source = Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""]));
    assertSafePayload(source);
    return {
      rowNumber: headerIndex + index + 2,
      source,
      sourceLocator: {
        sourceFormat: options.sourceFormat,
        sheetName: options.sheetName || null,
        rowNumber: headerIndex + index + 2,
        headerRowNumber: headerIndex + 1,
      },
    };
  });
  return {
    headers,
    records,
    headerRowNumber: headerIndex + 1,
    rowCount: records.length,
    columnCount: headers.length,
    sampleRows: records.slice(0, STRUCTURED_LIMITS.maximumSampleRows).map(record => record.source),
    emptyColumns: headers.filter(header => records.every(record => record.source[header] === "" || record.source[header] == null)),
  };
}

export function parseCsvArtifact(bytes, options = {}) {
  const decoded = decodeText(bytes, options.encoding);
  const delimiter = selectDelimiter(decoded.text, options.delimiter);
  let matrix;
  try {
    matrix = parseCsvSync(decoded.text, {
      bom: true,
      delimiter,
      relax_column_count: false,
      skip_empty_lines: true,
      quote: '"',
      escape: '"',
      max_record_size: INTAKE_LIMITS.maximumRowPayloadBytes,
    });
  } catch {
    parserFailure("INTAKE_CSV_PARSE_FAILED", "CSV could not be parsed with the selected encoding and delimiter.", 422);
  }
  const profile = matrixProfile(matrix, { sourceFormat: "csv", headerRowNumber: options.headerRowNumber });
  return {
    sourceFormat: "csv",
    encoding: decoded.encoding,
    delimiter,
    sheetList: [],
    selectedSheet: null,
    headerCandidates: [profile.headerRowNumber],
    selectedHeaderRow: profile.headerRowNumber,
    sourceFieldNames: profile.headers,
    duplicateHeaders: [],
    warnings: [],
    parserVersion: STRUCTURED_PARSER_VERSION,
    checksumSha256: sha256(bytes),
    ...profile,
  };
}

export function parsePasteTable(text, options = {}) {
  const content = String(text ?? "");
  if (Buffer.byteLength(content, "utf8") > INTAKE_LIMITS.maximumArtifactSizeBytes) parserFailure("INTAKE_PASTE_SIZE_LIMIT", "Pasted table exceeds 10 MB.", 413);
  if (!content.trim()) parserFailure("INTAKE_PASTE_EMPTY", "Pasted table is empty.", 422);
  const delimiter = selectDelimiter(content, options.delimiter, { ambiguousCode: "INTAKE_PASTE_DELIMITER_REQUIRED" });
  const parsed = parseCsvArtifact(Buffer.from(content, "utf8"), { delimiter, encoding: "utf-8", headerRowNumber: options.headerRowNumber });
  return {
    ...parsed,
    sourceFormat: "paste_table",
    records: parsed.records.map(record => ({
      ...record,
      sourceLocator: { ...record.sourceLocator, sourceFormat: "paste_table" },
    })),
  };
}

export function parsePasteJson(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > INTAKE_LIMITS.maximumArtifactSizeBytes) parserFailure("INTAKE_PASTE_SIZE_LIMIT", "Pasted JSON exceeds 10 MB.", 413);
    try { parsed = JSON.parse(value); } catch { parserFailure("INTAKE_JSON_INVALID", "Pasted JSON must be valid JSON.", 422); }
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? parsed.records : null;
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !row || Array.isArray(row) || typeof row !== "object")) {
    parserFailure("INTAKE_JSON_OBJECT_ARRAY_REQUIRED", "Pasted JSON must be an object array or an object containing records.", 422);
  }
  if (rows.length > INTAKE_LIMITS.maximumRecordCount) parserFailure("INTAKE_RECORD_COUNT_LIMIT", "Record count exceeds 5,000.", 413);
  const forbiddenControl = new Set(["tenantid", "status", "approved", "approvalstatus", "workflowstatus"]);
  const safeRows = rows.map(row => {
    const safe = assertSafePayload(row);
    const blocked = Object.keys(safe).find(key => forbiddenControl.has(key.toLowerCase()));
    if (blocked) parserFailure("INTAKE_JSON_CONTROL_FIELD_FORBIDDEN", "Pasted JSON contains an internal control field.", 422, { field: blocked });
    return safe;
  });
  const headers = validateHeaders([...new Set(safeRows.flatMap(row => Object.keys(row)))]);
  const records = safeRows.map((source, index) => ({
    rowNumber: index + 1,
    source,
    sourceLocator: { sourceFormat: "paste_json", sheetName: null, rowNumber: index + 1, headerRowNumber: null },
  }));
  return {
    sourceFormat: "paste_json",
    encoding: "utf-8",
    delimiter: null,
    sheetList: [],
    selectedSheet: null,
    headerCandidates: [],
    selectedHeaderRow: null,
    rowCount: records.length,
    columnCount: headers.length,
    sourceFieldNames: headers,
    duplicateHeaders: [],
    emptyColumns: headers.filter(header => records.every(record => record.source[header] == null || record.source[header] === "")),
    sampleRows: records.slice(0, STRUCTURED_LIMITS.maximumSampleRows).map(record => record.source),
    warnings: [],
    parserVersion: STRUCTURED_PARSER_VERSION,
    checksumSha256: sha256(Buffer.from(JSON.stringify(safeRows))),
    records,
  };
}

function inspectZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let entries = 0;
      let compressed = 0;
      let uncompressed = 0;
      zip.readEntry();
      zip.on("entry", entry => {
        entries += 1;
        compressed += Number(entry.compressedSize || 0);
        uncompressed += Number(entry.uncompressedSize || 0);
        if (entries > STRUCTURED_LIMITS.maximumZipEntries || uncompressed > STRUCTURED_LIMITS.maximumUncompressedBytes || (compressed > 0 && uncompressed / compressed > STRUCTURED_LIMITS.maximumCompressionRatio)) {
          zip.close();
          return reject(Object.assign(new Error("zip limits"), { code: "INTAKE_XLSX_ZIP_BOMB" }));
        }
        zip.readEntry();
      });
      zip.on("end", () => resolve({ entries, compressedBytes: compressed, uncompressedBytes: uncompressed }));
      zip.on("error", reject);
    });
  });
}

function cellValue(cell, warnings, locator) {
  if (!cell) return "";
  if (cell.f) {
    if (cell.v === undefined || cell.v === null) parserFailure("INTAKE_XLSX_FORMULA_RESULT_UNAVAILABLE", "Formula cell has no trusted cached result.", 422, locator);
    warnings.push({ code: "INTAKE_XLSX_FORMULA_PRESENT", locator });
  }
  if (cell.t === "d" || cell.v instanceof Date) return new Date(cell.v).toISOString();
  if (cell.t === "n" && typeof cell.w === "string" && cell.w.trim()) return cell.w.replace(/,/g, "");
  return cell.v ?? "";
}

export async function parseXlsxArtifact(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.byteLength > INTAKE_LIMITS.maximumArtifactSizeBytes) parserFailure("INTAKE_ARTIFACT_SIZE_LIMIT", "Artifact exceeds 10 MB.", 413);
  try { await inspectZip(buffer); } catch (error) {
    if (error?.code === "INTAKE_XLSX_ZIP_BOMB") parserFailure("INTAKE_XLSX_ZIP_BOMB", "Workbook archive exceeds safe ZIP limits.", 413);
    parserFailure("INTAKE_XLSX_CORRUPT", "Workbook archive is corrupt or unsupported.", 422);
  }
  let workbook;
  try { workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, cellFormula: true, cellText: true, bookVBA: false }); }
  catch { parserFailure("INTAKE_XLSX_CORRUPT", "Workbook could not be parsed.", 422); }
  if (workbook.SheetNames.length > STRUCTURED_LIMITS.maximumSheetCount) parserFailure("INTAKE_XLSX_SHEET_LIMIT", "Workbook contains too many sheets.", 413);
  const metadata = workbook.Workbook?.Sheets || [];
  const sheetList = workbook.SheetNames.map((name, index) => ({ name, state: metadata[index]?.Hidden === 2 ? "veryHidden" : metadata[index]?.Hidden === 1 ? "hidden" : "visible" }));
  const visible = sheetList.filter(sheet => sheet.state === "visible");
  const selectedSheet = String(options.sheetName || (visible.length === 1 ? visible[0].name : "")).trim();
  if (!selectedSheet) parserFailure("INTAKE_XLSX_SHEET_REQUIRED", "Select one visible workbook sheet.", 422, { sheetList });
  const selectedMetadata = sheetList.find(sheet => sheet.name === selectedSheet);
  if (!selectedMetadata) parserFailure("INTAKE_XLSX_SHEET_REQUIRED", "Selected sheet does not exist.", 422);
  if (selectedMetadata.state !== "visible") parserFailure("INTAKE_XLSX_HIDDEN_SHEET", "Hidden and veryHidden sheets cannot be selected automatically.", 422);
  const sheet = workbook.Sheets[selectedSheet];
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  if (!range) parserFailure("INTAKE_HEADER_MISSING", "Selected sheet is empty.", 422);
  const headerRowIndex = Number.isInteger(options.headerRowNumber) && options.headerRowNumber > 0 ? options.headerRowNumber - 1 : range.s.r;
  if ((sheet["!merges"] || []).some(merge => merge.s.r <= headerRowIndex || merge.s.r <= range.e.r && merge.e.r >= headerRowIndex + 1)) {
    parserFailure("INTAKE_XLSX_MERGED_CELL_UNSUPPORTED", "Merged cells in the header or data region are not supported.", 422);
  }
  const warnings = [];
  const matrix = [];
  for (let row = headerRowIndex; row <= range.e.r; row += 1) {
    if (matrix.length > INTAKE_LIMITS.maximumRecordCount) parserFailure("INTAKE_RECORD_COUNT_LIMIT", "Record count exceeds 5,000.", 413);
    const values = [];
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      if (column - range.s.c >= INTAKE_LIMITS.maximumFieldCount) parserFailure("INTAKE_COLUMN_LIMIT", "Column count exceeds 200.", 413);
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      values.push(cellValue(sheet[address], warnings, { sheetName: selectedSheet, cell: address }));
    }
    matrix.push(values);
  }
  const profile = matrixProfile(matrix, { sourceFormat: "xlsx", sheetName: selectedSheet, headerRowNumber: 1 });
  profile.records = profile.records.map(record => ({
    ...record,
    rowNumber: record.rowNumber + headerRowIndex,
    sourceLocator: { ...record.sourceLocator, rowNumber: record.rowNumber + headerRowIndex, headerRowNumber: headerRowIndex + 1 },
  }));
  return {
    sourceFormat: "xlsx",
    encoding: null,
    delimiter: null,
    sheetList,
    selectedSheet,
    headerCandidates: [headerRowIndex + 1],
    selectedHeaderRow: headerRowIndex + 1,
    sourceFieldNames: profile.headers,
    duplicateHeaders: [],
    warnings,
    parserVersion: STRUCTURED_PARSER_VERSION,
    checksumSha256: sha256(buffer),
    ...profile,
    headerRowNumber: headerRowIndex + 1,
  };
}
