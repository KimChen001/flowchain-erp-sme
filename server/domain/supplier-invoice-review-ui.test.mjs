import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { matchStatusAfterReview, MATCH_VARIANCE_APPROVED } from './operational-finance-command-service.mjs'

// Round 7 of the UI review, finance: a match whose every difference is
// approved stops reading as an open variance; one decision closes a price
// difference and the amount difference it causes; the review, payment and
// invoice forms follow the form standard; a bill opened from an order with
// several receipts starts on the right one.

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
let loaded

async function load(entry) {
  loaded ||= (async () => {
    // Inside the checkout, so the externals resolve from its node_modules.
    await mkdir(path.resolve('node_modules/.cache'), { recursive: true })
    const dir = await mkdtemp(path.resolve('node_modules/.cache/flowchain-finance-review-'))
    const modules = {}
    for (const [name, file] of Object.entries({
      screens: 'src/modules/finance/SupplierInvoiceScreens.tsx',
      payments: 'src/modules/finance/PaymentRecords.tsx',
      variance: 'src/domain/procurement/variance-types.ts',
    })) {
      const outfile = path.join(dir, `${name}.mjs`)
      await build({
        entryPoints: [file], outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent',
        external: ['react', 'react-dom', 'react-router', 'lucide-react'],
      })
      modules[name] = await import(pathToFileURL(outfile).href)
    }
    return { modules, cleanup: () => rm(dir, { recursive: true, force: true }) }
  })()
  return (await loaded).modules[entry]
}

test.after(async () => {
  if (loaded) await (await loaded).cleanup()
})

test('a match is variance_approved once every exception on it is approved, and not before', () => {
  assert.equal(MATCH_VARIANCE_APPROVED, 'variance_approved')
  assert.equal(matchStatusAfterReview(['approved', 'approved']), 'variance_approved')
  assert.equal(matchStatusAfterReview(['approved']), 'variance_approved')
  assert.equal(matchStatusAfterReview(['approved', 'open']), null)
  assert.equal(matchStatusAfterReview(['approved', 'rejected']), null)
  assert.equal(matchStatusAfterReview([]), null)
  assert.equal(matchStatusAfterReview(undefined), null)
})

