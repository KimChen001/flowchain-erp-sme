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

export function assertLocalDevelopment(env = process.env, action = 'Local setup') {
  if (!env.DATABASE_URL) throw new Error(`${action}: DATABASE_URL is required.`)
  if (!localDevelopmentEnabled(env)) {
    throw new Error(`${action}: requires NODE_ENV=development, FLOWCHAIN_DEV_LOCAL=true, and a localhost PostgreSQL DATABASE_URL.`)
  }
}
