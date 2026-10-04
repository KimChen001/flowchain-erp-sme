// Prisma sends contains, startsWith, endsWith and case-insensitive equals to
// PostgreSQL as LIKE / ILIKE patterns without escaping the value, so a search
// for "%" matches every row and "_" any one character. Escape user text before
// it reaches one of those filters. Backslash is PostgreSQL's default LIKE escape.
export function escapeLikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, '\\$&')
}
