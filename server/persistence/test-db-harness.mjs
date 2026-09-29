import { envForTestDatabase, getTestDatabaseConfig } from './test-db-config.mjs'
import { getPrismaClient } from './prisma-client.mjs'

export function shouldSkipDbTests(env = process.env) {
  const config = getTestDatabaseConfig(env)
  return {
    skip: !config.configured,
    reason: config.skipReason,
    config,
  }
}

/**
 * Decides whether a suite that needs a real PostgreSQL transaction may run.
 *
 * Suites that cannot run must register a SKIP, never a pass. Reporting `ok` for
 * a suite that did not execute is how several thousand lines of transaction
 * coverage came to look green in `npm test` while never running.
 *
 * `enabled`  - run the real suite.
 * `failure`  - real PostgreSQL was demanded but is unavailable: fail loudly.
 * `skipReason` - not requested here; the isolated gate command owns it.
 */
export function realPostgresSuiteGate(gateCommand, env = process.env) {
  const required = env.FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS === 'true'
  const hasDatabaseUrl = Boolean(env.DATABASE_URL)
  if (required && hasDatabaseUrl) return { enabled: true }
  if (required) {
    return {
      enabled: false,
      failure: `FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS is true but DATABASE_URL is not set, so this suite cannot run. Use ${gateCommand}, which provisions an isolated PostgreSQL instance.`,
    }
  }
  return {
    enabled: false,
    skipReason: `Real PostgreSQL transaction suite is owned by ${gateCommand}; set FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS=true with DATABASE_URL to run it here.`,
  }
}

export async function withTestDatabase(env = process.env, callback) {
  const skip = shouldSkipDbTests(env)
  if (skip.skip) {
    return { skipped: true, reason: skip.reason }
  }
  const clientEnv = envForTestDatabase(env)
  const prisma = await getPrismaClient(clientEnv)
  const result = typeof callback === 'function'
    ? await callback({ prisma, env: clientEnv, config: skip.config })
    : undefined
  return { skipped: false, result }
}
