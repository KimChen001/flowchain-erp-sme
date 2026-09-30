import { MAIL_REQUEST_TIMEOUT_MS, MailDeliveryError, readJsonResponse } from "./mail-errors.mjs";

const POSTMARK_EMAIL_URL = "https://api.postmarkapp.com/email";

// Postmark transactional email: https://postmarkapp.com/developer/api/email-api
export function createPostmarkMailer({ serverToken, from, fetch = globalThis.fetch }) {
  return {
    provider: "postmark",
    async send({ to, subject, text, html, tag }) {
      let response;
      try {
        response = await fetch(POSTMARK_EMAIL_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": serverToken,
          },
          body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, Tag: tag, MessageStream: "outbound" }),
          signal: AbortSignal.timeout(MAIL_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new MailDeliveryError("postmark", { message: error?.name === "TimeoutError" ? "Request timed out." : "Request failed." });
      }
      const body = await readJsonResponse(response);
      // Postmark reports some rejections as 200 with a non-zero ErrorCode.
      if (!response.ok || Number(body.ErrorCode || 0) !== 0) {
        throw new MailDeliveryError("postmark", { status: response.status, providerCode: body.ErrorCode ?? null, message: String(body.Message || "Rejected.") });
      }
      return { provider: "postmark", messageId: String(body.MessageID || "") };
    },
  };
}
