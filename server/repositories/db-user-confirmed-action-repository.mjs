import { randomUUID } from 'node:crypto'
import { validateUserConfirmedActionRequest } from '../domain/user-confirmed-business-action.mjs'
import { buildConfirmedActionRecord } from './user-confirmed-action-repository.mjs'
import { createDbRuntimeRecordRepository } from './db-runtime-record-repository.mjs'

const NAMESPACE = 'user_confirmed_action'

export function createDbUserConfirmedActionRepository({ env = process.env, prisma } = {}) {
  const records = createDbRuntimeRecordRepository({ env, prisma })
  return {
    adapter: 'db-user-confirmed-action-v1',
    async executeConfirmedAction(input = {}) {
      const validation = validateUserConfirmedActionRequest({
        ...input,
        actionId: input.actionId || `UCA-${randomUUID()}`,
      })
      if (!validation.ok) {
        const error = new Error('User-confirmed action rejected by execution boundary.')
        error.status = 422
        error.code = 'USER_CONFIRMED_ACTION_REJECTED'
        error.validation = validation
        throw error
      }
      const action = validation.action
      const record = buildConfirmedActionRecord(action, {
        idFactory: (prefix) => `${prefix}-${randomUUID()}`,
      })
      return records.put(action.scope, NAMESPACE, action.actionId, record)
    },
    async listConfirmedActions(scope = {}, filters = {}) {
      return (await records.list(scope, NAMESPACE)).filter((item) =>
        (!filters.actionType || item.actionType === filters.actionType) &&
        (!filters.createdRecordType || item.createdRecordType === filters.createdRecordType)
      )
    },
    async getConfirmedAction(scope = {}, actionId = '') {
      const direct = await records.get(scope, NAMESPACE, actionId)
      if (direct) return direct
      return (await records.list(scope, NAMESPACE)).find((item) => item.createdRecordId === actionId || item.createdRecord?.id === actionId) || null
    },
  }
}
