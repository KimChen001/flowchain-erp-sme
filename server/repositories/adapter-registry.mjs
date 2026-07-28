import { createDbActionDraftRepository } from './db-action-draft-repository.mjs'
import { createDbAuditLogRepository } from './db-audit-log-repository.mjs'
import { createDbMasterDataRepository } from './db-master-data-repository.mjs'
import { createDbProcurementReadRepository } from './db-procurement-read-repository.mjs'
import { createDbInventoryReadRepository } from './db-inventory-read-repository.mjs'
import { createDisabledUserDataRuntimeRepository } from './user-data-runtime-repository.mjs'
import { createDbUserConfirmedActionRepository } from './db-user-confirmed-action-repository.mjs'
import { createDbExceptionCaseRepository } from './db-exception-case-repository.mjs'
import { createDbProcurementCommandService } from '../domain/procurement-db-command-service.mjs'
import { createDbProcurementRuntimeRepository } from './db-procurement-runtime-repository.mjs'
import { createDbIntakeRepository } from './db-intake-repository.mjs'
import { createDbSalesOrderReadRepository } from './db-sales-order-read-repository.mjs'

export const PERSISTENCE_MODES = Object.freeze({ database: 'database' })
export const JSON_PERSISTENCE_REMOVED_ERROR = 'FLOWCHAIN_JSON_PERSISTENCE_REMOVED'

function text(value = '') {
  return String(value ?? '').trim().toLowerCase()
}

export function getPersistenceMode(env = process.env) {
  const requested = text(env.FLOWCHAIN_PERSISTENCE_MODE)
  if (requested === 'json') {
    const error = new Error(JSON_PERSISTENCE_REMOVED_ERROR)
    error.code = JSON_PERSISTENCE_REMOVED_ERROR
    error.status = 500
    throw error
  }
  if (requested && requested !== PERSISTENCE_MODES.database) {
    const error = new Error(`Unsupported persistence mode: ${requested}`)
    error.code = 'FLOWCHAIN_PERSISTENCE_MODE_UNSUPPORTED'
    error.status = 500
    throw error
  }
  return PERSISTENCE_MODES.database
}

function createTransientAiConversationRepository() {
  return {
    implemented: false,
    mode: 'transient-session-context',
    listConversations: () => [],
  }
}

export function createDatabaseRepositoryRegistry({ db = {}, env = process.env, prisma } = {}) {
  getPersistenceMode(env)
  const inventoryRead = createDbInventoryReadRepository({ env, prisma })
  return {
    mode: PERSISTENCE_MODES.database,
    masterData: createDbMasterDataRepository({ env, prisma }),
    inventoryRead,
    inventoryRuntime: inventoryRead,
    procurementRead: createDbProcurementReadRepository({ env, prisma }),
    procurementRuntime: createDbProcurementRuntimeRepository({ env, prisma }),
    procurementAuthority: createDbProcurementCommandService({ env, prisma }),
    salesOrders: createDbSalesOrderReadRepository({ env, prisma }),
    actionDrafts: createDbActionDraftRepository({ db, env, prisma }),
    exceptionCases: createDbExceptionCaseRepository({ env, prisma }),
    auditLog: createDbAuditLogRepository({ env, prisma }),
    aiConversation: createTransientAiConversationRepository(),
    userDataRuntime: createDisabledUserDataRuntimeRepository(),
    userConfirmedActions: createDbUserConfirmedActionRepository({ env, prisma }),
    intake: createDbIntakeRepository({ env, prisma }),
  }
}

export function createRepositoryRegistry({ db = {}, env = process.env, prisma } = {}) {
  return createDatabaseRepositoryRegistry({ db, env, prisma })
}
