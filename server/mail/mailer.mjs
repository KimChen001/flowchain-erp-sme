import { MailConfigError } from "./mail-errors.mjs";
import { createOutboxMailer, defaultOutboxPath } from "./outbox-mailer.mjs";
import { createPostmarkMailer } from "./postmark-mailer.mjs";
import { createResendMailer } from "./resend-mailer.mjs";

// Every adapter has one method: send({ to, subject, text, html, tag }),
// resolving to { provider, messageId }. FLOWCHAIN_MAIL_PROVIDER picks it:
//   outbox   - local JSON file for development and tests (the default outside production)
//   postmark - Postmark HTTPS API, POSTMARK_SERVER_TOKEN and FLOWCHAIN_MAIL_FROM
//   resend   - Resend HTTPS API, RESEND_API_KEY and FLOWCHAIN_MAIL_FROM
export const MAIL_PROVIDERS = Object.freeze(["outbox", "postmark", "resend"]);

const text = (value) => String(value ?? "").trim();
const isProduction = (env) => text(env.NODE_ENV).toLowerCase() === "production" || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";

export function mailProviderName(env = process.env) {
  const configured = text(env.FLOWCHAIN_MAIL_PROVIDER).toLowerCase();
  if (configured) return configured;
  return isProduction(env) ? "" : "outbox";
}

const required = (value, key) => {
  if (!text(value)) throw new MailConfigError("MAIL_PROVIDER_CONFIG_REQUIRED", `${key} is required for the configured mail provider.`);
  return text(value);
};

export function createMailer(env = process.env, { fetch = globalThis.fetch } = {}) {
  const provider = mailProviderName(env);
  if (!provider) throw new MailConfigError("MAIL_PROVIDER_CONFIG_REQUIRED", "FLOWCHAIN_MAIL_PROVIDER is required in production.");
  if (!MAIL_PROVIDERS.includes(provider)) throw new MailConfigError("MAIL_PROVIDER_UNSUPPORTED", `Unsupported FLOWCHAIN_MAIL_PROVIDER. Use ${MAIL_PROVIDERS.join(", ")}.`);
  if (provider === "outbox") {
    if (isProduction(env)) throw new MailConfigError("MAIL_OUTBOX_FORBIDDEN", "The local mail outbox cannot be used in production.");
    return createOutboxMailer({ path: defaultOutboxPath(env) });
  }
  const from = required(env.FLOWCHAIN_MAIL_FROM, "FLOWCHAIN_MAIL_FROM");
  if (provider === "postmark") return createPostmarkMailer({ serverToken: required(env.POSTMARK_SERVER_TOKEN, "POSTMARK_SERVER_TOKEN"), from, fetch });
  return createResendMailer({ apiKey: required(env.RESEND_API_KEY, "RESEND_API_KEY"), from, fetch });
}

// One provider per server for every kind of email, created on the first
// send: a provider that cannot be created fails that send, which the caller
// logs, and the local outbox file has a single writer.
export function createLazyMailer(env = process.env, options = {}) {
  let resolved = null;
  return {
    send(message) {
      resolved ||= createMailer(env, options);
      return resolved.send(message);
    },
  };
}
