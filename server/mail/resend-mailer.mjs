import { MAIL_REQUEST_TIMEOUT_MS, MailDeliveryError, readJsonResponse } from "./mail-errors.mjs";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// Resend transactional email: https://resend.com/docs/api-reference/emails/send-email
export function createResendMailer({ apiKey, from, fetch = globalThis.fetch }) {
  return {
    provider: "resend",
    async send({ to, subject, text, html, tag }) {
      let response;
      try {
        response = await fetch(RESEND_EMAILS_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ from, to: [to], subject, text, html, ...(tag ? { tags: [{ name: "category", value: tag }] } : {}) }),
          signal: AbortSignal.timeout(MAIL_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new MailDeliveryError("resend", { message: error?.name === "TimeoutError" ? "Request timed out." : "Request failed." });
      }
      const body = await readJsonResponse(response);
      if (!response.ok || !body.id) {
        throw new MailDeliveryError("resend", { status: response.status, providerCode: body.name ?? null, message: String(body.message || "Rejected.") });
      }
      return { provider: "resend", messageId: String(body.id) };
    },
  };
}
