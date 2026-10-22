import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { crc32 } from "node:zlib";
import { parse as parseCsvSync } from "csv-parse/sync";
import iconv from "iconv-lite";
import readExcelFile, { readSheet } from "read-excel-file/node";
import yauzl from "yauzl";
import { INTAKE_LIMITS, assertSafePayload, failIntake } from "./intake-contracts.mjs";

export const STRUCTURED_PARSER_VERSION = "flowchain-structured-parser/1";
export const STRUCTURED_LIMITS = Object.freeze({
  maximumSheetCount: 32,
  maximumZipEntries: 2_000,
  maximumUncompressedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 100,
  maximumSampleRows: 10,
  // The largest grid (rows times columns) the reader may build for a sheet.
  maximumSheetCells: 2_000_000,
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

// columnNumbers gives each header's column in the file (1-based) when some
// empty columns were dropped before the check.
function validateHeaders(rawHeaders, columnNumbers = null) {
  const headers = rawHeaders.map(value => boundedString(value).trim());
  if (!headers.length || headers.every(value => !value)) parserFailure("INTAKE_HEADER_MISSING", "A non-empty header row is required.", 422);
  if (headers.length > INTAKE_LIMITS.maximumFieldCount) parserFailure("INTAKE_COLUMN_LIMIT", "Column count exceeds 200.", 413);
  const blank = headers.findIndex(value => !value);
  if (blank >= 0) parserFailure("INTAKE_HEADER_MISSING", "Every source column requires a header.", 422, { column: columnNumbers?.[blank] ?? blank + 1 });
  const normalized = headers.map(value => value.toLocaleLowerCase());
  const duplicate = normalized.find((value, index) => normalized.indexOf(value) !== index);
  if (duplicate) parserFailure("INTAKE_HEADER_DUPLICATE", "Duplicate source headers are not allowed.", 422, { header: headers[normalized.indexOf(duplicate)] });
  return headers;
}

const filledCell = value => Boolean(String(value ?? "").trim());

// Row numbers are the rows of the sheet or CSV: blank rows are left out of
// the records but still counted, so a row number points at the right line.
// Without a header row number the first non-blank row holds the headers.
function matrixProfile(matrix, options = {}) {
  const firstFilled = matrix.findIndex(row => Array.isArray(row) && row.some(filledCell));
  const headerIndex = Number.isInteger(options.headerRowNumber) && options.headerRowNumber > 0 ? options.headerRowNumber - 1 : Math.max(firstFilled, 0);
  if (!matrix.length || !Array.isArray(matrix[headerIndex])) parserFailure("INTAKE_HEADER_MISSING", "Selected header row does not exist.", 422);
  const dataRows = [];
  matrix.slice(headerIndex + 1).forEach((row, offset) => {
    if (Array.isArray(row) && row.some(filledCell)) dataRows.push({ row, rowNumber: headerIndex + offset + 2 });
  });
  // With dropEmptyColumns, a column with no header and no value in any row
  // (a trailing comma, a cleared column) is left out instead of refused.
  let columns = matrix[headerIndex].map((_, index) => index);
  if (options.dropEmptyColumns) {
    const width = dataRows.reduce((max, entry) => Math.max(max, entry.row.length), matrix[headerIndex].length);
    columns = Array.from({ length: width }, (_, index) => index)
      .filter(index => filledCell(matrix[headerIndex][index]) || dataRows.some(entry => filledCell(entry.row[index])));
  }
  const headers = validateHeaders(columns.map(index => matrix[headerIndex][index] ?? ""), columns.map(index => index + 1));
  const maximumRecordCount = options.maximumRecordCount || INTAKE_LIMITS.maximumRecordCount;
  if (dataRows.length > maximumRecordCount) parserFailure("INTAKE_RECORD_COUNT_LIMIT", `Record count exceeds ${maximumRecordCount.toLocaleString("en-US")}.`, 413);
  const records = dataRows.map(({ row, rowNumber }) => {
    const source = Object.fromEntries(headers.map((header, column) => [header, row[columns[column]] ?? ""]));
    assertSafePayload(source);
    return {
      rowNumber,
      source,
      sourceLocator: {
        sourceFormat: options.sourceFormat,
        sheetName: options.sheetName || null,
        rowNumber,
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
    // Blank lines are kept so that row numbers count them; matrixProfile
    // leaves them out of the records.
    matrix = parseCsvSync(decoded.text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      quote: '"',
      escape: '"',
      max_record_size: INTAKE_LIMITS.maximumRowPayloadBytes,
    });
  } catch {
    parserFailure("INTAKE_CSV_PARSE_FAILED", "CSV could not be parsed with the selected encoding and delimiter.", 422);
  }
  // Every non-blank record has as many fields as the first one.
  const width = matrix.find(row => row.some(filledCell))?.length;
  if (matrix.some(row => row.some(filledCell) && row.length !== width)) parserFailure("INTAKE_CSV_PARSE_FAILED", "CSV could not be parsed with the selected encoding and delimiter.", 422);
  const profile = matrixProfile(matrix, { sourceFormat: "csv", headerRowNumber: options.headerRowNumber, dropEmptyColumns: options.dropEmptyColumns, maximumRecordCount: options.maximumRecordCount });
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

// The parts read-excel-file unpacks, by the test it uses itself.
const unpackedPart = name => name.endsWith(".xml") || name.endsWith(".xml.rels");
const zipLimitError = () => Object.assign(new Error("zip limits"), { code: "INTAKE_XLSX_ZIP_BOMB" });

// Unpacks every XML part of the workbook, counting the bytes actually
// inflated, not the sizes the archive declares: the whole unpacked workbook
// stays within the limit, and a part larger than its declared size fails.
function inspectZip(bytes, { maximumUncompressedBytes = STRUCTURED_LIMITS.maximumUncompressedBytes } = {}) {
  const uncompressedLimit = Math.min(maximumUncompressedBytes || STRUCTURED_LIMITS.maximumUncompressedBytes, STRUCTURED_LIMITS.maximumUncompressedBytes);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let entries = 0;
      let compressed = 0;
      let uncompressed = 0;
      let inflated = 0;
      const parts = new Map();
      let settled = false;
      const fail = failure => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* already closed */ }
        reject(failure);
      };
      zip.readEntry();
      zip.on("entry", entry => {
        entries += 1;
        compressed += Number(entry.compressedSize || 0);
        uncompressed += Number(entry.uncompressedSize || 0);
        if (entries > STRUCTURED_LIMITS.maximumZipEntries || uncompressed > uncompressedLimit || (compressed > 0 && uncompressed / compressed > STRUCTURED_LIMITS.maximumCompressionRatio)) {
          return fail(zipLimitError());
        }
        if (!unpackedPart(entry.fileName)) return zip.readEntry();
        if (parts.has(entry.fileName)) return fail(new Error(`duplicate part ${entry.fileName}`));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          const chunks = [];
          stream.on("data", chunk => {
            inflated += chunk.length;
            if (inflated > uncompressedLimit) {
              stream.destroy();
              return fail(zipLimitError());
            }
            chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            parts.set(entry.fileName, Buffer.concat(chunks));
            if (!settled) zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ entries, compressedBytes: compressed, uncompressedBytes: uncompressed, inflatedBytes: inflated, parts });
      });
      zip.on("error", fail);
    });
  });
}

