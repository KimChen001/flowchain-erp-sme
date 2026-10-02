import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPilotOperationsService } from './pilot-operations-service.mjs'
import { cleanupReceivingScenario, expectCommandError, seedReceivingScenario, withLiveReceivingDatabase } from './receiving-posting-live-test-helpers.mjs'

test('Pilot diagnostics are admin-only and exports honor tenant and warehouse scope', async t => {
  await withLiveReceivingDatabase(t, async ({ prisma }) => {
    const scenario = await seedReceivingScenario(prisma)
    const actor = { ...scenario.actor, source: 'local_signed_session', role: 'admin' }
    await prisma.user.create({ data: { id: actor.userId, tenantId: scenario.tenantId, email: 'pilot-ops@example.com', name: 'Pilot Ops Admin', role: 'admin', status: 'active' } })
    const service = createPilotOperationsService({ prisma, now: () => new Date('2026-07-15T00:00:00.000Z') })
    try {
      const diagnostics = await service.diagnostics(actor)
      assert.equal(diagnostics.safe, true)
      assert.equal(diagnostics.checks.find(check => check.id === 'migrations').status, 'pass')
      assert.doesNotMatch(JSON.stringify(diagnostics), /DATABASE_URL|password|tokenHash|session/i)

      const adminExport = await service.exportDataset('receiving_documents', actor)
      assert.equal(adminExport.rowCount, 1); assert.equal(adminExport.rows[0].documentNumber.startsWith('GRN-'), true)

      await prisma.user.update({ where: { id: actor.userId }, data: { role: 'manager', rolesAssignedAt: null } }); actor.role = 'manager'
      await prisma.userRoleAssignment.deleteMany({ where: { userId: actor.userId } })
      await prisma.userWarehouseScope.upsert({ where: { tenantId_userId_warehouseId: { tenantId: scenario.tenantId, userId: actor.userId, warehouseId: scenario.warehouseId } }, create: { id: randomUUID(), tenantId: scenario.tenantId, userId: actor.userId, warehouseId: scenario.warehouseId, accessLevel: 'read' }, update: { accessLevel: 'read' } })
      assert.equal((await service.exportDataset('receiving_documents', actor)).rowCount, 1)
      await expectCommandError(service.diagnostics(actor), 'AUTHORIZATION_PERMISSION_DENIED')
      await expectCommandError(service.exportDataset('unknown', actor), 'EXPORT_DATASET_UNSUPPORTED')
    } finally { await cleanupReceivingScenario(prisma, scenario) }
  })
})
