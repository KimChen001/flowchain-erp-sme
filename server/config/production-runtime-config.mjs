import { createLocalDurableAttachmentStorage } from "../domain/attachment-storage-provider.mjs";

export const PRODUCTION_CONFIG_ERROR = "FLOWCHAIN_PRODUCTION_CONFIG_INVALID";

const text = (value) => String(value ?? "").trim();
const enabled = (value) => text(value).toLowerCase() === "true";

// The release image bakes "unknown" when it is built without the
// FLOWCHAIN_COMMIT_SHA / FLOWCHAIN_BRANCH build arguments, so "unknown" counts
// as unset. Render builds from the repository without those arguments but sets
// RENDER=true, RENDER_GIT_COMMIT and RENDER_GIT_BRANCH on every deploy. The
// Render values are a fallback only on Render; everywhere else the commit SHA
// must still be supplied explicitly.
const unsetBuildValue = (value) => !text(value) || text(value).toLowerCase() === "unknown";

export function resolveBuildIdentity(env = process.env) {
  const onRender = text(env.RENDER).toLowerCase() === "true";
  const pick = (explicit, render) => {
    if (!unsetBuildValue(explicit)) return text(explicit);
    return onRender && !unsetBuildValue(render) ? text(render) : "";
  };
  return {
    commitSha: pick(env.FLOWCHAIN_COMMIT_SHA, env.RENDER_GIT_COMMIT),
    branch: pick(env.FLOWCHAIN_BRANCH, env.RENDER_GIT_BRANCH),
  };
}

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

  const build = resolveBuildIdentity(env);
  if (!build.commitSha) issues.push(issue("FLOWCHAIN_COMMIT_SHA", "required", "The immutable build commit SHA is required."));
  validateAttachmentConfiguration(env, issues);
  validateMobileSyncSecrets(env, issues);

  if (issues.length) throw new ProductionRuntimeConfigError(issues);
  return {
    production: true,
    validated: true,
    persistenceMode: "database",
    attachmentProvider: text(env.FLOWCHAIN_ATTACHMENT_STORAGE_PROVIDER).toLowerCase(),
    commitSha: build.commitSha,
    branch: build.branch || "unknown",
  };
}
