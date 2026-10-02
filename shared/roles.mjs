export const ROLE_LABELS = Object.freeze({
  admin: '工作区管理员',
  manager: '供应链经理',
  viewer: '只读用户',
  'business-specialist': '业务专员',
  buyer: '采购员',
  'finance-specialist': '财务专员',
})

export const roleLabel = role => ROLE_LABELS[String(role || '').toLowerCase()] || String(role || '未知角色')
