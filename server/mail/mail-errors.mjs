// Delivery errors carry the provider's status and error code, never the
// request headers, so a logged error cannot leak an API key.
export class MailDeliveryError extends Error {
  constructor(provider, { status = null, providerCode = null, message = "Mail delivery failed." } = {}) {
    super(`${provider}: ${message}`);
    this.name = "MailDeliveryError";
    this.code = "MAIL_DELIVERY_FAILED";
    this.provider = provider;
    this.status = status;
    this.providerCode = providerCode === null || providerCode === undefined ? null : String(providerCode);
  }
}

export class MailConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MailConfigError";
    this.code = code;
  }
}

export const MAIL_REQUEST_TIMEOUT_MS = 10_000;

export async function readJsonResponse(response) {
  const raw = await response.text().catch(() => "");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
