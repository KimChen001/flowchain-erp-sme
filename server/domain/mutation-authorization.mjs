// Legacy role check by User.role. It now guards only the retired inventory
// item and sales-demand order endpoints, which answer 501 to everyone allowed
// through. New writes use Roles & permissions (assertAuthorized) instead.
const DEFAULT_MESSAGE = 'You do not have permission to perform this action.'

export function authorizeMutation(ctx, { allowedRoles = [], action = 'mutate', resource = 'authoritative-runtime' } = {}) {
  const identity = ctx.identity
  if (!identity?.authenticated) {
    ctx.send(ctx.res, 401, {
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Sign in to perform this action.',
      action,
      resource,
    })
    return { blocked: true, identity: null }
  }
  if (!allowedRoles.includes(identity.role)) {
    ctx.send(ctx.res, 403, {
      code: 'PERMISSION_DENIED',
      message: DEFAULT_MESSAGE,
      action,
      resource,
    })
    return { blocked: true, identity }
  }
  return { blocked: false, identity }
}
