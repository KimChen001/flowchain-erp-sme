import test from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_DOCUMENT_TYPES, APPROVAL_WAITING_TAG, buildApprovalWaitingEmail } from "../mail/approval-waiting-email.mjs";
import { publicBaseUrl } from "../mail/public-base-url.mjs";
import { signInLinkBaseUrl } from "../auth/email-link-sign-in.mjs";

const link = "https://flowchain.example/app/procurement/orders/PO-1001";
const cjk = /[㐀-鿿]/;

const expected = {
  "en-US": {
    purchase_request: "Purchase request PR-7 is waiting for approval",
    purchase_order: "Purchase order PR-7 is waiting for approval",
    supplier_invoice: "Supplier bill PR-7 is waiting for approval",
    inventory_adjustment: "Inventory adjustment PR-7 is waiting for approval",
  },
  "zh-CN": {
    purchase_request: "采购申请 PR-7 等待审批",
    purchase_order: "采购订单 PR-7 等待审批",
    supplier_invoice: "采购发票 PR-7 等待审批",
    inventory_adjustment: "库存调整 PR-7 等待审批",
  },
};

test("each document type has an English and a Chinese subject and body that name only its type and number", () => {
  assert.equal(APPROVAL_WAITING_TAG, "approval-waiting");
  for (const language of ["en-US", "zh-CN"]) {
    for (const documentType of APPROVAL_DOCUMENT_TYPES) {
      const email = buildApprovalWaitingEmail({ language, documentType, documentNumber: "PR-7", link });
      assert.equal(email.subject, expected[language][documentType]);
      assert.ok(email.text.includes(link));
      assert.equal(email.html.split(`href="${link}"`).length - 1, 2, "a button and the plain link");
      assert.match(email.html, new RegExp(`<html lang="${language}">`));
      if (language === "en-US") {
        assert.match(email.text, /is waiting for approval in FlowChain\./);
        assert.match(email.text, /Nothing has been approved or rejected/);
        assert.match(email.text, /turn them off in System Administration › My Profile/);
        for (const body of [email.subject, email.text, email.html]) assert.doesNotMatch(body, cjk);
      } else {
        assert.match(email.text, /正在等待审批/);
        assert.match(email.text, /此邮件不会批准或驳回任何单据/);
        assert.match(email.text, /系统管理 › 我的资料/);
      }
    }
  }
});

test("the email offers no decision: one link, to the document, and no approve or reject action", () => {
  const email = buildApprovalWaitingEmail({ language: "en-US", documentType: "purchase_order", documentNumber: "PO-1001", link });
  const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(hrefs)], [link]);
  assert.deepEqual(email.text.match(/https?:\/\/\S+/g), [link]);
  assert.doesNotMatch(email.html, /<form|<button|approve\?|reject\?|decision=/i);
});

test("extra business fields passed in never reach the email", () => {
  const email = buildApprovalWaitingEmail({
    language: "en-US",
    documentType: "supplier_invoice",
    documentNumber: "INV-55",
    link,
    amount: "98765.43",
    currency: "USD",
    supplierName: "Globex Packaging",
    customerName: "Initech",
    itemName: "Pallet Wrap",
    requesterName: "Blake Buyer",
  });
  const all = `${email.subject}\n${email.text}\n${email.html}`;
  for (const value of ["98765", "USD", "Globex", "Initech", "Pallet Wrap", "Blake"]) assert.equal(all.includes(value), false, value);
});

test("document numbers are escaped in HTML, kept on one line, and an unknown language falls back to English", () => {
  const email = buildApprovalWaitingEmail({ language: "fr-FR", documentType: "inventory_adjustment", documentNumber: `ADJ <script>"x"</script>\r\nBcc: a@b.c`, link });
  assert.equal(email.subject, `Inventory adjustment ADJ <script>"x"</script> Bcc: a@b.c is waiting for approval`);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /ADJ &lt;script&gt;&quot;x&quot;&lt;\/script&gt; Bcc: a@b\.c/);
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.throws(() => buildApprovalWaitingEmail({ language: "en-US", documentType: "sales_order", documentNumber: "SO-1", link }), /Unsupported approval document type/);
});

test("email links use FLOWCHAIN_PUBLIC_BASE_URL, are empty in production without it, and fall back to loopback locally", () => {
  assert.equal(signInLinkBaseUrl, publicBaseUrl, "sign-in links use the same origin");
  assert.equal(publicBaseUrl({ FLOWCHAIN_PUBLIC_BASE_URL: "https://app.example.com/" }, null), "https://app.example.com");
  assert.equal(publicBaseUrl({ NODE_ENV: "production" }, { headers: { host: "localhost:3000" } }), "");
  assert.equal(publicBaseUrl({}, { headers: { host: "127.0.0.1:18789" } }), "http://127.0.0.1:18789");
  assert.equal(publicBaseUrl({}, { headers: { host: "evil.example" } }), "http://localhost");
});
