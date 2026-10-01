// The currency a report row is in: an ISO 4217 code the runtime supports, or
// '' when none is stored or it is not a real code. Never a guess.
const ISO_CURRENCY_CODE = /^[A-Z]{3}$/
const supportedCurrencyCodes = new Set(Intl.supportedValuesOf?.('currency') || ['CNY', 'USD', 'EUR'])

export function reportCurrencyCode(value) {
  const code = String(value ?? '').trim().toUpperCase()
  return ISO_CURRENCY_CODE.test(code) && supportedCurrencyCodes.has(code) ? code : ''
}