// A stored (uncompressed) ZIP of the given parts. read-excel-file reads this
// instead of the upload, so it unpacks only the parts inspectZip counted and
// the parser checked: none larger than counted, none hidden from the central
// directory, no worksheet left out on purpose.
function repackParts(parts) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of parts) {
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, fileName, data);
    central.push(record, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.size, 8);
  end.writeUInt16LE(parts.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const codePoint = value => (Number.isInteger(value) && value <= 0x10ffff ? String.fromCodePoint(value) : "\ufffd");
const decodeXml = value => String(value || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, digits) => codePoint(Number(digits)))
  .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// The tags of an XML part, read the way read-excel-file's XML parser (saxen)
// reads them: a tag ends at the first ">" outside quotes, comments and CDATA
// hold no tags, and the namespace prefix is dropped from the name. One pass
// over the text, however it is formed.
function* xmlTagStream(xml) {
  const source = String(xml || "");
  const unclosedQuotes = new Set();
  let start = source.indexOf("<");
  while (start !== -1) {
    const skipTo = source.startsWith("<!--", start) ? "-->" : source.startsWith("<![CDATA[", start) ? "]]>" : "";
    if (skipTo) {
      const close = source.indexOf(skipTo, start + 4);
      if (close === -1) return;
      start = source.indexOf("<", close + skipTo.length);
      continue;
    }
    let end = start + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === ">") break;
      if ((char === '"' || char === "'") && !unclosedQuotes.has(char)) {
        const close = source.indexOf(char, end + 1);
        if (close === -1) unclosedQuotes.add(char);
        else end = close;
      }
    }
    if (end >= source.length) return;
    const body = source.slice(start + 1, end);
    const closing = body.startsWith("/");
    const name = (body.match(/^\/?([^\s/]*)/)?.[1] || "").replace(/.+:/, "");
    yield { name, closing, selfClosing: !closing && body.endsWith("/"), body };
    start = source.indexOf("<", end + 1);
  }
}

