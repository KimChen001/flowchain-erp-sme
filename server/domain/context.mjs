export const currentTenantContext = Object.freeze({
  id: 'tenant-flowchain-sme',
  name: 'FlowChain SME Workspace',
  industry: 'Manufacturing / Distribution',
  currency: 'USD',
  timezone: 'America/New_York',
  defaultWarehouseId: 'WH-MAIN',
  settings: {
    allowAiDraftPreparation: true,
    requireUserReviewForAiDrafts: true,
    defaultDocumentStatus: 'draft',
  },
})

const defaultUser = Object.freeze({
  id: 'user-buyer-001',
  name: 'FlowChain Buyer',
  email: 'buyer@flowchain.local',
  role: 'buyer',
  department: 'Procurement',
  locale: 'en-US',
})

const roleLabels = {
  viewer: 'Viewer',
  planner: 'Planner',
  buyer: 'Buyer',
  approver: 'Approver',
  manager: 'Approver',
  admin: 'Admin',
}

const alphaRoleBoundaries = {
  viewer: {
    canViewReadModels: true,
    canPrepareDrafts: false,
    canSaveActionDraftShells: false,
    canReviewActionDrafts: false,
    canApproveBusinessDocuments: false,
  },
  planner: {
    canViewReadModels: true,
    canPrepareDrafts: true,
    canSaveActionDraftShells: true,
    canReviewActionDrafts: true,
    canApproveBusinessDocuments: false,
  },
  buyer: {
    canViewReadModels: true,
    canPrepareDrafts: true,
    canSaveActionDraftShells: true,
    canReviewActionDrafts: true,
    canApproveBusinessDocuments: false,
  },
  approver: {
    canViewReadModels: true,
    canPrepareDrafts: true,
    canSaveActionDraftShells: true,
    canReviewActionDrafts: true,
    canApproveBusinessDocuments: true,
  },
  admin: {
    canViewReadModels: true,
    canPrepareDrafts: true,
    canSaveActionDraftShells: true,
    canReviewActionDrafts: true,
    canApproveBusinessDocuments: true,
  },
}

function tokenFromAuthorization(authorization = '') {
  return String(authorization || '').replace(/^Bearer\s+/i, '').trim()
}

function publicUser(user) {
  if (!user) return null
  const { token, ...safeUser } = user
  return safeUser
}

export function resolveCurrentUser(db = {}, authorization = '') {
  const token = tokenFromAuthorization(authorization)
  const users = Array.isArray(db.users) ? db.users : []
  const matchedUser = token ? users.find((user) => user.token === token) : null
  const user = publicUser(matchedUser) || defaultUser
  return {
    id: user.id || defaultUser.id,
    name: user.name || defaultUser.name,
    email: user.email || defaultUser.email,
    role: user.role || defaultUser.role,
    department: user.department || 'Procurement',
    locale: user.locale || defaultUser.locale,
  }
}

export function permissionsForUser(user = defaultUser) {
  const rawRole = String(user.role || defaultUser.role).toLowerCase()
  const role = rawRole.includes('admin')
    ? 'admin'
    : rawRole.includes('approver') || rawRole.includes('manager')
      ? 'approver'
      : rawRole.includes('planner')
        ? 'planner'
        : rawRole.includes('viewer')
          ? 'viewer'
          : 'buyer'
  const boundary = alphaRoleBoundaries[role]
  return {
    role,
    roleLabel: roleLabels[role] || user.role || defaultUser.role,
    alphaBoundary: 'read_preview_draft_save_only_no_final_business_confirmation',
    canViewReadModels: boundary.canViewReadModels,
    canPrepareDrafts: boundary.canPrepareDrafts,
    canReviewActionDrafts: boundary.canReviewActionDrafts,
    canSaveActionDraftShells: boundary.canSaveActionDraftShells,
    canSubmitDocuments: false,
    canSubmitBusinessDocuments: false,
    canApproveDocuments: boundary.canApproveBusinessDocuments,
    canApproveBusinessDocuments: boundary.canApproveBusinessDocuments,
  }
}

export function buildCurrentContext(db = {}, authorization = '') {
  const user = resolveCurrentUser(db, authorization)
  return {
    user,
    tenant: {
      id: currentTenantContext.id,
      name: currentTenantContext.name,
    },
    permissionsContext: permissionsForUser(user),
  }
}
