-- When a user's role assignments were first set, by the one-time legacy
-- backfill or by an administrator. Once set, the legacy User.role is never
-- used to grant roles again, so removing a role, or every role, holds.
-- Additive: one nullable column. Users who already have role assignments, or
-- whose assignments an administrator has already changed, are marked now.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "rolesAssignedAt" TIMESTAMP(3);

-- Backfill
UPDATE "User" AS u
SET "rolesAssignedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "UserRoleAssignment" AS a WHERE a."userId" = u."id" AND a."tenantId" = u."tenantId")
   OR EXISTS (SELECT 1 FROM "AuditLog" AS l WHERE l."tenantId" = u."tenantId" AND l."entityType" = 'User' AND l."entityId" = u."id" AND l."action" = 'user_role_assignments_changed');