// Every value of an attribute in a tag (`attribute` is a pattern).
const attributeValues = (body, attribute) => [...body.matchAll(new RegExp(String.raw`\s${attribute}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "g"))]
  .map(match => decodeXml(match[1] ?? match[2]));

// The opening tags named `name`, each as a reader of its attributes.
function* xmlTags(xml, name) {
  for (const tag of xmlTagStream(xml)) {
    if (!tag.closing && tag.name === name) yield attribute => attributeValues(tag.body, attribute)[0];
  }
}

function workbookSheets(xml, fallbackNames) {
  const rows = [...xmlTags(xml, "sheet")].map((attribute, index) => ({
    name: attribute("name") || fallbackNames[index] || `Sheet ${index + 1}`,
    state: attribute("state") || "visible",
    relationId: attribute(String.raw`[\w.-]+:id`) || null,
    index,
  }));
  return rows.length ? rows : fallbackNames.map((name, index) => ({ name, state: "visible", relationId: null, index }));
}

// The worksheet parts named in xl/_rels/workbook.xml.rels, by relationship
// id, resolved the way read-excel-file resolves them.
const WORKSHEET_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
function worksheetParts(xml) {
  const targets = new Map();
  for (const attribute of xmlTags(xml, "Relationship")) {
    const target = attribute("Target");
    if (attribute("Type") !== WORKSHEET_RELATIONSHIP || !attribute("Id") || !target) continue;
    targets.set(attribute("Id"), target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return targets;
}

function inspectSelectedSheetXml(xml, sheetName) {
  const warnings = [];
  // A formula cell must carry its cached result (<v>).
  let cell = null;
  const finishCell = () => {
    if (cell?.formula) {
      if (!cell.value) parserFailure("INTAKE_XLSX_FORMULA_RESULT_UNAVAILABLE", "Formula cell has no trusted cached result.", 422, { sheetName, cell: cell.reference });
      warnings.push({ code: "INTAKE_XLSX_FORMULA_PRESENT", locator: { sheetName, cell: cell.reference } });
    }
    cell = null;
  };
  for (const tag of xmlTagStream(xml)) {
    if (tag.name === "mergeCell" && !tag.closing) parserFailure("INTAKE_XLSX_MERGED_CELL_UNSUPPORTED", "Merged cells in the header or data region are not supported.", 422);
    if (tag.name === "c") {
      finishCell();
      if (!tag.closing && !tag.selfClosing) cell = { reference: attributeValues(tag.body, "r")[0] || null, formula: false, value: false };
    } else if (cell && !tag.closing && tag.name === "f") cell.formula = true;
    else if (cell && !tag.closing && !tag.selfClosing && tag.name === "v") cell.value = true;
  }
  finishCell();
  return warnings;
}

function normalizedWorkbookValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return "";
  return value;
}

// The rows and columns of the grid read-excel-file builds for a sheet's XML:
// as large as its declared used range or its furthest cell. Cell references
// are read the way it reads them (parseCellAddress), so a reference it
// would size the grid by is never skipped here.
const COLUMN_LETTERS = ["", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
function sheetExtent(xml) {
  let rows = 0;
  let columns = 0;
  const reach = reference => {
    const [letters = "", digits] = String(reference).split(/(\d+)/);
    rows = Math.max(rows, Number(digits));
    columns = Math.max(columns, [...letters.trim()].reduce((total, letter) => total * 26 + COLUMN_LETTERS.indexOf(letter), 0));
  };
  // An empty or missing reference is not read: the grid then comes from the
  // cells, or the sheet fails to parse.
  for (const tag of xmlTagStream(xml)) {
    if (tag.closing) continue;
    if (tag.name === "dimension") {
      for (const reference of attributeValues(tag.body, "ref")) if (reference) reference.split(":").forEach(reach);
    } else if (tag.name === "c") {
      for (const reference of attributeValues(tag.body, "r")) if (reference) reach(reference);
    }
  }
  return { rows, columns };
}

// Refuses the workbook when any part given to the reader could make it
// build a grid larger than the limit. Every part is checked, not only the
// chosen sheet's, so a part the reader takes for a sheet is never missed.
function assertSheetGrids(parts) {
  for (const data of parts.values()) {
    const extent = sheetExtent(data.toString("utf8"));
    if (!(extent.rows * Math.max(extent.columns, 1) <= STRUCTURED_LIMITS.maximumSheetCells)) parserFailure("INTAKE_XLSX_ZIP_BOMB", "Workbook archive exceeds safe ZIP limits.", 413);
  }
}

// Options for callers with tighter limits than Universal Intake:
//   maximumUncompressedBytes  caps the unpacked workbook
//   readSelectedSheetOnly     parses the chosen sheet alone, after checking
//                             how far its cells reach
//   maximumRecordCount        the most data rows taken
//   dropEmptyColumns          leaves out columns with no header and no values
export async function parseXlsxArtifact(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.byteLength > INTAKE_LIMITS.maximumArtifactSizeBytes) parserFailure("INTAKE_ARTIFACT_SIZE_LIMIT", "Artifact exceeds 10 MB.", 413);
  let archive;
  try { archive = await inspectZip(buffer, { maximumUncompressedBytes: options.maximumUncompressedBytes }); } catch (error) {
    if (error?.code === "INTAKE_XLSX_ZIP_BOMB") parserFailure("INTAKE_XLSX_ZIP_BOMB", "Workbook archive exceeds safe ZIP limits.", 413);
    parserFailure("INTAKE_XLSX_CORRUPT", "Workbook archive is corrupt or unsupported.", 422);
  }
  const maximumRecordCount = options.maximumRecordCount || INTAKE_LIMITS.maximumRecordCount;
  const partText = name => archive.parts.get(name)?.toString("utf8") || "";
  // The reader is given a copy of the parts inspectZip unpacked, never the
  // upload itself.
  let workbook = null;
  if (!options.readSelectedSheetOnly) {
    assertSheetGrids(archive.parts);
    try { workbook = await readExcelFile(repackParts(archive.parts), { parseNumber: value => value }); }
    catch { parserFailure("INTAKE_XLSX_CORRUPT", "Workbook could not be parsed.", 422); }
    if (workbook.length > STRUCTURED_LIMITS.maximumSheetCount) parserFailure("INTAKE_XLSX_SHEET_LIMIT", "Workbook contains too many sheets.", 413);
  }
  const metadata = workbookSheets(partText("xl/workbook.xml"), workbook ? workbook.map(sheet => sheet.sheet) : []);
  if (!workbook) {
    if (!metadata.length) parserFailure("INTAKE_XLSX_CORRUPT", "Workbook could not be parsed.", 422);
    if (metadata.length > STRUCTURED_LIMITS.maximumSheetCount) parserFailure("INTAKE_XLSX_SHEET_LIMIT", "Workbook contains too many sheets.", 413);
  }
  const sheetList = metadata.map(sheet => ({ name: sheet.name, state: sheet.state }));
  const visible = sheetList.filter(sheet => sheet.state === "visible");
  const selectedSheet = String(options.sheetName || (visible.length === 1 ? visible[0].name : "")).trim();
  if (!selectedSheet) parserFailure("INTAKE_XLSX_SHEET_REQUIRED", "Select one visible workbook sheet.", 422, { sheetList });
  const selectedMetadata = sheetList.find(sheet => sheet.name === selectedSheet);
  if (!selectedMetadata) parserFailure("INTAKE_XLSX_SHEET_REQUIRED", "Selected sheet does not exist.", 422);
  if (selectedMetadata.state !== "visible") parserFailure("INTAKE_XLSX_HIDDEN_SHEET", "Hidden and veryHidden sheets cannot be selected automatically.", 422);
  const selectedEntry = metadata.find(sheet => sheet.name === selectedSheet);
  const sheetIndex = selectedEntry?.index ?? 0;
  // The chosen sheet's part, found through the workbook's relationships as
  // the reader finds it, whatever its name.
  const sheetParts = worksheetParts(partText("xl/_rels/workbook.xml.rels"));
  const selectedPart = sheetParts.get(selectedEntry?.relationId);
  if (!selectedPart || !archive.parts.has(selectedPart)) parserFailure("INTAKE_XLSX_CORRUPT", "Workbook could not be parsed.", 422);
  const sheetXml = partText(selectedPart);
  const headerRowIndex = Number.isInteger(options.headerRowNumber) && options.headerRowNumber > 0 ? options.headerRowNumber - 1 : 0;
  let data;
  if (workbook) data = (workbook.find(value => value.sheet === selectedSheet) || workbook[sheetIndex])?.data;
  else {
    // The other sheets' parts are left out, so a huge grid elsewhere in the
    // workbook does not stop this sheet; what is left must fit the grid
    // limit before it is parsed. The row limit is checked on the rows that
    // hold values.
    const otherSheets = new Set([...sheetParts.values()].filter(name => name !== selectedPart));
    const parts = new Map([...archive.parts].filter(([name]) => !otherSheets.has(name)));
    assertSheetGrids(parts);
    try { data = await readSheet(repackParts(parts), selectedSheet, { parseNumber: value => value }); }
    catch { parserFailure("INTAKE_XLSX_CORRUPT", "Workbook could not be parsed.", 422); }
  }
  if (!data?.length) parserFailure("INTAKE_HEADER_MISSING", "Selected sheet is empty.", 422);
  const warnings = inspectSelectedSheetXml(sheetXml, selectedSheet);
  const matrix = data.map(row => row.map(normalizedWorkbookValue));
  if (!options.readSelectedSheetOnly && matrix.length - 1 > INTAKE_LIMITS.maximumRecordCount) parserFailure("INTAKE_RECORD_COUNT_LIMIT", "Record count exceeds 5,000.", 413);
  if (Math.max(...matrix.map(row => row.length), 0) > INTAKE_LIMITS.maximumFieldCount) parserFailure("INTAKE_COLUMN_LIMIT", "Column count exceeds 200.", 413);
  const profile = matrixProfile(matrix, { sourceFormat: "xlsx", sheetName: selectedSheet, headerRowNumber: headerRowIndex + 1, dropEmptyColumns: options.dropEmptyColumns, maximumRecordCount });
  profile.records = profile.records.map(record => ({
    ...record,
    sourceLocator: { ...record.sourceLocator, headerRowNumber: headerRowIndex + 1 },
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
