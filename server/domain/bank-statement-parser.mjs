import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

export class BankStatementParserError extends Error {
  constructor(code, message, status = 422, details) {
    super(message);
    this.name = "BankStatementParserError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value) => String(value ?? "").trim();
const fail = (code, message, details) => { throw new BankStatementParserError(code, message, 422, details); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DEFAULT_LIMITS = Object.freeze({ maxFileBytes: 20 * 1024 * 1024, maxRows: 10_000, maxSheets: 3 });
const FORMATS = new Set(["csv", "xlsx"]);
const ENCODINGS = new Set(["utf8", "utf8_bom", "gb18030", "auto_detect"]);
const MODES = new Set(["separate_columns", "signed_amount", "direction_and_amount"]);
const SIGNS = new Set(["positive_credit", "positive_debit", "explicit_direction"]);
const ACCOUNT_KEYS = /(password|secret|token|certificate|private.?key|api.?key|credential|(^|[_-])pin($|[_-]))/i;

export function bankAmountUnits(value, options = {}) {
  const decimalSeparator = text(options.decimalSeparator || ".");
  const thousandsSeparator = text(options.thousandsSeparator ?? ",");
  let raw = text(value).replace(/\s/g, "");
  if (!raw) fail("BANK_STATEMENT_AMOUNT_EMPTY", "Amount is required.");
  if (thousandsSeparator) raw = raw.split(thousandsSeparator).join("");
  if (decimalSeparator !== ".") raw = raw.replace(decimalSeparator, ".");
  if (!/^[+-]?\d+(?:\.\d{1,4})?$/.test(raw)) fail("BANK_STATEMENT_AMOUNT_INVALID", "Amount must use at most four decimal places.", { value: text(value) });
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}

export function bankAmountString(units) {
  const amount = BigInt(units);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}

function parseCsvMatrix(source, delimiter) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (char === '"') {
      if (quoted && next === '"') { cell += '"'; index += 1; } else quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) { row.push(cell); cell = ""; continue; }
    if ((char === "\n" || char === "\r") && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = "";
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }
    cell += char;
  }
  if (quoted) fail("BANK_STATEMENT_CSV_MALFORMED", "CSV contains an unterminated quoted field.");
  row.push(cell); rows.push(row);
  return rows.filter((cells) => cells.some((cellValue) => text(cellValue)));
}

// Auto-detect falls back to a single-byte legacy encoding when the bytes are not UTF-8.
// Chinese-locale tenants keep GB18030; a known non-Chinese tenant locale uses Windows-1252
// (US bank and Excel CSV exports). Without a tenant locale the historical GB18030 fallback stays.
function legacyFallbackEncoding(tenantLocale) {
  const locale = text(tenantLocale);
  return !locale || /^zh(?:-|$)/i.test(locale) ? "gb18030" : "windows-1252";
}

function decodeCsv(bytes, requested, tenantLocale) {
  if (!ENCODINGS.has(requested)) fail("BANK_STATEMENT_ENCODING_UNSUPPORTED", "CSV encoding is not supported.");
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const decode = (encoding, source = bytes) => new TextDecoder(encoding, { fatal: true }).decode(source);
  try {
    if (requested === "gb18030") return { encoding: "gb18030", source: decode("gb18030") };
    if (requested === "utf8_bom") {
      if (!bom) fail("BANK_STATEMENT_ENCODING_MISMATCH", "UTF-8 BOM was selected but no BOM is present.");
      return { encoding: "utf8_bom", source: decode("utf-8", bytes.subarray(3)) };
    }
    if (requested === "utf8") return { encoding: bom ? "utf8_bom" : "utf8", source: decode("utf-8", bom ? bytes.subarray(3) : bytes) };
    if (bom) return { encoding: "utf8_bom", source: decode("utf-8", bytes.subarray(3)) };
    try { return { encoding: "utf8", source: decode("utf-8") }; }
    catch {
      const fallback = legacyFallbackEncoding(tenantLocale);
      return { encoding: fallback === "gb18030" ? "gb18030" : "windows_1252", source: decode(fallback) };
    }
  } catch (error) {
    if (error instanceof BankStatementParserError) throw error;
    fail("BANK_STATEMENT_ENCODING_INVALID", "The CSV bytes cannot be decoded with the selected encoding.");
  }
}

function parseDate(value, mapping) {
  const raw = text(value);
  if (!raw) return null;
  let year, month, day;
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (match) [, year, month, day] = match;
  if (!match && /^\d{5}(?:\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    const utc = new Date(Date.UTC(1899, 11, 30 + serial));
    year = String(utc.getUTCFullYear()); month = String(utc.getUTCMonth() + 1); day = String(utc.getUTCDate());
  }
  if (!match && !year) {
    match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (match) {
      const format = text(mapping.dateFormat).toUpperCase();
      // With no mapping date format, an en-US tenant reads NN/NN/YYYY as month/day/year.
      const order = format ? (format.startsWith("MM") ? "mdy" : "dmy") : /^en-US$/i.test(text(mapping.tenantLocale)) ? "mdy" : "dmy";
      year = match[3]; month = order === "mdy" ? match[1] : match[2]; day = order === "mdy" ? match[2] : match[1];
    }
  }
  if (!year) fail("BANK_STATEMENT_DATE_INVALID", "Date does not match the mapping format.", { value: raw });
  const iso = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) fail("BANK_STATEMENT_DATE_INVALID", "Date is not a valid calendar date.", { value: raw });
  return date;
}

function safeMapping(mapping) {
  const normalized = {
    ...mapping,
    formatType: text(mapping.formatType).toLowerCase(), fileEncoding: text(mapping.fileEncoding || "auto_detect").toLowerCase(),
    debitCreditMode: text(mapping.debitCreditMode).toLowerCase(), signConvention: text(mapping.signConvention).toLowerCase(),
    headerRowNumber: Number(mapping.headerRowNumber || 1), firstDataRowNumber: Number(mapping.firstDataRowNumber || 2),
    columnMapping: mapping.columnMapping || {}, timezone: text(mapping.timezone || "UTC"),
  };
  if (!FORMATS.has(normalized.formatType) || !ENCODINGS.has(normalized.fileEncoding) || !MODES.has(normalized.debitCreditMode) || !SIGNS.has(normalized.signConvention)) fail("BANK_STATEMENT_MAPPING_INVALID", "Mapping format, encoding, amount mode, or sign convention is invalid.");
  if (!Number.isInteger(normalized.headerRowNumber) || !Number.isInteger(normalized.firstDataRowNumber) || normalized.headerRowNumber < 1 || normalized.firstDataRowNumber <= normalized.headerRowNumber) fail("BANK_STATEMENT_MAPPING_INVALID", "Mapping row numbers are invalid.");
  const walk = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (ACCOUNT_KEYS.test(key) && child !== false && child != null && text(child)) fail("BANK_STATEMENT_SECRET_FIELD_FORBIDDEN", "Mapping metadata must not contain bank credentials.", { field: [...path, key].join(".") });
      walk(child, [...path, key]);
    }
  };
  walk(mapping);
  return normalized;
}

