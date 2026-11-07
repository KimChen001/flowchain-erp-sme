// Seeds one public data workspace from the local extract:
//
//   node scripts/public-data/seed-cli.mjs --dataset=m5|uci [--extract=<file>] [--as-of=YYYY-MM-DD] [--last-days=N] [--if-empty]
//
// --if-empty skips a workspace that already has items instead of failing.
//
// The workspace is FLOWCHAIN_DEFAULT_TENANT_ID in DATABASE_URL; provision it
// first (scripts/setup-pilot-workspace.mjs). The extract defaults to
// FLOWCHAIN_PUBLIC_DATA_EXTRACT, else ~/flowchain-data/public-data-extract.json.
// The seed day defaults to today in the dataset's timezone, so the last day of
// the data is yesterday. Local development only.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { disconnectPrismaClient, getPrismaClient } from '../../server/persistence/prisma-client.mjs'
import { assertLocalDevelopment } from '../../server/domain/local-development-contract.mjs'
import { localCalendarDay, parseAsOf } from '../seed-history.mjs'
import { PUBLIC_DATA_WORKSPACE_DATASETS, buildPublicDataPlan, readPublicDataExtract } from './plan.mjs'
import { seedPublicData } from './seed.mjs'

export const defaultPublicDataExtractPath = (env = process.env) => env.FLOWCHAIN_PUBLIC_DATA_EXTRACT || join(homedir(), 'flowchain-data', 'public-data-extract.json')

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=')
  return [key, rest.join('=') || 'true']
}))
assertLocalDevelopment(process.env, 'public data seed')
const dataset = String(args.dataset || '').trim()
const profile = PUBLIC_DATA_WORKSPACE_DATASETS[dataset]
if (!profile) {
  console.error('[public-data] --dataset=m5 or --dataset=uci is required.')
  process.exit(1)
}
let extract
try {
  extract = readPublicDataExtract(args.extract || defaultPublicDataExtractPath())
} catch (error) {
  console.error(`[public-data] ${error.message}`)
  process.exit(1)
}
const seedDay = args['as-of'] ? parseAsOf(args['as-of'], profile.timezone) : localCalendarDay(new Date(), profile.timezone)
const plan = buildPublicDataPlan(extract, dataset, { seedDay, lastDays: args['last-days'] ? Number(args['last-days']) : null })
const prisma = await getPrismaClient(process.env)
try {
  const tenantId = String(process.env.FLOWCHAIN_DEFAULT_TENANT_ID || profile.tenantId).trim()
  if (args['if-empty'] && await prisma.item.findFirst({ where: { tenantId }, select: { id: true } })) {
    console.log(`[public-data] ${tenantId} already has items; not seeding it again.`)
    process.exit(0)
  }
  const result = await seedPublicData(prisma, process.env, { plan, log: (line) => console.log(`[public-data] ${line}`) })
  if (result.scene) console.log(`[public-data] ${dataset} scene: ${JSON.stringify(result.scene)}`)
  console.log(`[public-data] ${dataset} ready in ${result.seconds} s (as of ${result.seedDay}, data ${plan.sourceWindow.first}..${plan.sourceWindow.last} moved ${plan.shiftDays} days): ${Object.entries(result.counts).map(([name, count]) => `${name}=${count}`).join(' ')}`)
} finally {
  await disconnectPrismaClient()
}
