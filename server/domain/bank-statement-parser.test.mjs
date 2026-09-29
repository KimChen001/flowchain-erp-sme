import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as XLSX from "xlsx";
import { bankAmountString, bankAmountUnits, canonicalBankStatementFingerprint, parseBankStatement } from "./bank-statement-parser.mjs";

const fixture = (name) => new URL(`../../tests/fixtures/bank-statements/${name}`, import.meta.url);
const common = {
  formatType: "csv", fileEncoding: "utf8", headerRowNumber: 1, firstDataRowNumber: 2,
  dateFormat: "YYYY-MM-DD", decimalSeparator: ".", thousandsSeparator: ",", timezone: "Asia/Shanghai",
  debitCreditMode: "signed_amount", signConvention: "positive_credit",
  columnMapping: { transactionId: "transaction_id", transactionDate: "transaction_date", signedAmount: "signed_amount", currency: "currency", counterpartyName: "counterparty_name", counterpartyAccount: "counterparty_account", description: "description", bankReference: "bank_reference" },
};

test("authoritative bank amount math uses four-decimal scaled bigint", () => {
  assert.equal(bankAmountUnits("123456789012.3456"), 1234567890123456n);
  assert.equal(bankAmountString(-12500n), "-1.2500");
  assert.throws(() => bankAmountUnits("0.00001"), { code: "BANK_STATEMENT_AMOUNT_INVALID" });
  assert.throws(() => bankAmountUnits(""), { code: "BANK_STATEMENT_AMOUNT_EMPTY" });
});

test("UTF-8 separate debit and credit columns normalize positive amount plus direction", async () => {
  const result = parseBankStatement({ bytes: await readFile(fixture("utf8-separate-debit-credit.csv")), fileName: "statement.csv", mimeType: "text/csv", mapping: { ...common, debitCreditMode: "separate_columns", columnMapping: { transactionId: "交易编号", transactionDate: "交易日期", debitAmount: "借方金额", creditAmount: "贷方金额", currency: "币种", counterpartyName: "对方名称", counterpartyAccount: "对方账号", description: "摘要", bankReference: "银行参考", runningBalance: "余额" } } });
  assert.equal(result.errorRowCount, 0); assert.equal(result.rows[0].normalizedDirection, "credit"); assert.equal(result.rows[0].normalizedAmount, "1250.5000");
  assert.equal(result.rows[1].normalizedDirection, "debit"); assert.equal(result.rows[1].normalizedCounterpartyAccountMasked, "****5678"); assert.equal(result.rows[1].rawData["对方账号"], "6222000000005678");
});

test("UTF-8 BOM and signed amounts are detected without floating point", async () => {
  const source = await readFile(fixture("utf8-bom-signed.csv"));
  const result = parseBankStatement({ bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]), fileName: "signed.csv", mimeType: "text/csv", mapping: { ...common, fileEncoding: "auto_detect" } });
  assert.equal(result.detectedEncoding, "utf8_bom"); assert.equal(result.rows[0].normalizedDirection, "credit"); assert.equal(result.rows[1].normalizedDirection, "debit"); assert.equal(result.rows[0].normalizedAmount, "88.1234");
});

test("GB18030 Chinese direction and account redaction normalize deterministically", () => {
  const bytes = Buffer.from("vbvS17HgusUsvbvS18jVxtost73P8iy98LbuLLHS1tYsttS3vcP7s8YsttS3vdXLusUs1arSqgpHQi0xMDAxLDIwMjYtMDctMDUsytXI6ywxMDAuMDAwMSxDTlks0Om5ub/Nu6ex+ywxMjM0NTY3ODkwMTIzNDU2LNDpubnW0M7EwffLrgo=", "base64");
  const result = parseBankStatement({ bytes, fileName: "gb.csv", mimeType: "text/csv", mapping: { ...common, fileEncoding: "gb18030", debitCreditMode: "direction_and_amount", signConvention: "explicit_direction", columnMapping: { transactionId: "交易编号", transactionDate: "交易日期", direction: "方向", signedAmount: "金额", currency: "币种", counterpartyName: "对方名称", counterpartyAccount: "对方账号", description: "摘要" } } });
  assert.equal(result.rows[0].normalizedDirection, "credit"); assert.equal(result.rows[0].normalizedAmount, "100.0001"); assert.match(result.rows[0].normalizedCounterpartyAccountHash, /^[a-f0-9]{64}$/);
});

test("invalid dates and five decimals remain visible error rows", async () => {
  const invalidDate = parseBankStatement({ bytes: await readFile(fixture("malformed-date.csv")), fileName: "bad.csv", mimeType: "text/csv", mapping: common });
  assert.equal(invalidDate.rows[0].validationStatus, "error"); assert.deepEqual(invalidDate.rows[0].issueCodes, ["BANK_STATEMENT_DATE_INVALID"]);
  const fiveDecimals = Buffer.from("transaction_id,transaction_date,signed_amount,currency\nBAD-AMOUNT,2026-07-01,1.00001,CNY\n");
  const invalidAmount = parseBankStatement({ bytes: fiveDecimals, fileName: "bad.csv", mimeType: "text/csv", mapping: common });
  assert.deepEqual(invalidAmount.rows[0].issueCodes, ["BANK_STATEMENT_AMOUNT_INVALID"]);
});

