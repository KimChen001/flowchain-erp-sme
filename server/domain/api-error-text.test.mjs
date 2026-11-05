import test from 'node:test'
import assert from 'node:assert/strict'
import { apiErrorText, apiErrorView } from '../../src/lib/apiErrorText.ts'

const fallback = ['Could not load this page. Try again.', '页面加载失败，请重试。']
const failure = (status, code, message = 'Supplier invoice was not found in tenant t1.') => Object.assign(new Error(message), { status, code })

test('a failed request reads in the interface language, never as the server message', () => {
  // Known codes and statuses have shared words; the code stays for the tooltip.
  assert.deepEqual(apiErrorView(failure(404, 'SUPPLIER_INVOICE_NOT_FOUND'), 'en-US', fallback), { message: 'This record was not found. It may have been removed.', code: 'SUPPLIER_INVOICE_NOT_FOUND' })
  assert.equal(apiErrorText(failure(404, 'SUPPLIER_INVOICE_NOT_FOUND'), 'zh-CN', fallback), '未找到该记录，可能已被删除。')
  assert.equal(apiErrorText(failure(401, 'AUTHENTICATION_REQUIRED'), 'en-US', fallback), 'Your session has expired. Sign in again to continue.')
  assert.equal(apiErrorText(failure(403, 'PERMISSION_DENIED'), 'zh-CN', fallback), '你的角色无权查看或修改此内容。')
  assert.equal(apiErrorText(failure(409, 'DUPLICATE_SKU'), 'en-US', fallback), 'This code or number is already in use. Choose another.')
  assert.equal(apiErrorText(failure(409, 'SALES_ORDER_VERSION_CONFLICT'), 'zh-CN', fallback), '该记录已被他人修改，请刷新后重试。')
  // A 409 that names its own rule is not called a concurrent change.
  assert.equal(apiErrorText(failure(409, 'SETTLEMENT_SELF_APPROVAL_BLOCKED'), 'en-US', fallback), fallback[0])
  // The page's own codes come first.
  assert.equal(apiErrorText(failure(409, 'SETTLEMENT_SELF_APPROVAL_BLOCKED'), 'zh-CN', fallback, { SETTLEMENT_SELF_APPROVAL_BLOCKED: ['Ask another approver.', '请由其他审批人批准。'] }), '请由其他审批人批准。')
  // Anything else is the page's generic message; the server's English is never shown.
  const unknown = apiErrorView(failure(400, 'SOMETHING_ODD', 'Internal detail'), 'zh-CN', fallback)
  assert.deepEqual(unknown, { message: '页面加载失败，请重试。', code: 'SOMETHING_ODD' })
  assert.deepEqual(apiErrorView(failure(500, undefined), 'en-US', fallback), { message: fallback[0], code: 'HTTP 500' })
  assert.equal(apiErrorText(new TypeError('Failed to fetch'), 'en-US', fallback), 'Could not connect. Check your connection and try again.')
  assert.equal(apiErrorText('not an error', 'en-US', fallback), fallback[0])
})
