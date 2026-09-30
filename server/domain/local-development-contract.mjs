import { URL } from 'node:url'

export function isLocalDatabaseUrl(value = '') {
  try {
    const url = new URL(String(value))
    return url.protocol.startsWith('postgres') && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

export function localDevelopmentEnabled(env = process.env) {
  return env.NODE_ENV === 'development'
    && env.FLOWCHAIN_DEV_LOCAL === 'true'
    && isLocalDatabaseUrl(env.DATABASE_URL)
}

export function localPostgresTestHarnessEnabled(env = process.env) {
  return env.NODE_ENV === 'test'
    && env.FLOWCHAIN_REQUIRE_REAL_POSTGRES_TESTS === 'true'
    && isLocalDatabaseUrl(env.DATABASE_URL)
}

export function assertLocalDevelopment(env = process.env, action = 'Local setup') {
  if (!env.DATABASE_URL) throw new Error(`${action}: DATABASE_URL is required.`)
  if (!localDevelopmentEnabled(env) && !localPostgresTestHarnessEnabled(env)) {
    throw new Error(`${action}: requires controlled local development or the explicit localhost PostgreSQL test harness.`)
  }
}

// The legacy email-only sign-in (POST /api/auth/login) signs in anyone who
// types a provisioned address, so it exists only in controlled local
// development and in test mode. Everywhere else people use email links.
export function directEmailLoginEnabled(env = process.env) {
  if (String(env.FLOWCHAIN_DEPLOYMENT_PROFILE || '').trim().toLowerCase() === 'production') return false
  return localDevelopmentEnabled(env) || String(env.NODE_ENV || '').trim().toLowerCase() === 'test'
}