test("XLSX cached values and Excel dates parse while formulas fail closed", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["transaction_id", "transaction_date", "signed_amount", "currency"], ["XLSX-1", 46204, "45.6789", "CNY"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Statement");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const result = parseBankStatement({ bytes, fileName: "standard-bank-statement.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mapping: { ...common, formatType: "xlsx", sheetName: "Statement" } });
  assert.equal(result.rows[0].normalizedTransactionDate.toISOString().slice(0, 10), "2026-07-01"); assert.equal(result.rows[0].normalizedAmount, "45.6789");
  const formulaBook = XLSX.utils.book_new(); const formulaSheet = XLSX.utils.aoa_to_sheet([["transaction_id", "transaction_date", "signed_amount", "currency"], ["FORMULA-1", "2026-07-01", { t: "n", v: 10, f: "5+5" }, "CNY"]]); XLSX.utils.book_append_sheet(formulaBook, formulaSheet, "Statement");
  assert.throws(() => parseBankStatement({ bytes: XLSX.write(formulaBook, { type: "buffer", bookType: "xlsx" }), fileName: "formula-cells.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mapping: { ...common, formatType: "xlsx", sheetName: "Statement" } }), { code: "BANK_STATEMENT_FORMULA_FORBIDDEN" });
});

test("security limits, secret mapping fields, and canonical fingerprints are stable", async () => {
  const bytes = await readFile(fixture("oversized-row-count.csv"));
  assert.throws(() => parseBankStatement({ bytes, fileName: "oversized.csv", mimeType: "text/csv", mapping: common, limits: { maxRows: 2 } }), { code: "BANK_STATEMENT_ROW_LIMIT" });
  assert.throws(() => parseBankStatement({ bytes, fileName: "oversized.csv", mimeType: "text/csv", mapping: { ...common, metadata: { apiSecret: "forbidden" } } }), { code: "BANK_STATEMENT_SECRET_FIELD_FORBIDDEN" });
  const input = { cashbookAccountId: "BANK-1", currency: "CNY", direction: "credit", amount: "10.0000", transactionDate: "2026-07-01", valueDate: "2026-07-02", bankReference: " ref 1 ", counterpartyAccountHash: "hash", description: " invoice 1 " };
  assert.equal(canonicalBankStatementFingerprint(input), canonicalBankStatementFingerprint({ ...input, bankReference: "REF 1", description: "INVOICE 1" }));
});

test("auto-detect legacy fallback follows the tenant locale: zh-CN keeps GB18030, en-US reads Windows-1252", () => {
  const latin1 = Buffer.concat([Buffer.from("transaction_id,transaction_date,signed_amount,currency,description\nUS-1,2026-07-01,12.50,USD,Caf"), Buffer.from([0xe9]), Buffer.from("x deposit\n")]);
  const us = parseBankStatement({ bytes: latin1, fileName: "us.csv", mimeType: "text/csv", mapping: { ...common, fileEncoding: "auto_detect" }, tenantLocale: "en-US" });
  assert.equal(us.detectedEncoding, "windows_1252"); assert.equal(us.rows[0].normalizedDescription, "Caféx deposit");
  const gbBytes = Buffer.from("vbvS17HgusUsvbvS18jVxtost73P8iy98LbuLLHS1tYsttS3vcP7s8YsttS3vdXLusUs1arSqgpHQi0xMDAxLDIwMjYtMDctMDUsytXI6ywxMDAuMDAwMSxDTlks0Om5ub/Nu6ex+ywxMjM0NTY3ODkwMTIzNDU2LNDpubnW0M7EwffLrgo=", "base64");
  const gbMapping = { ...common, fileEncoding: "auto_detect", debitCreditMode: "direction_and_amount", signConvention: "explicit_direction", columnMapping: { transactionId: "交易编号", transactionDate: "交易日期", direction: "方向", signedAmount: "金额", currency: "币种", counterpartyName: "对方名称", counterpartyAccount: "对方账号", description: "摘要" } };
  const cn = parseBankStatement({ bytes: gbBytes, fileName: "gb.csv", mimeType: "text/csv", mapping: gbMapping, tenantLocale: "zh-CN" });
  assert.equal(cn.detectedEncoding, "gb18030"); assert.equal(cn.rows[0].normalizedDirection, "credit");
  // Without a tenant locale the historical GB18030 fallback is unchanged.
  assert.equal(parseBankStatement({ bytes: gbBytes, fileName: "gb.csv", mimeType: "text/csv", mapping: gbMapping }).detectedEncoding, "gb18030");
});

test("ambiguous NN/NN/YYYY dates follow the mapping format, then an en-US tenant locale", () => {
  const bytes = Buffer.from("transaction_id,transaction_date,signed_amount,currency\nD-1,03/04/2026,1.00,USD\n");
  const date = (mapping, tenantLocale) => parseBankStatement({ bytes, fileName: "d.csv", mimeType: "text/csv", mapping: { ...common, ...mapping }, tenantLocale }).rows[0].normalizedTransactionDate.toISOString().slice(0, 10);
  assert.equal(date({ dateFormat: "" }, "en-US"), "2026-03-04");
  assert.equal(date({ dateFormat: "" }, "zh-CN"), "2026-04-03");
  assert.equal(date({ dateFormat: "" }), "2026-04-03");
  assert.equal(date({ dateFormat: "DD/MM/YYYY" }, "en-US"), "2026-04-03");
  assert.equal(date({ dateFormat: "MM/DD/YYYY" }, "zh-CN"), "2026-03-04");
});
