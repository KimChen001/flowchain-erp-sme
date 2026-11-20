// The supplier replies a person dismissed as "wrong reading", as draft cases
// for the supplier reply set (docs/supplier-reply-dates-design.md §7
// "Afterwards"; the assistant's 👎 answers have scripts/assistant-feedback-cases.mjs).
//
//   node scripts/supplier-reply-draft-cases.mjs [--tenant=<id>] [--out=drafts.json]
//
// Reads DATABASE_URL. Without --tenant, every public-data workspace (UCI, M5)
// in that database; a workspace that is not public data is refused (DD-7).
// Prints one block per reply: the order, the reply date, the note, what the
// checks made of each line and the start of the reply; with --out, also
// writes the drafts (tests/ai-eval/supplier-reply/wrong-reading-drafts.mjs)
// to fill in by hand and move into a batch. Reads only; calls no model.
import { writeFileSync } from 'node:fs'
import { publicDataNoteSummary } from '../server/domain/public-data-note.mjs'
import { disconnectPrismaClient, getPrismaClient } from '../server/persistence/prisma-client.mjs'
import { supplierReplyLineOutcomes } from '../server/services/supplier-reply-export.mjs'
import { supplierReplyWrongReadingDrafts } from '../tests/ai-eval/supplier-reply/wrong-reading-drafts.mjs'

const args = process.argv.slice(2)
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null
const tenantArg = option('tenant')
const out = option('out')
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the workspace database first.')
  process.exit(1)
}

const NOTE = { namespace: 'workspace.public-data', recordKey: 'note' }
const prisma = await getPrismaClient(process.env)
try {
  const notes = await prisma.runtimeRecord.findMany({ where: { ...NOTE, ...(tenantArg ? { tenantId: tenantArg } : {}) }, select: { tenantId: true, payload: true } })
  const workspaces = notes.map((row) => ({ tenantId: row.tenantId, dataset: publicDataNoteSummary(row.payload)?.dataset || null })).filter((row) => row.dataset)
  if (tenantArg && !workspaces.length) {
    console.error(`Workspace ${tenantArg} is not a public-data workspace: draft cases come from UCI or M5 workspaces only.`)
    process.exitCode = 1
  } else {
    const drafts = []
    for (const { tenantId, dataset } of workspaces) {
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } })
      const replies = await prisma.supplierReply.findMany({
        where: { tenantId, state: 'not_recorded', reasonCode: 'wrong_reading' },
        orderBy: [{ receivedOn: 'asc' }, { id: 'asc' }],
        select: { id: true, purchaseOrderId: true, receivedOn: true, createdAt: true, text: true, quotedText: true, quotedTextHidden: true, state: true, reasonCode: true, note: true, decidedAt: true, readingStatus: true, provider: true, model: true, promptVersion: true, reading: true, check: true },
      })
      const orderIds = [...new Set(replies.map((row) => row.purchaseOrderId))]
      const orders = orderIds.length ? await prisma.purchaseOrder.findMany({
        where: { tenantId, id: { in: orderIds } },
        select: { id: true, number: true, supplierName: true, status: true, expectedDate: true, lines: { orderBy: { id: 'asc' }, select: { id: true, sku: true, itemName: true, unit: true, orderedQuantity: true, receivedQuantity: true, metadata: true } } },
      }) : []
      const byId = new Map(orders.map((row) => [row.id, { ...row, expectedDay: row.expectedDate ? new Date(row.expectedDate).toISOString().slice(0, 10) : null }]))
      drafts.push(...supplierReplyWrongReadingDrafts({ replies, orders: byId, dataset, timeZone: tenant?.timezone || undefined }))
    }
    for (const draft of drafts) {
      console.log(`\n## ${draft.id} (${draft.lang}, ${draft.workspace})`)
      console.log(`Order ${draft.order.number}, reply of ${draft.replyDate}, pasted ${draft.today}`)
      if (draft.draft.note) console.log(`Note: ${draft.draft.note}`)
      console.log(`Read: ${draft.draft.readingStatus}${draft.draft.check ? `; ${supplierReplyLineOutcomes(draft.draft.check) || 'no lines'}` : ''}`)
      const reply = String(draft.replyText || '').replace(/\s+/g, ' ')
      console.log(`Reply: ${reply.slice(0, 300)}${reply.length > 300 ? '…' : ''}`)
    }
    console.log(`\n${drafts.length} wrong reading${drafts.length === 1 ? '' : 's'} from ${workspaces.length} public-data workspace${workspaces.length === 1 ? '' : 's'}.`)
    if (out) {
      writeFileSync(out, `${JSON.stringify(drafts, null, 2)}\n`, 'utf8')
      console.log(`Drafts written to ${out}: fill in "about", "covers" and "expected", drop "draft", and move each into a batch.`)
    }
  }
} finally {
  await disconnectPrismaClient()
}
