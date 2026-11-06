import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  returnsCheckValueLabels,
  returnsChinese,
  returnsCodeLabels,
  returnsErrorLabels,
  returnsFieldLabels,
  returnsLinkLabels,
  returnsRuleLabels,
  returnsServerWordedCodes,
  salesReturnStatusLabels,
} from "../../src/modules/inventory/returnsCopyData.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const cjk = /[㐀-鿿！-～　-〿]/;

const uiFiles = [
  "src/modules/inventory/ReturnQuarantineWorkbench.tsx",
  "src/modules/sales/SalesReturnPage.tsx",
  "src/components/business/BusinessDocumentForm.tsx",
];

const serverFiles = [
  "server/routes/returns.routes.mjs",
  "server/domain/customer-return-command-service.mjs",
  "server/domain/customer-return-read-service.mjs",
  "server/domain/customer-return-transaction-policy.mjs",
  "server/domain/quarantine-disposition-lineage.mjs",
  "server/domain/quarantine-release-command-service.mjs",
  "server/domain/quarantine-release-read-service.mjs",
  "server/domain/quarantine-release-transaction-policy.mjs",
  "server/domain/return-governance-command-service.mjs",
  "server/domain/return-governance-policy.mjs",
  "server/domain/return-governance-read-service.mjs",
  "server/domain/supplier-return-command-service.mjs",
  "server/domain/supplier-return-read-service.mjs",
  "server/domain/supplier-return-transaction-policy.mjs",
];

// Uppercase tokens in these files that are not codes shown to users.
const notUserCodes = new Set(["TAMPER", "LINEAGE", "AGGREGATE"]);

const literals = (source, pattern) =>
  [...source.matchAll(pattern)].map((match) => JSON.parse(`"${match[1]}"`));

test("every returns UI string has a Chinese translation", async () => {
  const missing = [];
  for (const file of uiFiles) {
    const source = await read(file);
    const keys = [
      ...literals(source, /\bcopy\("((?:[^"\\]|\\.)*)"/g),
      ...literals(source, /\b(?:errorText|issueText)\([^()]*(?:\([^()]*\))?[^()]*?,\s*"((?:[^"\\]|\\.)*)"\)/g),
      ...literals(source, /\bfallback: "((?:[^"\\]|\\.)*)"/g),
      ...literals(source, /\bfailedPreview\([^,]+,\s*[^,]+,\s*"((?:[^"\\]|\\.)*)"/g),
    ];
    assert.ok(keys.length > 0, `${file} has no copy() strings`);
    for (const key of keys) if (!returnsChinese[key]) missing.push(`${file}: ${key}`);
  }
  // The sales return form is opened with an English document label.
  const salesPage = await read("src/modules/sales/Page.tsx");
  const label = /BusinessDocumentForm documentLabel="([^"]+)"/.exec(salesPage)?.[1];
  assert.ok(label && returnsChinese[label], "sales return form label has no Chinese entry");
  assert.deepEqual(missing, []);
});

test("English copy keys are English and Chinese values are filled in", () => {
  for (const [english, chinese] of Object.entries(returnsChinese)) {
    assert.ok(english.trim() && !cjk.test(english), `English key has Chinese text: ${english}`);
    assert.ok(chinese.trim(), `empty Chinese value for: ${english}`);
    for (const name of english.match(/\{[a-z]+\}/gi) || [])
      assert.ok(chinese.includes(name), `Chinese value for "${english}" drops ${name}`);
  }
});

test("every code label has both languages", () => {
  const tables = {
    returnsCodeLabels,
    returnsRuleLabels,
    returnsErrorLabels,
    returnsLinkLabels,
    salesReturnStatusLabels,
    returnsCheckValueLabels,
    returnsFieldLabels,
  };
  for (const [table, entries] of Object.entries(tables))
    for (const [code, pair] of Object.entries(entries)) {
      assert.equal(pair.length, 2, `${table}.${code}`);
      const [english, chinese] = pair;
      assert.ok(english.trim() && !cjk.test(english), `${table}.${code} English is missing or has Chinese text`);
      assert.ok(chinese.trim(), `${table}.${code} Chinese is missing`);
    }
});

test("every code the returns API sends has an error label", async () => {
  const codes = new Set();
  for (const file of serverFiles) {
    const source = await read(file);
    for (const match of source.matchAll(/["']([A-Z][A-Z0-9_]{5,})["']/g))
      if (!notUserCodes.has(match[1])) codes.add(match[1]);
  }
  assert.ok(codes.size > 50, `only ${codes.size} codes found; check the extraction`);
  // The route also passes through role-check and workspace-identity errors.
  const authorization = await read("server/auth/authorization-service.mjs");
  const reasons = /AUTHORIZATION_REASON = Object\.freeze\(\{([^}]*)\}/.exec(authorization)?.[1] || "";
  const identity = await read("server/domain/pilot-identity.mjs");
  const passedThrough = [
    ...[...reasons.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]),
    ...[...identity.matchAll(/fail\('([A-Z_]+)'/g)].map((match) => match[1]),
  ];
  assert.ok(passedThrough.length >= 10, `only ${passedThrough.length} role and identity codes found`);
  for (const code of passedThrough) codes.add(code);
  const missing = [...codes].filter((code) => !returnsErrorLabels[code]).sort();
  assert.deepEqual(missing, []);
});

test("codes shown with the server's English message have a label that fits every cause", () => {
  for (const code of returnsServerWordedCodes) assert.ok(returnsErrorLabels[code], code);
  // The server sends this code for "must be positive" and for "at most four decimal places".
  assert.match(returnsErrorLabels.RETURN_QUANTITY_INVALID[0], /positive.*four decimal places/);
  assert.match(returnsErrorLabels.RETURN_QUANTITY_INVALID[1], /大于零.*四位小数/);
});

test("returns screens have no Chinese text outside copy()", async () => {
  for (const file of uiFiles) {
    const lines = (await read(file)).split(/\r?\n/);
    const offending = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => cjk.test(line) && !/\bcopy\(/.test(line));
    assert.deepEqual(offending, [], file);
  }
});

test("Chinese labels the returns browser spec relies on stay unchanged", () => {
  const pinned = {
    "Allowed": "允许执行",
    "Return type": "退货类型",
    "Request number": "申请单号",
    "Source document": "来源单据",
    "Select source line {sku}": "选择来源行 {sku}",
    "Requested quantity {sku}": "申请数量 {sku}",
    "Reason details": "原因说明",
    "Authorization number": "授权单号",
    "Authorized quantity {sku}": "授权数量 {sku}",
    "Disposition route {sku}": "处置路径 {sku}",
    "Posting number": "执行单号",
    "Posting quantity {sku}": "执行数量 {sku}",
    "Quarantine balance {sku}": "隔离库存余额 {sku}",
    "Available balance {sku}": "可用库存余额 {sku}",
    "Destination available balance {sku}": "目标可用库存余额 {sku}",
    "Reversal reason": "冲销原因",
    "Preview: mark ready to post": "预览就绪",
    "Return requests": "退货申请",
    "Quarantined inventory": "隔离库存",
    "Quarantine release authorization": "隔离库存释放授权",
    "No": "否",
  };
  for (const [english, chinese] of Object.entries(pinned)) assert.equal(returnsChinese[english], chinese, english);
  assert.equal(returnsCodeLabels.reversed[1], "已冲销");
  assert.equal(returnsCodeLabels.matched[1], "已匹配");
  assert.equal(returnsLinkLabels["quarantine-inventory"][1], "隔离库存");
});
