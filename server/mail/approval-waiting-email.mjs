import { escapeHtml } from "./sign-in-email.mjs";

// The email that tells an approver a document is waiting. It names only the
// document type and number and links to the document page: no amounts,
// suppliers, customers, items or people, and no action. Approving or
// rejecting happens in FlowChain, by a person. US English unless the
// recipient's language is zh-CN.
export const APPROVAL_WAITING_TAG = "approval-waiting";
export const APPROVAL_DOCUMENT_TYPES = Object.freeze(["purchase_request", "purchase_order", "supplier_invoice", "inventory_adjustment"]);

const COPY = {
  "en-US": {
    type: {
      purchase_request: "Purchase request",
      purchase_order: "Purchase order",
      supplier_invoice: "Supplier bill",
      inventory_adjustment: "Inventory adjustment",
    },
    subject: (type, number) => `${type} ${number} is waiting for approval`,
    intro: (type, number) => `${type} ${number} is waiting for approval in FlowChain.`,
    button: "Open in FlowChain",
    fallback: "Or copy and paste this link into your browser:",
    decide: "Nothing has been approved or rejected. Open the document in FlowChain to review it and decide.",
    optOut: "To stop these emails, turn them off in System Administration › My Profile.",
    signature: "FlowChain",
  },
  "zh-CN": {
    type: {
      purchase_request: "采购申请",
      purchase_order: "采购订单",
      supplier_invoice: "采购发票",
      inventory_adjustment: "库存调整",
    },
    subject: (type, number) => `${type} ${number} 等待审批`,
    intro: (type, number) => `FlowChain 中的${type} ${number} 正在等待审批。`,
    button: "在 FlowChain 中打开",
    fallback: "也可以将此链接复制到浏览器中打开：",
    decide: "此邮件不会批准或驳回任何单据。请在 FlowChain 中打开单据审阅并决定。",
    optOut: "如不想再收到此类邮件，可在 系统管理 › 我的资料 中关闭。",
    signature: "FlowChain",
  },
};

// A document number is recorded data shown as is, on one line.
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function buildApprovalWaitingEmail({ language, documentType, documentNumber, link }) {
  if (!APPROVAL_DOCUMENT_TYPES.includes(documentType)) throw new Error(`Unsupported approval document type: ${documentType}`);
  const lang = language === "zh-CN" ? "zh-CN" : "en-US";
  const copy = COPY[lang];
  const type = copy.type[documentType];
  const number = oneLine(documentNumber);
  const subject = copy.subject(type, number);
  const intro = copy.intro(type, number);

  const text = [
    intro,
    "",
    link,
    "",
    copy.decide,
    "",
    copy.optOut,
    "",
    `— ${copy.signature}`,
  ].join("\n");

  const href = escapeHtml(link);
  const html = `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;">
<tr><td style="padding:32px;">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${escapeHtml(subject)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:22px;">${escapeHtml(intro)}</p>
<p style="margin:0 0 24px;"><a href="${href}" style="display:inline-block;padding:12px 20px;background:#0071e3;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(copy.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(copy.fallback)}</p>
<p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;"><a href="${href}" style="color:#0071e3;">${href}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(copy.decide)}</p>
<p style="margin:0;font-size:13px;line-height:20px;color:#6e6e73;">${escapeHtml(copy.optOut)}</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
