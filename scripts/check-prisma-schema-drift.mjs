// Fails when prisma/schema.prisma has drifted from the hand-written SQL in
// prisma/migrations. The check migrates a throwaway embedded PostgreSQL with
// `prisma migrate deploy`, then asks `prisma migrate diff` which statements
// would make that database match schema.prisma. Those are the statements
// `prisma db push` would run, and that `prisma migrate dev` would put into its
// next migration. Any statement not listed in ALLOWED_DRIFT fails the check,
// and so does any ALLOWED_DRIFT entry that no longer appears.
//
// It never connects to a configured database: every Prisma command it runs
// gets DATABASE_URL pointed at the embedded instance.
//
// Usage: node scripts/check-prisma-schema-drift.mjs [--print]
//   --print  also print the full diff script, including allowed statements.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Statements `prisma migrate diff` emits for objects the schema cannot
// express. Each entry is the exact statement (whitespace collapsed) and why
// Prisma cannot express it. Do not add entries for drift the schema can fix.
export const ALLOWED_DRIFT = [
  {
    statement: 'ALTER INDEX "BankReconciliationBankLineAllocation_tenantId_bankStatementLine" RENAME TO "BankReconciliationBankLineAllocation_tenantId_bankStatement_idx";',
    reason: 'PostgreSQL truncated both the (tenantId, bankStatementLineId) index and the (tenantId, bankStatementLineId) foreign key to the same 63-character name. PostgreSQL keeps index and constraint names in separate namespaces, but Prisma requires them to be unique per model, so the schema maps the foreign key and leaves the index on its default name.',
  },
]

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js')

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer().on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolvePort(port))
  })
})

export function diffStatements(script) {
  return String(script || '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
}

export function classifyDrift(statements, allowed = ALLOWED_DRIFT) {
  const allowedStatements = new Set(allowed.map((entry) => entry.statement))
  const present = new Set(statements)
  return {
    unexpected: statements.filter((statement) => !allowedStatements.has(statement)),
    stale: allowed.filter((entry) => !present.has(entry.statement)),
  }
}

const plural = (count, one, many) => (count === 1 ? one : many)

async function migratedDiffScript() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const port = await freePort()
  const user = 'flowchain_schema_drift'
  const password = `schema-drift-${randomUUID()}`
  const database = 'flowchain_schema_drift'
  const directory = await mkdtemp(join(tmpdir(), 'flowchain-schema-drift-'))
  const databaseDir = join(directory, 'pg')
  const diffPath = join(directory, 'diff.sql')
  const url = `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`
  const env = { ...process.env, DATABASE_URL: url }
  const prisma = (args) => execFileAsync(process.execPath, [prismaCli, ...args], { cwd: root, env, maxBuffer: 30 * 1024 * 1024 })
  await mkdir(databaseDir)
  const pg = new EmbeddedPostgres({ databaseDir, user, password, port, persistent: false, onLog: () => {}, onError: () => {} })

  try {
    await pg.initialise()
    await pg.start()
    await pg.createDatabase(database)
    await prisma(['migrate', 'deploy'])
    await prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script', '--output', diffPath])
    return await readFile(diffPath, 'utf8')
  } catch (error) {
    process.stdout.write(error.stdout || '')
    process.stderr.write(error.stderr || '')
    throw error
  } finally {
    await pg.stop().catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

async function main({ printFullDiff }) {
  const script = await migratedDiffScript()
  if (printFullDiff) process.stdout.write(`${script.trim()}\n\n`)

  const statements = diffStatements(script)
  const { unexpected, stale } = classifyDrift(statements)
  if (!unexpected.length && !stale.length) {
    console.log(`prisma/schema.prisma matches prisma/migrations (${statements.length} allowed ${plural(statements.length, 'statement', 'statements')}).`)
    return true
  }
  if (unexpected.length) {
    console.error(`prisma/schema.prisma has drifted from prisma/migrations. Making a migrated database match the schema would run ${unexpected.length} unexpected ${plural(unexpected.length, 'statement', 'statements')}:\n`)
    for (const statement of unexpected) console.error(`  ${statement}`)
    console.error('\nUpdate schema.prisma to describe what the migrations create, or add a migration if the database itself is wrong.')
    console.error('Add an ALLOWED_DRIFT entry in scripts/check-prisma-schema-drift.mjs only for objects Prisma cannot express.')
  }
  if (stale.length) {
    console.error(`\n${stale.length} ALLOWED_DRIFT ${plural(stale.length, 'entry no longer appears', 'entries no longer appear')} in the diff. Remove ${plural(stale.length, 'it', 'them')}:\n`)
    for (const entry of stale) console.error(`  ${entry.statement}`)
  }
  return false
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let ok = false
  try {
    ok = await main({ printFullDiff: process.argv.includes('--print') })
  } catch (error) {
    console.error(error)
  }
  // embedded-postgres installs an exit hook that exits with code 0 on
  // beforeExit, so set the exit code explicitly.
  process.exit(ok ? 0 : 1)
}
