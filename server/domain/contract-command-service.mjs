import { createHash, randomUUID } from 'node:crypto'
import { assertAuthorized } from '../auth/authorization-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { isTransactionConflict } from '../persistence/transaction-conflict.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { loadContractView, workspaceDay } from './contract-read-service.mjs'
import {
  CONTRACT_FILE_MAX_BYTES,
  CONTRACT_FILE_MIME_TYPES,
  CONTRACT_INPUT_FIELDS,
  CONTRACT_PERMISSIONS,
  assertContractsEnabled,
  assertNoIssues,
  contractAccessFor,
  contractFail as fail,
  contractFieldIssues,
  contractMergedIssues,
  contractSnapshot,
  storedDay,
} from './contract-policy.mjs'
import { addContractDays, contractCalendarDay } from '../../shared/contract-status.mjs'

// Contract commands (docs/contracts-module-design.md, K1). Each needs
// contracts.contract.manage and the contracts capability, and follows the
// command pattern of procurement-request-command-service.mjs: one
// Serializable transaction per command holds the change, its audit row and
// the BusinessCommandExecution that makes a retry with the same idempotency
// key return the first result; a changed contract is refused with 409
// VERSION_CONFLICT when the expected version is not the current one.
//
//   create      a draft with a supplier; the owner defaults to the supplier's
//               business owner.
//   update      a draft is fully editable; an active contract keeps its
//               supplier and type; a terminated one is not edited. Every
//               change is audited with before and after.
//   activate    needs the signed date and the start date (D3).
//   terminate   needs a date and a reason.
//   renew       a new draft prefilled from an active contract, renewing it.
//   delete      drafts only.
//   add/remove  a signed file (a staged upload) is bound to the contract or
//   file        marked removed.
//
// The response is the contract as the actor may read it now, with its shown
// state; the stored result holds only ids, so a replay reads it afresh.

const text = (value) => String(value ?? '').trim()
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const SOURCE = 'contract_command_service'
const MAX_ATTEMPTS = 3

function expected(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) fail('VERSION_INVALID', 'expectedVersion must be a positive whole number.', 422, [{ field: 'expectedVersion', code: 'REQUIRED', message: 'Reload the contract and try again.' }])
  return parsed
}

function assertVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) fail('VERSION_CONFLICT', 'This contract was changed by someone else. Reload it and try again.', 409, [], { entityId: row.id, expectedVersion, currentVersion: row.version })
}

function assertStatus(row, allowed, code = 'INVALID_STATE_TRANSITION', message) {
  if (!allowed.includes(row.status)) fail(code, message || `A ${row.status} contract cannot do this.`, 409, [], { entityId: row.id, currentStatus: row.status, currentVersion: row.version })
}

const changedFields = (before, after) => Object.fromEntries(Object.keys(after).filter((key) => before[key] !== after[key]).map((key) => [key, { before: before[key], after: after[key] }]))

