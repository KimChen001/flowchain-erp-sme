// One role vocabulary for every screen and the server's role labels: the
// profile role of a user or invitation by its code, and the default role
// templates by their roleKey. English names are sentence case.

export const ROLE_NAMES = Object.freeze({
  admin: Object.freeze({ en: 'Workspace administrator', zh: '工作区管理员' }),
  manager: Object.freeze({ en: 'Operations manager', zh: '运营经理' }),
  'business-specialist': Object.freeze({ en: 'Operations specialist', zh: '运营专员' }),
  buyer: Object.freeze({ en: 'Procurement specialist', zh: '采购专员' }),
  'finance-specialist': Object.freeze({ en: 'Finance specialist', zh: '财务专员' }),
  viewer: Object.freeze({ en: 'Read-only viewer', zh: '只读查看者' }),
})

// Default role templates are stored under these English names (`stored`, a
// business value that is not renamed). A template still under its stored name
// is shown in the interface language; a renamed or custom role keeps the name
// the workspace gave it.
export const ROLE_TEMPLATE_NAMES = Object.freeze({
  'workspace-administrator': Object.freeze({ stored: 'Workspace Administrator', ...ROLE_NAMES.admin }),
  'operations-manager': Object.freeze({ stored: 'Operations Manager', ...ROLE_NAMES.manager }),
  'operations-specialist': Object.freeze({ stored: 'Operations Specialist', ...ROLE_NAMES['business-specialist'] }),
  'procurement-specialist': Object.freeze({ stored: 'Procurement Specialist', ...ROLE_NAMES.buyer }),
  'finance-specialist': Object.freeze({ stored: 'Finance Specialist', ...ROLE_NAMES['finance-specialist'] }),
  'read-only-viewer': Object.freeze({ stored: 'Read-only Viewer', ...ROLE_NAMES.viewer }),
  'intake-uploader': Object.freeze({ stored: 'Intake Uploader', en: 'Intake uploader', zh: '导入上传员' }),
  'intake-reviewer': Object.freeze({ stored: 'Intake Reviewer', en: 'Intake reviewer', zh: '导入复核员' }),
})

// The Chinese labels the server sends as roleLabel; the interface translates them.
export const ROLE_LABELS = Object.freeze(Object.fromEntries(Object.entries(ROLE_NAMES).map(([code, names]) => [code, names.zh])))

const english = language => language === 'en-US'

/** A profile role code by name, in the given language (Chinese by default, as the server sends it). */
export const roleLabel = (role, language = 'zh-CN') => {
  const names = ROLE_NAMES[String(role || '').toLowerCase()]
  if (names) return english(language) ? names.en : names.zh
  return String(role || (english(language) ? 'Unknown role' : '未知角色'))
}

/** A role from the role list: a default template under its stored name is translated, any other name is kept. */
export const roleDisplayName = (role, language = 'zh-CN') => {
  const template = ROLE_TEMPLATE_NAMES[role?.roleKey]
  if (template && role.name === template.stored) return english(language) ? template.en : template.zh
  return role?.name || ''
}