function rowObject(headers, cells) {
  return Object.fromEntries(headers.map((header, index) => [text(header), text(cells[index])]));
}

function mapped(raw, mapping, key) {
  const column = text(mapping.columnMapping[key]);
  return column ? raw[column] : "";
}

function normalizeAccount(value) {
  const original = text(value).replace(/\s+/g, "");
  if (!original) return { masked: null, digest: null };
  const last = original.slice(-4);
  return { masked: `****${last}`, digest: hash(original.toUpperCase()) };
}

function normalizeDirectionAmount(raw, mapping) {
  const options = { decimalSeparator: mapping.decimalSeparator, thousandsSeparator: mapping.thousandsSeparator };
  if (mapping.debitCreditMode === "separate_columns") {
    const debitRaw = mapped(raw, mapping, "debitAmount"), creditRaw = mapped(raw, mapping, "creditAmount");
    const debit = text(debitRaw) ? bankAmountUnits(debitRaw, options) : 0n;
    const credit = text(creditRaw) ? bankAmountUnits(creditRaw, options) : 0n;
    if ((debit > 0n) === (credit > 0n)) fail("BANK_STATEMENT_DIRECTION_AMOUNT_INVALID", "Exactly one debit or credit amount must be positive.");
    return debit > 0n ? { direction: "debit", amount: debit } : { direction: "credit", amount: credit };
  }
  if (mapping.debitCreditMode === "direction_and_amount") {
    const directionValue = text(mapped(raw, mapping, "direction")).toLowerCase();
    const aliases = { credit: "credit", cr: "credit", c: "credit", inflow: "credit", income: "credit", debit: "debit", dr: "debit", d: "debit", outflow: "debit", expense: "debit", "贷": "credit", "收入": "credit", "借": "debit", "支出": "debit" };
    const direction = aliases[directionValue];
    const amount = bankAmountUnits(mapped(raw, mapping, "signedAmount") || mapped(raw, mapping, "debitAmount") || mapped(raw, mapping, "creditAmount"), options);
    if (!direction || amount <= 0n) fail("BANK_STATEMENT_DIRECTION_AMOUNT_INVALID", "Direction and amount are invalid.");
    return { direction, amount };
  }
  const signed = bankAmountUnits(mapped(raw, mapping, "signedAmount"), options);
  if (signed === 0n) fail("BANK_STATEMENT_AMOUNT_ZERO", "Bank statement amount cannot be zero.");
  const positiveDirection = mapping.signConvention === "positive_debit" ? "debit" : "credit";
  const direction = signed > 0n ? positiveDirection : positiveDirection === "credit" ? "debit" : "credit";
  return { direction, amount: signed < 0n ? -signed : signed };
}

