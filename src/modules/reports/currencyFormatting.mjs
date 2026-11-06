const ISO_CURRENCY_CODE = /^[A-Z]{3}$/

// Numbers and currency follow the workspace locale (a business setting),
// the unit words follow the interface language. English is the product
// default when a caller passes neither.
export function formatMetric(value, unit, currencyCode = null, { locale = 'en-US', language = 'en-US' } = {}) {
  const zh = language === 'zh-CN'
  if (value === null) return '—'
  if (unit === 'currency') {
    if (!currencyCode || !ISO_CURRENCY_CODE.test(currencyCode)) return zh ? '请选择币种' : 'Choose a currency'
    // The app's money format: the currency's own decimals ($79,692.50), as
    // on the document lists. Only compact chart axes round.
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(value)
  }
  if (unit === 'percentage') return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`
  if (unit === 'days') return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} ${zh ? '天' : 'days'}`
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
}