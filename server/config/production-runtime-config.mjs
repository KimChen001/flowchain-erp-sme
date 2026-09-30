import { createLocalDurableAttachmentStorage } from "../domain/attachment-storage-provider.mjs";

export const PRODUCTION_CONFIG_ERROR = "FLOWCHAIN_PRODUCTION_CONFIG_INVALID";

const text = (value) => String(value ?? "").trim();
const enabled = (value) => text(value).toLowerCase() === "true";

function issue(key, code, message) {
  return { key, code, message };
}

// Values shipped in the example env files, or shaped like them, are not
// secrets. A signing secret anyone can read would let them forge sessions.
const PLACEHOLDER_SECRET_PATTERN = /^(replace[-_ ]?with|replace[-_ ]?me|change[-_ ]?me|your[-_ ]|placeholder|example[-_ ])/i;

function validateIdentityConfiguration(env, issues) {
  // The API gate trusts x-flowchain-user / x-flowchain-role headers when
  // either switch is on (local-signed-session.mjs), so production refuses both.
  const nodeEnv = text(env.NODE_ENV).toLowerCase();
  if (nodeEnv === "test") {
    issues.push(issue("NODE_ENV", "test_mode_forbidden", "NODE_ENV=test trusts test identity headers and must not be used in production."));
  } else if (nodeEnv !== "production") {
    issues.push(issue("NODE_ENV", "production_required", "The production deployment profile requires NODE_ENV=production."));
  }
  if (enabled(env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS)) {
    issues.push(issue("FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS", "test_identity_forbidden", "Test identity headers must be disabled in production."));
  }

  const sessionSecret = text(env.FLOWCHAIN_LOCAL_SESSION_SECRET);
  if (!sessionSecret) issues.push(issue("FLOWCHAIN_LOCAL_SESSION_SECRET", "required", "The local session signing secret is required."));
  else if (PLACEHOLDER_SECRET_PATTERN.test(sessionSecret)) issues.push(issue("FLOWCHAIN_LOCAL_SESSION_SECRET", "placeholder", "The local session signing secret is still a placeholder; generate a random value."));
  else if (sessionSecret.length < 32) issues.push(issue("FLOWCHAIN_LOCAL_SESSION_SECRET", "too_short", "The local session signing secret must contain at least 32 characters."));
}

// Sign-in links are emailed, so production needs a real provider, its key, a
// sender, and the public https origin the links point at.
function validateMailConfiguration(env, issues) {
  const provider = text(env.FLOWCHAIN_MAIL_PROVIDER).toLowerCase();
  if (!provider) issues.push(issue("FLOWCHAIN_MAIL_PROVIDER", "required", "A mail provider (postmark or resend) is required to send sign-in links."));
  else if (provider === "outbox") issues.push(issue("FLOWCHAIN_MAIL_PROVIDER", "outbox_forbidden", "The local mail outbox cannot be used in production."));
  else if (!["postmark", "resend"].includes(provider)) issues.push(issue("FLOWCHAIN_MAIL_PROVIDER", "unsupported", "FLOWCHAIN_MAIL_PROVIDER must be postmark or resend."));
  else {
    const key = provider === "postmark" ? "POSTMARK_SERVER_TOKEN" : "RESEND_API_KEY";
    const value = text(env[key]);
    if (!value) issues.push(issue(key, "required", `The ${provider} API key is required.`));
    else if (PLACEHOLDER_SECRET_PATTERN.test(value)) issues.push(issue(key, "placeholder", `The ${provider} API key is still a placeholder.`));
  }

  const from = text(env.FLOWCHAIN_MAIL_FROM);
  if (!from) issues.push(issue("FLOWCHAIN_MAIL_FROM", "required", "The sender address for sign-in emails is required."));
  else if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$|<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(from)) issues.push(issue("FLOWCHAIN_MAIL_FROM", "invalid", "The sender must be an email address, optionally as \"Name <address>\"."));

  const baseUrl = text(env.FLOWCHAIN_PUBLIC_BASE_URL);
  if (!baseUrl) {
    issues.push(issue("FLOWCHAIN_PUBLIC_BASE_URL", "required", "The public https origin is required to build sign-in links."));
    return;
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    issues.push(issue("FLOWCHAIN_PUBLIC_BASE_URL", "invalid", "The public base URL is not a valid URL."));
    return;
  }
  if (parsed.protocol !== "https:") issues.push(issue("FLOWCHAIN_PUBLIC_BASE_URL", "https_required", "The public base URL must use https."));
  else if (parsed.pathname.replace(/\/+$/, "") || parsed.search || parsed.hash || parsed.username || parsed.password) {
    issues.push(issue("FLOWCHAIN_PUBLIC_BASE_URL", "invalid", "The public base URL must be an origin such as https://flowchain.example.com."));
  }
}