test('the review command records the resolved match on the match run and the invoice', () => {
  const source = read('server/domain/operational-finance-command-service.mjs')
  const review = source.slice(source.indexOf('async function reviewMatchException'), source.indexOf('async function previewReviewMatchException'))
  // The match row is locked, so two reviews of one match run in turn.
  assert.match(review, /lockTenantRow\(\s*tx,\s*"ThreeWayMatch"/)
  assert.match(review, /tx\.threeWayMatch\.update\(\{[\s\S]*?status: resolvedStatus/)
  // The invoice's match status changes; its own status and version do not.
  assert.match(review, /tx\.supplierInvoice\.updateMany\(\{[\s\S]*?matchStatus: "exception"[\s\S]*?data: \{ matchStatus: resolvedStatus \}/)
  assert.doesNotMatch(review, /supplierInvoice\.update(Many)?\(\{[\s\S]*?version: \{ increment/)
  // An empty resolution is refused with its own code and a sentence a person reads.
  assert.match(source, /MATCH_EXCEPTION_RESOLUTION_REQUIRED/)
  assert.doesNotMatch(source, /"resolution is required\."/)
})

test('match exception types read as differences in both languages', async () => {
  const { matchExceptionLabel } = await load('variance')
  assert.equal(matchExceptionLabel('price', 'en-US'), 'Price difference')
  assert.equal(matchExceptionLabel('quantity', 'en-US'), 'Quantity difference')
  assert.equal(matchExceptionLabel('amount', 'en-US'), 'Amount difference')
  assert.equal(matchExceptionLabel('price', 'zh-CN'), '价格差异')
  assert.equal(matchExceptionLabel('quantity', 'zh-CN'), '数量差异')
  assert.equal(matchExceptionLabel('amount', 'zh-CN'), '金额差异')
  // A variance code still reads as before; free text is shown as it is.
  assert.equal(matchExceptionLabel('price_variance', 'en-US'), 'Price variance')
  assert.equal(matchExceptionLabel('Freight surcharge', 'en-US'), 'Freight surcharge')
})

test('approving a price difference also approves the amount difference it alone causes', async () => {
  const { amountFollowingPrice, sortMatchExceptions, shownMatchStatus } = await load('screens')
  const lines = [{ id: 'L1', invoiceQuantity: '14.0000' }, { id: 'L2', invoiceQuantity: '5.0000' }]
  const price = { id: 'P1', matchLineId: 'L1', exceptionType: 'price', status: 'open', varianceValue: '0.1400', version: 0 }
  const amount = { id: 'A1', matchLineId: 'L1', exceptionType: 'amount', status: 'open', varianceValue: '1.9600', version: 0 }
  assert.equal(amountFollowingPrice(price, [amount, price], lines), amount)
  // An amount difference the price does not explain (a typed line total) stays its own decision.
  assert.equal(amountFollowingPrice(price, [{ ...amount, varianceValue: '2.5000' }, price], lines), null)
  // Another line's amount, an already reviewed one, or hidden figures: no link.
  assert.equal(amountFollowingPrice(price, [{ ...amount, matchLineId: 'L2' }, price], lines), null)
  assert.equal(amountFollowingPrice(price, [{ ...amount, status: 'approved' }, price], lines), null)
  assert.equal(amountFollowingPrice({ ...price, varianceValue: null }, [amount, price], lines), null)
  assert.equal(amountFollowingPrice({ ...price, status: 'rejected' }, [amount, price], lines), null)
  // Listed per line: quantity, price, then the amount it causes.
  const sorted = sortMatchExceptions([amount, { ...price }, { id: 'Q2', matchLineId: 'L2', exceptionType: 'quantity' }, { id: 'Q1', matchLineId: 'L1', exceptionType: 'quantity' }], ['L1', 'L2'])
  assert.deepEqual(sorted.map((entry) => entry.id), ['Q1', 'P1', 'A1', 'Q2'])
  // A match approved before the server recorded it still reads resolved.
  assert.equal(shownMatchStatus('exception', [{ status: 'approved' }, { status: 'approved' }]), 'variance_approved')
  assert.equal(shownMatchStatus('exception', [{ status: 'approved' }, { status: 'open' }]), 'exception')
  assert.equal(shownMatchStatus('exception', []), 'exception')
  assert.equal(shownMatchStatus('matched', []), 'matched')
})

test('a bill opened from an order with several receipts starts on the oldest one not yet invoiced', async () => {
  const { firstUnbilledReceipt } = await load('screens')
  // Entry data lists receipts newest first.
  const newer = { id: 'GRN-2', lines: [{ purchaseOrderLineId: 'POL-1', acceptedQuantity: '10.0000' }] }
  const older = { id: 'GRN-1', lines: [{ purchaseOrderLineId: 'POL-1', acceptedQuantity: '14.0000' }] }
  const order = (billed) => ({ lines: [{ id: 'POL-1', billedQuantity: billed }] })
  assert.equal(firstUnbilledReceipt(order('0'), [newer, older]), older)
  assert.equal(firstUnbilledReceipt(order('14.0000'), [newer, older]), newer)
  assert.equal(firstUnbilledReceipt(order('20.0000'), [newer, older]), newer)
  assert.equal(firstUnbilledReceipt(order('24.0000'), [newer, older]), null)
  // One receipt is chosen as before; none leaves the choice open.
  assert.equal(firstUnbilledReceipt(order('24.0000'), [older]), older)
  assert.equal(firstUnbilledReceipt(order('0'), []), null)
  assert.equal(firstUnbilledReceipt(null, [newer, older]), older)
})

test('the new invoice form never says "No receipt yet" above listed receipts and hints at a price above the PO', () => {
  const screens = read('src/modules/finance/SupplierInvoiceScreens.tsx')
  assert.match(screens, /receipts\.length \? t\("finance\.chooseReceipt"\) : poId \? t\("finance\.noReceiptYet"\)/)
  assert.match(screens, /receipts\.length \? t\("finance\.billWithoutReceipt"\) : t\("finance\.billBeforeReceipt"\)/)
  assert.match(screens, /aboveOrderPrice: \["\+\{amount\} above the PO price", "比采购单价高 \{amount\}"\]/)
  // Both line tables turn into cards on a phone, titled by the item.
  assert.equal((screens.match(/ref=\{listTableCardsRef\}/g) || []).length, 2)
  assert.equal((screens.match(/data-card-title/g) || []).length, 2)
  // Units go through unitLabel, never as stored.
  assert.doesNotMatch(screens, /\{line\.unit \|\| ""\}/)
  // The server's English summary of the match is not shown.
  assert.doesNotMatch(screens, /\{data\.match\.blockingReason\}/)
})

test('the invoice page shows its dates, payment state and next step, and returns to payables', () => {
  const screens = read('src/modules/finance/SupplierInvoiceScreens.tsx')
  for (const testId of ['supplier-invoice-date', 'supplier-invoice-due-date', 'supplier-invoice-currency-fact', 'supplier-invoice-next', 'back-to-payables']) assert.match(screens, new RegExp(`data-testid="${testId}"`))
  assert.match(screens, /\["settled", "partially_settled"\]\.includes\(payable\.status\) \? payable\.status : data\.status/)
  assert.match(screens, /money\(payable\.originalAmount \?\? data\.totalAmount/)
  const list = read('src/modules/finance/OperationalFinanceP2pWorkbench.tsx')
  assert.match(list, /\?returnTo=\$\{encodeURIComponent\(`\$\{location\.pathname\}\$\{location\.search\}`\)\}/)
  // The receipt reads by its GRN number, else "Receipt", never its id.
  assert.match(list, /row\.relatedGrnNumber \|\| receiptNumbers\.get\(String\(row\.relatedGrnId\)\) \|\| tr\("receipt"\)/)
  assert.doesNotMatch(list, />\{row\.relatedGrnId\}</)
  // An invoice whose differences are all approved no longer reads "Exception".
  assert.match(list, /statusOf\(row\) === "exception" && row\.matchStatus === "variance_approved" \? "variance_approved"/)
  assert.match(list, /variance_approved: "finance\.status\.variance_approved"/)
  // A match exception in the finance list reads by its kind of difference.
  assert.match(list, /matchExceptionLabel\(row\.exceptionType, language\)/)
})

test('review and payment panels follow the form standard', () => {
  const controls = read('src/modules/finance/FinanceControls.tsx')
  // Confirm works before Preview and is disabled only after a refused preview.
  assert.match(controls, /data-testid=\{`\$\{testId\}-confirm`\}[^\n]*disabled=\{busy \|\| Boolean\(plan && !plan\.allowed\)\}/)
  assert.match(controls, /<RequiredMark \/>/)
  assert.match(controls, /<FieldError id=\{reasonErrorId\}/)
  const screens = read('src/modules/finance/SupplierInvoiceScreens.tsx')
  assert.match(screens, /reasonRequired=\{say\("Enter why you accept this difference\.", "请填写处理说明。"\)\}/)
  assert.match(screens, /"Approving the price difference also accepts the amount difference it causes\."/)
  const payments = read('src/modules/finance/PaymentRecords.tsx')
  for (const label of ['finance.paymentDate', 'finance.paymentMethod']) assert.match(payments, new RegExp(`<Field label=\\{t\\("${label.replace('.', '\\.')}"\\)\\} required`))
  assert.match(payments, /useState<string>\("wire"\)/)
  assert.match(payments, /data-testid="payment-confirm"[^\n]*disabled=\{busy \|\| Boolean\(plan && !plan\.allowed\)\}/)
})

test('payment amounts are offered as the currency writes them', async () => {
  const { paymentAmountText } = await load('payments')
  assert.equal(paymentAmountText('19.6000', 'USD'), '19.60')
  assert.equal(paymentAmountText('90', 'GBP'), '90.00')
  assert.equal(paymentAmountText('1200', 'JPY'), '1200')
  // More decimals than the currency uses: kept, never rounded past what is owed.
  assert.equal(paymentAmountText('19.6050', 'USD'), '19.605')
  assert.equal(paymentAmountText(null, 'USD'), '')
})

test('the finance dictionary has the approved-variance status and the Chinese wording the walk asked for', () => {
  const dictionary = read('src/i18n/I18n.tsx')
  assert.match(dictionary, /"finance\.status\.variance_approved": "差异已批准"/)
  assert.match(dictionary, /"finance\.status\.variance_approved": "Variance approved"/)
  assert.match(dictionary, /"finance\.chooseReceipt": "选择收货单"/)
  assert.match(dictionary, /"finance\.chooseReceipt": "Choose a receipt"/)
  assert.match(dictionary, /"ai\.v2\.column\.position": "库存位置（含在途）"/)
  assert.doesNotMatch(dictionary, /库存头寸/)
  assert.match(dictionary, /"finance\.method\.wire": "Bank transfer"/)
})
