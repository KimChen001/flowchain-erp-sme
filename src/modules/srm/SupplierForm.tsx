import { Building2, Check, ChevronDown } from 'lucide-react';
import { useI18n } from '../../i18n/I18n';
import { supplierCopy } from './supplierCopy';

type Props = { form: Record<string, any>; editing: boolean; saving: boolean; errors: Array<{ field?: string; message?: string }>; currencyWarning: boolean; onChange: (key: string, value: string) => void; onSave: () => void; onCancel: () => void };
const basic = [['supplierCode', 'Supplier code'], ['supplierName', 'Supplier name'], ['shortName', 'Short name'], ['businessType', 'Business type'], ['categories', 'Categories']];
const contact = [['contactName', 'Contact name'], ['telephone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['postalCode', 'Postal / ZIP code']];
const commercial = [['defaultCurrency', 'Default currency'], ['paymentTermsId', 'Payment terms'], ['deliveryCycleDays', 'Delivery lead time (days)'], ['settlementMethod', 'Settlement method']];
const tax = [['creditCode', 'Business registration ID'], ['taxIdentificationNumber', 'Tax ID'], ['bankName', 'Bank name'], ['bankAccountName', 'Account holder'], ['bankAccountNumber', 'Account number']];
const control = 'mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50';

export function SupplierForm({ form, editing, saving, errors, currencyWarning, onChange, onSave, onCancel }: Props) {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  function field([key, label]: string[]) {
    const required = ['supplierCode', 'supplierName', 'defaultCurrency'].includes(key);
    const error = errors.find(item => item.field === key);
    const props = { id: `supplier-${key}`, 'aria-label': t(label), 'aria-invalid': !!error, 'aria-describedby': error ? `supplier-error-${key}` : undefined, required, value: form[key] ?? '', onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(key, event.target.value), className: control };
    return <div key={key} className={key === 'address' || key === 'categories' ? 'md:col-span-2' : ''}>
      <label htmlFor={props.id} className="text-sm font-medium text-slate-600">{t(label)}{required && <span className="ml-1 text-blue-600">*</span>}</label>
      {key === 'defaultCurrency' ? <select {...props}><option value="">{t('Choose currency')}</option>{[...new Set(['USD', 'EUR', 'GBP', 'CAD', 'CNY', ...Intl.supportedValuesOf('currency'), form.defaultCurrency].filter(Boolean))].map(code => <option key={code} value={code}>{code}</option>)}</select> : <input {...props} type={key === 'email' ? 'email' : key === 'telephone' ? 'tel' : key === 'deliveryCycleDays' ? 'number' : 'text'} min={key === 'deliveryCycleDays' ? 0 : undefined} step={key === 'deliveryCycleDays' ? 1 : undefined} maxLength={key === 'internalComment' ? 4000 : 500} />}
      {error && <p id={`supplier-error-${key}`} className="mt-1 text-xs text-red-600">{t(error.message || 'Check the highlighted fields.')}</p>}
      {key === 'supplierCode' && <p className="mt-1 text-xs text-slate-500">{t('Use a unique code, such as SUP-001.')}</p>}
      {key === 'categories' && <p className="mt-1 text-xs text-slate-500">{t('Separate categories with commas.')}</p>}
    </div>;
  }
  const section = (title: string, fields: string[][]) => <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-base font-semibold text-slate-900">{t(title)}</h2><div className="mt-4 grid gap-x-5 gap-y-4 md:grid-cols-2">{fields.map(field)}{title === 'Basic information' && <div><label htmlFor="supplier-status" className="text-sm font-medium text-slate-600">{t('Status')}</label><select id="supplier-status" aria-label={t('Status')} className={control} value={form.status} onChange={event => onChange('status', event.target.value)}>{[['active', 'Active'], ['draft', 'Draft'], ['inactive', 'Inactive']].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></div>}</div></section>;
  return <form noValidate data-testid="supplier-form" onSubmit={event => { event.preventDefault(); onSave(); }} className="mx-auto max-w-5xl space-y-4">
    <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-5"><Building2 className="mt-1 text-blue-600" size={24} /><div><h1 className="text-xl font-semibold text-slate-900">{t(editing ? 'Edit supplier' : 'New supplier')}</h1><p className="mt-1 text-sm text-slate-600">{t('Start with the essentials. Add contact and commercial details when available.')}</p><p className="mt-2 text-xs text-slate-500">* {t('Required fields')}</p></div></div>
    {errors.length > 0 && <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{t('Check the highlighted fields.')}{errors.filter(error => !error.field).map((error, index) => <p key={index}>{t(error.message || 'Could not save supplier. Please try again.')}</p>)}</div>}
    {currencyWarning && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('Could not load workspace currency. Choose a currency before saving.')}</p>}
    <fieldset disabled={saving} className="space-y-4">
      {section('Basic information', basic)}
      {section('Contact and address', contact)}
      {section('Commercial terms', commercial)}
      <details className="rounded-xl border border-slate-200 bg-white p-5"><summary className="flex cursor-pointer items-center gap-2 text-base font-semibold text-slate-900"><ChevronDown size={16} />{t('Tax and bank details')}<span className="ml-auto text-xs font-normal text-slate-500">{t('Optional')}</span></summary><p className="mt-3 text-sm text-slate-500">{t('Tax identifiers depend on the supplier’s country.')}</p><div className="mt-4 grid gap-4 md:grid-cols-2">{tax.map(field)}</div></details>
      <section className="rounded-xl border border-slate-200 bg-white p-5"><label htmlFor="supplier-notes" className="text-sm font-medium text-slate-600">{t('Internal notes')}</label><textarea id="supplier-notes" className={control} rows={3} maxLength={4000} value={form.internalComment || ''} onChange={event => onChange('internalComment', event.target.value)} /></section>
    </fieldset>
    <div className="sticky bottom-20 z-10 flex items-center justify-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><button type="button" disabled={saving} onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-600">{t('Cancel')}</button><button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Check size={16} />{t(saving ? 'Saving…' : 'Save supplier')}</button></div>
  </form>;
}
