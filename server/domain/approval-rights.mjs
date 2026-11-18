import { can } from '../auth/authorization-service.mjs'
import { getPrismaClient } from '../persistence/prisma-client.mjs'
import { resolveProvisionedActor } from './pilot-identity.mjs'
import { approverStanding, mayApprove } from './self-approval.mjs'

// canApprove on the purchase requests and orders a page reads (design audit
// C4 follow-up, 2026-11-18): the reader may approve the record now. That is,
// it waits for approval, the reader holds the approval permission, and it is
// not their own request or order while someone else may approve it. The
// pages offer Approve and Reject only then, so a requester no longer meets
// a button the server refuses. The approval commands still decide.
const AWAITING = Object.freeze({ purchase_request: 'submitted', purchase_order: 'pending_approval' })

const text = (value) => String(value ?? '').trim()

// The reader's standing for one request: their approval permissions and the
// ones only they hold. null when it cannot be read, and then nothing offers
// Approve.
export async function readerApprovalStanding(ctx, kinds) {
  try {
    const identity = ctx.identity
    let prisma = null
    try { prisma = await getPrismaClient(ctx.env || process.env) } catch { prisma = null }
    const actor = identity?.authenticated && identity.complete && identity.permissionCodes ? identity : await resolveProvisionedActor(prisma, identity)
    return await approverStanding(prisma, actor, (permission) => can({ actor, permission, tenantId: actor.tenantId }), kinds)
  } catch {
    return null
  }
}

// The rows with canApprove, and without the author ids it was worked out from.
export function withCanApprove(rows, kind, standing) {
  return (Array.isArray(rows) ? rows : []).map((row) => withCanApproveOne(row, kind, standing))
}

export function withCanApproveOne(row, kind, standing) {
  if (!row || typeof row !== 'object') return row
  const { approvalAuthorIds: authors, ...rest } = row
  return { ...rest, canApprove: text(row.status) === AWAITING[kind] && mayApprove(standing, kind, Array.isArray(authors) ? authors : []) }
}