function normalizeRow(raw, mapping, sourceRowNumber, sourceSheet) {
  const issues = [];
  const account = normalizeAccount(mapped(raw, mapping, "counterpartyAccount"));
  const bankAccount = normalizeAccount(mapped(raw, mapping, "bankAccountIdentifier"));
  try {
    const { direction, amount } = normalizeDirectionAmount(raw, mapping);
    const transactionDate = parseDate(mapped(raw, mapping, "transactionDate"), mapping);
    if (!transactionDate) fail("BANK_STATEMENT_DATE_EMPTY", "Transaction date is required.");
    const currency = text(mapped(raw, mapping, "currency")).toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) fail("BANK_STATEMENT_CURRENCY_INVALID", "Currency must be a three-letter ISO code.");
    const runningRaw = mapped(raw, mapping, "runningBalance");
    const runningBalance = text(runningRaw) ? bankAmountString(bankAmountUnits(runningRaw, { decimalSeparator: mapping.decimalSeparator, thousandsSeparator: mapping.thousandsSeparator })) : null;
    return {
      sourceSheet, sourceRowNumber, rawData: raw, rawRowHash: hash(JSON.stringify(raw)), validationStatus: "valid", duplicateStatus: "none", issueCodes: issues,
      normalizedTransactionId: text(mapped(raw, mapping, "transactionId")) || null,
      normalizedTransactionDate: transactionDate,
      normalizedPostingDate: parseDate(mapped(raw, mapping, "postingDate"), mapping),
      normalizedValueDate: parseDate(mapped(raw, mapping, "valueDate"), mapping),
      normalizedDirection: direction, normalizedAmount: bankAmountString(amount), normalizedCurrency: currency || null,
      normalizedCounterpartyName: text(mapped(raw, mapping, "counterpartyName")) || null,
      normalizedCounterpartyAccountMasked: account.masked, normalizedCounterpartyAccountHash: account.digest,
      normalizedDescription: text(mapped(raw, mapping, "description")) || null,
      normalizedBankReference: text(mapped(raw, mapping, "bankReference")) || null,
      normalizedCustomerReference: text(mapped(raw, mapping, "customerReference")) || null,
      normalizedRunningBalance: runningBalance,
      bankAccountIdentifierMasked: bankAccount.masked, bankAccountIdentifierHash: bankAccount.digest,
    };
  } catch (error) {
    if (!(error instanceof BankStatementParserError)) throw error;
    return { sourceSheet, sourceRowNumber, rawData: raw, rawRowHash: hash(JSON.stringify(raw)), validationStatus: "error", duplicateStatus: "none", issueCodes: [error.code], issue: { code: error.code, column: error.details?.field || null, originalValue: error.details?.value ?? null, expectedFormat: error.message, suggestion: "Correct the source value or apply an audited row override." } };
  }
}

function xlsxMatrices(bytes, mapping, limits) {
  let workbook;
  try { workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellHTML: false, cellNF: false, sheetRows: limits.maxRows + mapping.firstDataRowNumber }); }
  catch { fail("BANK_STATEMENT_XLSX_INVALID", "XLSX workbook is malformed or unsafe."); }
  if (workbook.SheetNames.length > limits.maxSheets) fail("BANK_STATEMENT_SHEET_LIMIT", "Workbook exceeds the configured sheet limit.");
  const selected = mapping.sheetName ? [mapping.sheetName] : [workbook.SheetNames[0]];
  if (!selected[0] || !workbook.Sheets[selected[0]]) fail("BANK_STATEMENT_SHEET_NOT_FOUND", "The mapped worksheet does not exist.");
  return selected.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    for (const [address, cell] of Object.entries(sheet)) if (!address.startsWith("!") && cell?.f) fail("BANK_STATEMENT_FORMULA_FORBIDDEN", "Formula cells are not accepted as bank statement evidence.", { sheet: sheetName, cell: address });
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: false });
    return { sheetName, matrix };
  });
}