export function createContractCommandService({ prisma, env = process.env, idFactory = randomUUID, numberFactory = () => `CT-${randomUUID().slice(0, 8).toUpperCase()}`, now = () => new Date() } = {}) {
  const db = async () => prisma || getPrismaClient(env)
  const actorFor = async (client, context) => {
    const actor = await resolveProvisionedActor(client, context?.identity || context)
    assertAuthorized({ actor, permission: CONTRACT_PERMISSIONS.manage, tenantId: actor.tenantId })
    return actor
  }
  const lockContract = async (tx, tenantId, id) => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "Contract" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', tenantId, text(id))
    const row = await tx.contract.findFirst({ where: { id: text(id), tenantId }, include: { renewals: { select: { id: true, number: true, status: true, activatedAt: true } } } })
    if (!row) fail('CONTRACT_NOT_FOUND', 'Contract was not found.', 404)
    return row
  }

  // Runs one command once per (tenant, commandType, idempotencyKey), as
  // procurement-request-command-service.mjs does. Without a client key the
  // key is derived from the target, the expected version and the payload, so
  // a resend is a replay and a changed request meets the version check. A
  // transaction that loses a serialization race is retried.
  async function runCommand({ context, commandType, idempotencyKey, derivedKey, payload, execute }) {
    assertContractsEnabled(env)
    const client = await db()
    const initial = await actorFor(client, context)
    const requestHash = hash(payload)
    const key = text(idempotencyKey) || `${derivedKey}:${requestHash.slice(0, 24)}`
    const where = { tenantId_commandType_idempotencyKey: { tenantId: initial.tenantId, commandType, idempotencyKey: key } }
    const replay = (row) => {
      if (!row) return null
      if (row.requestHash !== requestHash) fail('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'The idempotency key was reused with a different payload.', 409)
      if (row.status !== 'completed' || !row.resultPayload) fail('COMMAND_EXECUTION_IN_PROGRESS', 'The command is already in progress.', 409)
      return { ...row.resultPayload, idempotentReplay: true }
    }
    const finish = async (result) => ({ ...result, actor: initial, client })
    const prior = replay(await client.businessCommandExecution.findUnique({ where }))
    if (prior) return finish(prior)
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await client.$transaction(async (tx) => {
          const actor = await actorFor(tx, context)
          const inside = replay(await tx.businessCommandExecution.findUnique({ where }))
          if (inside) return inside
          const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType, idempotencyKey: key, requestHash, status: 'pending' } })
          const { result: stored, entityId, audit } = await execute(tx, actor)
          await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: SOURCE, module: 'contracts', entityType: 'Contract', entityId, ...audit, metadata: { commandType, idempotencyKey: key, ...(audit.metadata || {}) } } })
          await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: 'completed', entityType: 'Contract', entityId, resultPayload: stored, completedAt: now() } })
          return { ...stored, idempotentReplay: false }
        }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 })
        return finish(result)
      } catch (error) {
        if (error?.code === 'P2002') {
          const committed = replay(await client.businessCommandExecution.findUnique({ where }))
          if (committed) return finish(committed)
        }
        if (isTransactionConflict(error) && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
          continue
        }
        throw error
      }
    }
  }

  // The contract as the actor may read it now.
  async function respond({ client, actor, idempotentReplay, contractId, ...fields }) {
    const { today } = await workspaceDay(client, actor.tenantId, now())
    const contract = await loadContractView(client, { tenantId: actor.tenantId, id: contractId, access: contractAccessFor(actor), today })
    return { ...fields, contract, idempotentReplay }
  }

  // References the stored contract makes: a supplier, an active owner and a
  // payment term of this workspace.
  async function checkReferences(tx, tenantId, values, current = {}) {
    const issues = []
    let supplier = null
    if (values.supplierId && values.supplierId !== current.supplierId) {
      supplier = await tx.supplier.findFirst({ where: { id: values.supplierId, tenantId }, select: { id: true, businessOwnerId: true } })
      if (!supplier) issues.push({ field: 'supplierId', code: 'SUPPLIER_NOT_FOUND', message: 'Choose a supplier of this workspace.' })
    }
    if (values.ownerId && values.ownerId !== current.ownerId) {
      const owner = await tx.user.findFirst({ where: { id: values.ownerId, tenantId, status: 'active' }, select: { id: true } })
      if (!owner) issues.push({ field: 'ownerId', code: 'OWNER_NOT_FOUND', message: 'Choose an active user of this workspace.' })
    }
    if (values.paymentTermsId && values.paymentTermsId !== current.paymentTermsId) {
      const term = await tx.paymentTerm.findFirst({ where: { tenantId, OR: [{ code: values.paymentTermsId }, { id: values.paymentTermsId }] }, select: { id: true } })
      if (!term) issues.push({ field: 'paymentTermsId', code: 'PAYMENT_TERM_NOT_FOUND', message: 'Choose one of the workspace payment terms.' })
    }
    assertNoIssues(issues)
    return { supplier }
  }

  // A total value is in a currency: the workspace's when none is given.
  async function withCurrency(tx, tenantId, merged) {
    if (merged.totalValue === null || merged.totalValue === undefined || merged.currency) return merged
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { currency: true } })
    return { ...merged, currency: text(tenant?.currency).toUpperCase() || 'USD' }
  }

  async function activeUserOrNull(tx, tenantId, userId) {
    if (!userId) return null
    const user = await tx.user.findFirst({ where: { id: userId, tenantId, status: 'active' }, select: { id: true } })
    return user?.id ?? null
  }

  async function uniqueNumber(tx, tenantId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const number = numberFactory()
      if (!(await tx.contract.findFirst({ where: { tenantId, number }, select: { id: true } }))) return number
    }
    return fail('CONTRACT_NUMBER_UNAVAILABLE', 'A contract number could not be assigned. Try again.', 409)
  }

  const storedFields = (values) => {
    const data = {}
    for (const [key, value] of Object.entries(values)) data[key] = ['startDate', 'endDate', 'signedOn'].includes(key) ? storedDay(value) : value
    return data
  }

  async function createContract(input = {}, context) {
    assertContractsEnabled(env)
    const { values, issues } = contractFieldIssues(input, { creating: true })
    assertNoIssues([...issues, ...contractMergedIssues(values)])
    const result = await runCommand({
      context,
      commandType: 'contract.create',
      // Without a client key every create is a new contract.
      idempotencyKey: input.idempotencyKey || idFactory(),
      payload: values,
      execute: async (tx, actor) => {
        const { supplier } = await checkReferences(tx, actor.tenantId, values)
        // The owner answers for the contract and gets its reminders: the
        // supplier's business owner unless another is chosen.
        const ownerId = Object.prototype.hasOwnProperty.call(values, 'ownerId') ? values.ownerId : await activeUserOrNull(tx, actor.tenantId, supplier?.businessOwnerId)
        const merged = await withCurrency(tx, actor.tenantId, { ...values, ownerId })
        const id = idFactory()
        const number = await uniqueNumber(tx, actor.tenantId)
        const row = await tx.contract.create({ data: { id, tenantId: actor.tenantId, number, counterpartyType: 'supplier', status: 'draft', ...storedFields(merged), createdById: actor.user.id, updatedById: actor.user.id } })
        return { result: { contractId: row.id, number }, entityId: row.id, audit: { action: 'contract_created', summary: `Created contract ${number}.`, metadata: { number, version: row.version, after: contractSnapshot(row) } } }
      },
    })
    return respond(result)
  }

  async function updateContract(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const { values, issues } = contractFieldIssues(input)
    assertNoIssues(issues)
    if (!Object.keys(values).length) fail('VALIDATION_ERROR', 'Nothing to change.', 422, [{ field: 'contract', code: 'NO_FIELDS', message: `Send at least one of: ${CONTRACT_INPUT_FIELDS.join(', ')}.` }])
    const result = await runCommand({
      context,
      commandType: 'contract.update',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.update:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion, values },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        assertStatus(row, ['draft', 'active'], 'CONTRACT_NOT_EDITABLE', 'A terminated contract cannot be edited.')
        const before = contractSnapshot(row)
        if (row.status === 'active') {
          const locked = ['supplierId', 'type'].filter((field) => field in values && values[field] !== before[field])
          if (locked.length) fail('CONTRACT_FIELD_LOCKED', 'The supplier and type of an active contract cannot change. Renew it instead.', 409, locked.map((field) => ({ field, code: 'LOCKED', message: 'An active contract keeps its supplier and type.' })))
        }
        await checkReferences(tx, actor.tenantId, values, before)
        const merged = await withCurrency(tx, actor.tenantId, { ...before, ...values })
        const mergedIssues = contractMergedIssues({ ...merged, status: row.status })
        if (row.status === 'active' && merged.signedOn && merged.signedOn !== before.signedOn) {
          const { today } = await workspaceDay(tx, actor.tenantId, now())
          if (merged.signedOn > today) mergedIssues.push({ field: 'signedOn', code: 'SIGNED_ON_IN_FUTURE', message: 'The signed date cannot be after today.' })
        }
        assertNoIssues(mergedIssues)
        const after = contractSnapshot({ ...row, ...storedFields(merged) })
        const changes = changedFields(before, after)
        if (!Object.keys(changes).length) fail('CONTRACT_UNCHANGED', 'Nothing changed.', 422)
        const version = row.version + 1
        const update = Object.fromEntries(Object.keys(changes).map((field) => [field, storedFields({ [field]: merged[field] })[field]]))
        await tx.contract.update({ where: { id: row.id }, data: { ...update, version, updatedById: actor.user.id } })
        return { result: { contractId: row.id, number: row.number }, entityId: row.id, audit: { action: 'contract_updated', summary: `Updated contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version, status: row.status, changes } } }
      },
    })
    return respond(result)
  }

  async function activateContract(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const { values, issues } = contractFieldIssues(Object.fromEntries(['signedOn', 'startDate'].filter((field) => input[field] !== undefined).map((field) => [field, input[field]])))
    assertNoIssues(issues)
    const result = await runCommand({
      context,
      commandType: 'contract.activate',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.activate:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion, values },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        assertStatus(row, ['draft'], 'INVALID_STATE_TRANSITION', 'Only a draft contract can be activated.')
        const before = contractSnapshot(row)
        const merged = { ...before, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value)), status: 'active' }
        const mergedIssues = contractMergedIssues(merged)
        const { today } = await workspaceDay(tx, actor.tenantId, now())
        if (merged.signedOn && merged.signedOn > today) mergedIssues.push({ field: 'signedOn', code: 'SIGNED_ON_IN_FUTURE', message: 'The signed date cannot be after today.' })
        assertNoIssues(mergedIssues)
        const version = row.version + 1
        const at = now()
        await tx.contract.update({ where: { id: row.id }, data: { status: 'active', signedOn: storedDay(merged.signedOn), startDate: storedDay(merged.startDate), activatedAt: at, activatedById: actor.user.id, version, updatedById: actor.user.id } })
        const changes = changedFields(before, { ...before, signedOn: merged.signedOn, startDate: merged.startDate })
        return { result: { contractId: row.id, number: row.number }, entityId: row.id, audit: { action: 'contract_activated', summary: `Activated contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version, signedOn: merged.signedOn, startDate: merged.startDate, renewsContractId: row.renewsContractId ?? null, ...(Object.keys(changes).length ? { changes } : {}) } } }
      },
    })
    return respond(result)
  }

  async function terminateContract(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const terminatedOn = contractCalendarDay(/^\d{4}-\d{2}-\d{2}$/.test(text(input.terminatedOn)) ? text(input.terminatedOn) : '')
    const reason = text(input.reason)
    const issues = []
    if (!terminatedOn) issues.push({ field: 'terminatedOn', code: text(input.terminatedOn) ? 'DATE_INVALID' : 'REQUIRED', message: 'Enter the termination date as YYYY-MM-DD.' })
    if (!reason) issues.push({ field: 'reason', code: 'REQUIRED', message: 'Enter why the contract was terminated.' })
    else if (reason.length > 1000) issues.push({ field: 'reason', code: 'TOO_LONG', message: 'Use at most 1000 characters.' })
    assertNoIssues(issues)
    const result = await runCommand({
      context,
      commandType: 'contract.terminate',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.terminate:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion, terminatedOn, reason },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        assertStatus(row, ['active'], 'INVALID_STATE_TRANSITION', 'Only an active contract can be terminated.')
        const signedOn = contractCalendarDay(row.signedOn)
        if (signedOn && terminatedOn < signedOn) assertNoIssues([{ field: 'terminatedOn', code: 'BEFORE_SIGNED_ON', message: 'The termination date cannot be before the signed date.' }])
        const version = row.version + 1
        await tx.contract.update({ where: { id: row.id }, data: { status: 'terminated', terminatedOn: storedDay(terminatedOn), terminationReason: reason, terminatedAt: now(), terminatedById: actor.user.id, version, updatedById: actor.user.id } })
        return { result: { contractId: row.id, number: row.number }, entityId: row.id, audit: { action: 'contract_terminated', summary: `Terminated contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version, terminatedOn, reason } } }
      },
    })
    return respond(result)
  }

  async function renewContract(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const result = await runCommand({
      context,
      commandType: 'contract.renew',
      // Without a client key each renew is a new attempt; a second renewal
      // of the same contract is refused below.
      idempotencyKey: input.idempotencyKey || idFactory(),
      payload: { id: text(id), expectedVersion },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        assertStatus(row, ['active'], 'CONTRACT_NOT_RENEWABLE', 'Only an active contract can be renewed.')
        const existing = row.renewals[0]
        if (existing) fail('CONTRACT_RENEWAL_EXISTS', `Contract ${row.number} is already renewed by ${existing.number}.`, 409, [], { entityId: row.id, renewalId: existing.id, renewalNumber: existing.number })
        const old = contractSnapshot(row)
        // Prefilled from the old terms; the new dates, signed date, their
        // reference and notes are entered for the new agreement.
        const prefill = {
          title: old.title, type: old.type, supplierId: old.supplierId,
          ownerId: await activeUserOrNull(tx, actor.tenantId, old.ownerId),
          startDate: old.endDate ? addContractDays(old.endDate, 1) : null, endDate: null, signedOn: null,
          renewal: old.renewal, noticeDays: old.noticeDays, reminderDays: old.reminderDays,
          paymentTermsId: old.paymentTermsId, currency: old.currency, totalValue: old.totalValue,
        }
        const renewalId = idFactory()
        const number = await uniqueNumber(tx, actor.tenantId)
        const created = await tx.contract.create({ data: { id: renewalId, tenantId: actor.tenantId, number, counterpartyType: row.counterpartyType, status: 'draft', ...storedFields(prefill), renewsContractId: row.id, createdById: actor.user.id, updatedById: actor.user.id } })
        await tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: SOURCE, module: 'contracts', entityType: 'Contract', entityId: created.id, action: 'contract_created', summary: `Created contract ${number} to renew ${row.number}.`, metadata: { number, version: created.version, renewsContractId: row.id, renewsNumber: row.number, after: contractSnapshot(created) } } })
        return { result: { contractId: created.id, number, renewsContractId: row.id }, entityId: row.id, audit: { action: 'contract_renewed', summary: `Started renewal ${number} of contract ${row.number}.`, metadata: { number: row.number, version: row.version, renewalId: created.id, renewalNumber: number } } }
      },
    })
    return respond(result)
  }

  async function deleteDraft(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const { idempotentReplay, contractId, number } = await runCommand({
      context,
      commandType: 'contract.delete',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.delete:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        assertStatus(row, ['draft'], 'CONTRACT_NOT_DRAFT', 'Only a draft contract can be deleted.')
        // A draft's files go with it; their uploads stay on disk as bound
        // uploads, like expired ones, for recovery.
        const files = await tx.contractAttachment.findMany({ where: { tenantId: actor.tenantId, contractId: row.id }, select: { id: true, fileName: true, sha256: true, status: true } })
        await tx.contractAttachment.deleteMany({ where: { tenantId: actor.tenantId, contractId: row.id } })
        await tx.contract.delete({ where: { id: row.id } })
        return { result: { contractId: row.id, number: row.number, deleted: true }, entityId: row.id, audit: { action: 'contract_draft_deleted', summary: `Deleted draft contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version: row.version, renewsContractId: row.renewsContractId ?? null, before: contractSnapshot(row), files: files.filter((file) => file.status === 'active').map((file) => ({ attachmentId: file.id, fileName: file.fileName, sha256: file.sha256 })) } } }
      },
    })
    return { deleted: true, contractId, number, idempotentReplay }
  }

  async function addFile(id, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const uploadId = text(input.uploadId)
    if (!uploadId) assertNoIssues([{ field: 'uploadId', code: 'REQUIRED', message: 'Upload the file first.' }])
    const result = await runCommand({
      context,
      commandType: 'contract.add_file',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.add_file:${text(id)}:v${expectedVersion}`,
      payload: { id: text(id), expectedVersion, uploadId },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        // Only the person who staged a file binds it, and only once.
        const upload = await tx.stagedUpload.findFirst({ where: { id: uploadId, tenantId: actor.tenantId } })
        if (!upload || upload.createdById !== actor.user.id) fail('UPLOAD_NOT_FOUND', 'Upload was not found.', 404)
        if (upload.status !== 'staged' || upload.expiresAt <= now()) fail('UPLOAD_NOT_BINDABLE', 'Upload is expired or already bound.', 409)
        if (!CONTRACT_FILE_MIME_TYPES.includes(upload.mimeType) || upload.sizeBytes > CONTRACT_FILE_MAX_BYTES) fail('CONTRACT_FILE_TYPE_NOT_ALLOWED', 'A signed file must be a PDF or an image of at most 20 MB.', 422)
        const attachment = await tx.contractAttachment.create({ data: { id: idFactory(), tenantId: actor.tenantId, contractId: row.id, uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256, createdById: actor.user.id } })
        await tx.stagedUpload.update({ where: { id: upload.id }, data: { status: 'bound', boundAt: now() } })
        const version = row.version + 1
        await tx.contract.update({ where: { id: row.id }, data: { version, updatedById: actor.user.id } })
        return { result: { contractId: row.id, number: row.number, attachmentId: attachment.id }, entityId: row.id, audit: { action: 'contract_file_added', summary: `Added ${upload.fileName} to contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version, attachmentId: attachment.id, fileName: upload.fileName, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes, sha256: upload.sha256 } } }
      },
    })
    return respond(result)
  }

  async function removeFile(id, attachmentId, input = {}, context) {
    assertContractsEnabled(env)
    const expectedVersion = expected(input.expectedVersion)
    const result = await runCommand({
      context,
      commandType: 'contract.remove_file',
      idempotencyKey: input.idempotencyKey,
      derivedKey: `contract.remove_file:${text(id)}:${text(attachmentId)}:v${expectedVersion}`,
      payload: { id: text(id), attachmentId: text(attachmentId), expectedVersion },
      execute: async (tx, actor) => {
        const row = await lockContract(tx, actor.tenantId, id)
        assertVersion(row, expectedVersion)
        const attachment = await tx.contractAttachment.findFirst({ where: { id: text(attachmentId), tenantId: actor.tenantId, contractId: row.id, status: 'active' } })
        if (!attachment) fail('ATTACHMENT_NOT_FOUND', 'Attachment was not found.', 404)
        await tx.contractAttachment.update({ where: { id: attachment.id }, data: { status: 'deleted', deletedAt: now(), deletedById: actor.user.id } })
        const version = row.version + 1
        await tx.contract.update({ where: { id: row.id }, data: { version, updatedById: actor.user.id } })
        return { result: { contractId: row.id, number: row.number, attachmentId: attachment.id }, entityId: row.id, audit: { action: 'contract_file_removed', summary: `Removed ${attachment.fileName} from contract ${row.number}.`, metadata: { number: row.number, expectedVersion, version, attachmentId: attachment.id, fileName: attachment.fileName, sha256: attachment.sha256 } } }
      },
    })
    return respond(result)
  }

  return { createContract, updateContract, activateContract, terminateContract, renewContract, deleteDraft, addFile, removeFile }
}