function validateMobileSyncSecrets(env, issues) {
  if (!enabled(env.FLOWCHAIN_ENABLE_DB_MOBILE_SYNC)) return;

  const legacySecret = text(env.FLOWCHAIN_SYNC_CURSOR_SECRET);
  const currentSecret = text(env.FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET) || legacySecret;
  const currentKeyId = text(env.FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID) || (legacySecret ? "legacy" : "");
  if (!currentKeyId) {
    issues.push(issue("FLOWCHAIN_SYNC_CURSOR_CURRENT_KEY_ID", "required", "A current Mobile Sync cursor key id is required when Mobile Sync is enabled."));
  }
  if (!currentSecret) {
    issues.push(issue("FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET", "required", "A Mobile Sync cursor secret is required when Mobile Sync is enabled."));
  } else if (currentSecret.length < 32) {
    issues.push(issue("FLOWCHAIN_SYNC_CURSOR_CURRENT_SECRET", "too_short", "The Mobile Sync cursor secret must contain at least 32 characters."));
  }

  const previousKeys = text(env.FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS);
  if (!previousKeys) return;
  try {
    const parsed = JSON.parse(previousKeys);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("not_an_object");
    if (Object.values(parsed).some((secret) => text(secret).length < 32)) {
      issues.push(issue("FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS", "weak_secret", "Every previous Mobile Sync cursor secret must contain at least 32 characters."));
    }
  } catch {
    issues.push(issue("FLOWCHAIN_SYNC_CURSOR_PREVIOUS_KEYS", "invalid_json", "Previous Mobile Sync cursor keys must be a JSON object."));
  }
}

function validateAttachmentConfiguration(env, issues) {
  const provider = text(env.FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER);
  const directory = text(env.FLOWCHAIN_UPLOAD_STORAGE_DIR);
  if (!provider) issues.push(issue("FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER", "required", "The attachment storage provider is required."));
  if (!directory) issues.push(issue("FLOWCHAIN_UPLOAD_STORAGE_DIR", "required", "A durable attachment storage directory is required."));
  if (!provider || !directory) return;
  try {
    createLocalDurableAttachmentStorage({ env });
  } catch (error) {
    issues.push(issue(
      error?.code === "ATTACHMENT_STORAGE_PROVIDER_UNSUPPORTED" ? "FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER" : "FLOWCHAIN_UPLOAD_STORAGE_DIR",
      error?.code || "invalid",
      error?.message || "The attachment storage configuration is invalid.",
    ));
  }
}

export class ProductionRuntimeConfigError extends Error {
  constructor(issues) {
    super(`${PRODUCTION_CONFIG_ERROR}: ${issues.map((entry) => entry.key).join(", ")}`);
    this.name = "ProductionRuntimeConfigError";
    this.code = PRODUCTION_CONFIG_ERROR;
    this.status = 500;
    this.issues = issues;
  }
}

export function validateProductionRuntimeConfig(env = process.env) {
  // The release image sets FLOWCHAIN_DEPLOYMENT_PROFILE=production, so
  // overriding NODE_ENV there is caught instead of skipping validation.
  const production = text(env.NODE_ENV).toLowerCase() === "production"
    || text(env.FLOWCHAIN_DEPLOYMENT_PROFILE).toLowerCase() === "production";
  if (!production) return { production: false, validated: true };

  const issues = [];
  if (!text(env.DATABASE_URL)) issues.push(issue("DATABASE_URL", "required", "The PostgreSQL connection string is required."));
  if (text(env.FLOWCHAIN_PERSISTENCE_MODE).toLowerCase() !== "database") {
    issues.push(issue("FLOWCHAIN_PERSISTENCE_MODE", "database_required", "Production persistence must be explicitly set to database."));
  }
  if (!text(env.FLOWCHAIN_DEFAULT_TENANT_ID)) issues.push(issue("FLOWCHAIN_DEFAULT_TENANT_ID", "required", "The default tenant id is required."));

  validateIdentityConfiguration(env, issues);

  if (!text(env.FLOWCHAIN_COMMIT_SHA)) issues.push(issue("FLOWCHAIN_COMMIT_SHA", "required", "The immutable build commit SHA is required."));
  validateAttachmentConfiguration(env, issues);
  validateMailConfiguration(env, issues);
  validateMobileSyncSecrets(env, issues);

  if (issues.length) throw new ProductionRuntimeConfigError(issues);
  return {
    production: true,
    validated: true,
    persistenceMode: "database",
    attachmentProvider: text(env.FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER).toLowerCase(),
    commitSha: text(env.FLOWCHAIN_COMMIT_SHA),
    branch: text(env.FLOWCHAIN_BRANCH) || "unknown",
  };
}