export function parseBankStatement({ bytes, fileName, mimeType, mapping: inputMapping, limits: inputLimits = {}, tenantLocale = "" }) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const mapping = { ...safeMapping(inputMapping || {}), tenantLocale: text(tenantLocale) };
  const limits = {
    maxFileBytes: Math.max(1, Number(inputLimits.maxFileBytes || DEFAULT_LIMITS.maxFileBytes)),
    maxRows: Math.max(1, Number(inputLimits.maxRows || DEFAULT_LIMITS.maxRows)),
    maxSheets: Math.max(1, Number(inputLimits.maxSheets || DEFAULT_LIMITS.maxSheets)),
  };
  if (!buffer.length || buffer.length > limits.maxFileBytes) fail("BANK_STATEMENT_FILE_SIZE_INVALID", "File is empty or exceeds the configured size limit.");
  const extension = text(fileName).toLowerCase().split(".").pop();
  if (extension !== mapping.formatType || !FORMATS.has(extension)) fail("BANK_STATEMENT_FILE_TYPE_MISMATCH", "File extension does not match the mapping format.");
  if (extension === "xlsx" && !/spreadsheetml|octet-stream/i.test(text(mimeType))) fail("BANK_STATEMENT_MIME_INVALID", "XLSX MIME type is invalid.");
  if (extension === "csv" && !/csv|text\/plain|octet-stream/i.test(text(mimeType))) fail("BANK_STATEMENT_MIME_INVALID", "CSV MIME type is invalid.");
  let matrices, detectedEncoding = null;
  if (extension === "csv") {
    const decoded = decodeCsv(buffer, mapping.fileEncoding, mapping.tenantLocale); detectedEncoding = decoded.encoding;
    const delimiter = text(mapping.delimiter || (decoded.source.includes("\t") && !decoded.source.includes(",") ? "\t" : ","));
    if (delimiter.length !== 1) fail("BANK_STATEMENT_DELIMITER_INVALID", "CSV delimiter must be one character.");
    matrices = [{ sheetName: null, matrix: parseCsvMatrix(decoded.source, delimiter) }];
  } else matrices = xlsxMatrices(buffer, mapping, limits);
  const rows = [];
  for (const { sheetName, matrix } of matrices) {
    const headers = matrix[mapping.headerRowNumber - 1] || [];
    for (let index = mapping.firstDataRowNumber - 1; index < matrix.length; index += 1) {
      if (rows.length >= limits.maxRows) fail("BANK_STATEMENT_ROW_LIMIT", "Statement exceeds the configured row limit.");
      const cells = matrix[index]; if (!cells?.some((value) => text(value))) continue;
      rows.push(normalizeRow(rowObject(headers, cells), mapping, index + 1, sheetName));
    }
  }
  if (!rows.length) fail("BANK_STATEMENT_NO_DATA_ROWS", "Statement contains no data rows.");
  return { fileName: text(fileName), fileMimeType: text(mimeType), fileSha256: hash(buffer), formatType: extension, detectedEncoding, rows, totalRowCount: rows.length, errorRowCount: rows.filter((row) => row.validationStatus === "error").length, limits };
}

export function canonicalBankStatementFingerprint({ cashbookAccountId, currency, direction, amount, transactionDate, valueDate, bankReference, counterpartyAccountHash, description }) {
  const normalize = (value) => text(value).toUpperCase().replace(/\s+/g, " ");
  return hash(JSON.stringify({ cashbookAccountId: text(cashbookAccountId), currency: normalize(currency), direction: text(direction), amount: bankAmountString(bankAmountUnits(amount)), transactionDate: new Date(transactionDate).toISOString().slice(0, 10), valueDate: valueDate ? new Date(valueDate).toISOString().slice(0, 10) : null, bankReference: normalize(bankReference), counterpartyAccountHash: text(counterpartyAccountHash), description: normalize(description) }));
}

export { DEFAULT_LIMITS as bankStatementParserDefaultLimits };
