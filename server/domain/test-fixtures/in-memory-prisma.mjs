// An in-memory stand-in for the Prisma calls the read services make, so a
// test checks what a read returns for the where clause it builds, not only
// that the code builds one (design audit 2026-11-15, findings-13: read
// services were tested through their pure helpers only). Taken from the
// finance landing test (finance-landing-money.test.mjs).
//
//   matches(row, where)   whether a row satisfies a Prisma where clause:
//                         AND / OR / NOT, equality, equals, in, notIn, not, gt, gte,
//                         lt, lte, is (a to-one relation the row embeds; is:
//                         null for none), some and none (a to-many relation
//                         the row embeds); mode is ignored. Any other
//                         operator throws, so a test never passes on a filter
//                         the stand-in does not model.
//   inMemoryModel(rows)   a model with count, findMany ({ where, distinct,
//                         select, orderBy, skip, take }), findFirst and
//                         groupBy ({ by, where, _count: { _all } }). Relations
//                         are read from the rows as they are given, so include
//                         is ignored.
//
// Dates compare by time and numeric strings (Decimal values) as numbers.

const comparable = (value) => (value instanceof Date ? value.getTime() : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value)

function matchesField(value, condition) {
  if (condition === null || typeof condition !== 'object' || condition instanceof Date) return comparable(value) === comparable(condition)
  if ('is' in condition) return condition.is === null ? !value : value ? matches(value, condition.is) : false
  return Object.entries(condition).every(([operator, operand]) => {
    if (operator === 'mode') return true
    if (operator === 'equals') return comparable(value) === comparable(operand)
    if (operator === 'in') return operand.includes(value)
    if (operator === 'notIn') return !operand.includes(value)
    if (operator === 'not') return operand === null ? value !== null && value !== undefined : comparable(value) !== comparable(operand)
    if (operator === 'gt') return comparable(value) > comparable(operand)
    if (operator === 'gte') return comparable(value) >= comparable(operand)
    if (operator === 'lt') return comparable(value) < comparable(operand)
    if (operator === 'lte') return comparable(value) <= comparable(operand)
    // A relation filter: some related row matches.
    if (operator === 'some') return Array.isArray(value) && value.some((row) => matches(row, operand))
    if (operator === 'none') return !Array.isArray(value) || !value.some((row) => matches(row, operand))
    throw new Error(`operator ${operator} is not modelled`)
  })
}

export function matches(row, where = {}) {
  return Object.entries(where || {}).every(([key, condition]) => {
    if (key === 'AND') return condition.every((part) => matches(row, part))
    if (key === 'OR') return condition.some((part) => matches(row, part))
    if (key === 'NOT') return !(Array.isArray(condition) ? condition.some((part) => matches(row, part)) : matches(row, condition))
    return matchesField(row[key], condition)
  })
}

function sorted(rows, orderBy) {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((entry) => Object.entries(entry))
  if (!keys.length) return rows
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const left = comparable(a[field])
      const right = comparable(b[field])
      if (left === right) continue
      const order = left === null || left === undefined ? 1 : right === null || right === undefined ? -1 : left < right ? -1 : 1
      return direction === 'desc' ? -order : order
    }
    return 0
  })
}

export function inMemoryModel(rows) {
  const filtered = (where) => rows.filter((row) => matches(row, where))
  const findMany = async ({ where, distinct, select, orderBy, skip, take } = {}) => {
    let found = sorted(filtered(where), orderBy)
    if (distinct) found = found.filter((row, index) => found.findIndex((other) => distinct.every((field) => other[field] === row[field])) === index)
    if (Number.isInteger(skip)) found = found.slice(skip)
    if (Number.isInteger(take)) found = found.slice(0, take)
    return select ? found.map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))) : found
  }
  return {
    count: async ({ where } = {}) => filtered(where).length,
    findMany,
    findFirst: async (query = {}) => (await findMany({ ...query, take: 1 }))[0] || null,
    // One row per distinct value of the `by` fields, with how many rows have it.
    groupBy: async ({ by, where } = {}) => {
      const groups = new Map()
      for (const row of filtered(where)) {
        const key = JSON.stringify(by.map((field) => row[field]))
        const group = groups.get(key) || { ...Object.fromEntries(by.map((field) => [field, row[field]])), _count: { _all: 0 } }
        group._count._all += 1
        groups.set(key, group)
      }
      return [...groups.values()]
    },
  }
}
