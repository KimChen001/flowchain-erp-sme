import { getPersistenceMode, PERSISTENCE_MODES } from '../repositories/adapter-registry.mjs'

export const DATABASE_CONFIG_ERROR = 'FLOWCHAIN_DATABASE_URL_REQUIRED'

function text(value = '') {
  return String(value ?? '').trim()
}

export function getDatabaseUrl(env = process.env) {
  return text(env.DATABASE_URL)
}

export function getPersistenceConfig(env = process.env) {
  const mode = getPersistenceMode(env)
  const databaseUrl = getDatabaseUrl(env)
  return {
    mode,
    databaseConfigured: Boolean(databaseUrl),
    databaseUrl,
  }
}

export function validateDatabasePersistenceConfig(env = process.env) {
  const config = getPersistenceConfig(env)
  if (!config.databaseConfigured) {
    const error = new Error(DATABASE_CONFIG_ERROR)
    error.code = DATABASE_CONFIG_ERROR
    error.status = 500
    throw error
  }
  return config
}

export function isDatabasePersistenceEnabled(env = process.env) {
  validateDatabasePersistenceConfig(env)
  return true
}
