export function createClientIdFactory(cryptoApi: Pick<Crypto, "randomUUID" | "getRandomValues"> | undefined, now = () => Date.now()) {
 let temporaryCounter = 0;
 function randomHex(bytes = 16) {
  if (!cryptoApi?.getRandomValues) return "";
  const values = new Uint8Array(bytes);
  cryptoApi.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
 }
 return {
  temporary(prefix = "ui-temp") {
    if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
    const random = randomHex();
    if (random) return `${prefix}-${random}`;
    temporaryCounter += 1;
    return `${prefix}-${now().toString(36)}-${temporaryCounter.toString(36)}`;
  },
  secure(prefix = "mutation") {
    if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
    const random = randomHex(24);
    if (random) return `${prefix}-${random}`;
    throw new Error("Secure browser randomness is unavailable; the operation was not submitted.");
  },
 };
}

const defaultClientIdFactory = createClientIdFactory(globalThis.crypto);

/**
 * UI-only identifier for React keys and unpersisted draft rows.
 * Never use for database IDs, idempotency keys, sessions, tokens, checksums,
 * or any security-sensitive purpose.
 */
export function createClientTemporaryId(prefix = "ui-temp") {
  return defaultClientIdFactory.temporary(prefix);
}

/** Cryptographically random client mutation key. Fails closed without Web Crypto. */
export function createSecureClientMutationId(prefix = "mutation") {
  return defaultClientIdFactory.secure(prefix);
}
