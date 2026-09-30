import { randomUUID } from "node:crypto";

// Test harnesses that run the server with NODE_ENV=production must pass the
// production config validation, which requires a real mail provider. These
// values satisfy it without being usable: the token is random, the sender and
// base URL use the reserved .test domain, and no harness requests a sign-in
// link, so nothing is ever sent to the provider.
export function productionHarnessMailEnv() {
  return {
    FLOWCHAIN_MAIL_PROVIDER: "postmark",
    POSTMARK_SERVER_TOKEN: `harness-never-sends-${randomUUID()}`,
    FLOWCHAIN_MAIL_FROM: "FlowChain <sign-in@flowchain.test>",
    FLOWCHAIN_PUBLIC_BASE_URL: "https://flowchain.test",
  };
}
