import {
  createExceptionCaseDraft,
  normalizeExceptionCase,
  validateExceptionCase,
} from '../domain/exception-case-model.mjs'
import {
  assertExceptionCaseTransition,
  buildResolutionPayload,
  normalizeCaseNote,
  validateExceptionCaseFieldUpdate,
  workflowAuditEntry,
} from '../domain/exception-case-workflow.mjs'
import { createDbRuntimeRecordRepository } from './db-runtime-record-repository.mjs'

const NAMESPACE = 'exception_case'

function findDuplicate(rows, fields = {}) {
  return rows.find((item) =>
    item.caseType === fields.caseType &&
    item.sourceEntityType === fields.sourceEntityType &&
    item.sourceEntityId === fields.sourceEntityId &&
    !['closed', 'cancelled', 'resolved'].includes(item.status)
  ) || null
}

export function createDbExceptionCaseRepository({ env = process.env, prisma } = {}) {
  const records = createDbRuntimeRecordRepository({ env, prisma })

  async function update(scope, caseId, mutate) {
    const current = await records.get(scope, NAMESPACE, caseId)
    if (!current) return null
    const next = await mutate(current)
    return records.put(scope, NAMESPACE, caseId, next)
  }

  return {
    adapter: 'db-exception-case-v1',
    async previewCaseDraft(scope = {}, draftInput = {}) {
      const draft = createExceptionCaseDraft(draftInput)
      const duplicate = findDuplicate(await records.list(scope, NAMESPACE), draft.proposedCaseFields)
      return duplicate
        ? { ...draft, duplicateWarning: { caseId: duplicate.caseId, title: duplicate.title, message: 'Open case already exists for this source entity and case type.' } }
        : draft
    },
    async createCase(scope = {}, input = {}) {
      if (input.confirm !== true && input.explicitConfirmation !== true) {
        const error = new Error('Explicit user confirmation is required to create an exception case.')
        error.status = 400
        error.code = 'EXCEPTION_CASE_CONFIRMATION_REQUIRED'
        throw error
      }
      const fields = input.case || input.proposedCaseFields || input
      const validation = validateExceptionCase({ ...fields, status: fields.status || 'open', severity: fields.severity || 'medium' })
      if (!validation.ok) {
        const error = new Error(`Invalid exception case: ${validation.errors.join(', ')}`)
        error.status = 400
        error.code = 'EXCEPTION_CASE_VALIDATION_FAILED'
        error.validation = validation
        throw error
      }
      const item = normalizeExceptionCase({
        ...fields,
        auditMetadata: { ...(fields.auditMetadata || {}), confirmation: 'user_confirmed', sourceTrigger: input.sourceTrigger || fields.sourceTrigger },
        notes: fields.notes || [],
        auditTrail: [
          ...(fields.auditTrail || []),
          workflowAuditEntry('exception_case_created', fields, input, { status: fields.status || 'open' }),
        ],
      })
      return records.put(scope, NAMESPACE, item.caseId, item)
    },
    async listCases(scope = {}, filters = {}) {
      return (await records.list(scope, NAMESPACE)).filter((item) =>
        (!filters.status || item.status === filters.status) &&
        (!filters.caseType || item.caseType === filters.caseType) &&
        (!filters.severity || item.severity === filters.severity)
      )
    },
    getCaseById: (scope = {}, caseId = '') => records.get(scope, NAMESPACE, caseId),
    async addCaseNote(scope = {}, caseId = '', noteInput = {}) {
      if (noteInput.confirm !== true && noteInput.explicitConfirmation !== true) {
        const error = new Error('Explicit user confirmation is required to save a case note.')
        error.status = 400
        error.code = 'EXCEPTION_CASE_NOTE_CONFIRMATION_REQUIRED'
        throw error
      }
      return update(scope, caseId, (current) => {
        const note = normalizeCaseNote(noteInput)
        return {
          ...current,
          notes: [...(current.notes || []), note],
          auditTrail: [...(current.auditTrail || []), workflowAuditEntry('exception_case_note_added', current, noteInput, { noteType: note.noteType })],
          updatedAt: note.createdAt,
        }
      })
    },
    updateCaseStatus(scope = {}, caseId = '', statusInput = {}) {
      return update(scope, caseId, (current) => {
        const transition = assertExceptionCaseTransition(current.status, statusInput.status, statusInput)
        const resolution = statusInput.status === 'closed' ? buildResolutionPayload(statusInput, current) : current.resolution
        const note = statusInput.note || statusInput.reason || statusInput.resolutionNote
          ? normalizeCaseNote({ ...statusInput, body: statusInput.note || statusInput.reason || statusInput.resolutionNote, noteType: statusInput.status === 'closed' ? 'resolution' : 'system' })
          : null
        return {
          ...current,
          status: statusInput.status,
          resolution,
          notes: note ? [...(current.notes || []), note] : current.notes,
          auditTrail: [...(current.auditTrail || []), workflowAuditEntry(statusInput.status === 'closed' ? 'exception_case_closed' : 'exception_case_status_changed', current, statusInput, { previousStatus: transition.from, nextStatus: transition.to })],
          updatedAt: statusInput.timestamp || new Date().toISOString(),
        }
      })
    },
    updateCaseFields(scope = {}, caseId = '', updateInput = {}) {
      return update(scope, caseId, (current) => {
        const validation = validateExceptionCaseFieldUpdate(updateInput)
        if (!validation.ok) {
          const error = new Error(`Invalid exception case field update: ${validation.errors.join(', ')}`)
          error.status = 400
          error.code = validation.errors.includes('confirmation_required') ? 'EXCEPTION_CASE_UPDATE_CONFIRMATION_REQUIRED' : 'EXCEPTION_CASE_FIELD_UPDATE_INVALID'
          error.validation = validation
          throw error
        }
        const fields = updateInput.fields || updateInput
        const allowed = Object.fromEntries(Object.entries(fields).filter(([key]) => ['owner', 'dueDate', 'severity'].includes(key)))
        return {
          ...current,
          ...allowed,
          auditTrail: [...(current.auditTrail || []), workflowAuditEntry('exception_case_fields_updated', current, updateInput, { fields: Object.keys(allowed) })],
          updatedAt: updateInput.timestamp || new Date().toISOString(),
        }
      })
    },
    async findDuplicateCase(scope = {}, fields = {}) {
      return findDuplicate(await records.list(scope, NAMESPACE), fields)
    },
  }
}
