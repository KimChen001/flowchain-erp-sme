import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { A, Card, Field, inputStyle } from '../../components/ui';
import { FormActionBar, FormHeader, FormSection, focusFirstInvalid, formGridClass, useFormCopy } from '../../components/ui/formLayout';
import { FocusFirstField } from "../../components/ui/FocusFirstField";
import { useI18n } from '../../i18n/I18n';
import { supplierCopy } from './supplierCopy';
import { orderedCurrencyCodes } from '../../lib/currencyOptions';

// The supplier form follows the form standard (components/ui/formLayout.tsx).
// A workspace payment term: its code is what the form stores. A supplier
// imported from a file may hold the term's row id (recordId) instead.
export type PaymentTermOption = { id: string; label: string; recordId?: string | null };
type Props = { form: Record<string, any>; editing: boolean; saving: boolean; errors: Array<{ field?: string; message?: string }>; currencyWarning: boolean; workspaceCurrency?: string; paymentTerms?: PaymentTermOption[] | null; onChange: (key: string, value: string) => void; onSave: () => void; onCancel: () => void };
const basic = [['supplierCode', 'Supplier code'], ['supplierName', 'Supplier name'], ['shortName', 'Short name'], ['businessType', 'Business type'], ['categories', 'Categories']];
const contact = [['contactName', 'Contact name'], ['telephone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['postalCode', 'Postal / ZIP code']];
const commercial = [['defaultCurrency', 'Default currency'], ['paymentTermsId', 'Payment terms'], ['deliveryCycleDays', 'Delivery lead time (days)'], ['settlementMethod', 'Settlement method']];
const tax = [['creditCode', 'Business registration ID'], ['taxIdentificationNumber', 'Tax ID'], ['bankName', 'Bank name'], ['bankAccountName', 'Account holder'], ['bankAccountNumber', 'Account number']];
const REQUIRED = ['supplierCode', 'supplierName', 'defaultCurrency'];
const WIDE = ['address', 'categories'];

export function SupplierForm({ form, editing, saving, errors, currencyWarning, workspaceCurrency, paymentTerms, onChange, onSave, onCancel }: Props) {
  const { language } = useI18n();
  const t = (value: string) => supplierCopy(value, language);
  const formCopy = useFormCopy();
  const formRef = useRef<HTMLFormElement>(null);
  // Focus moves to the first field with a message after a save, not while
  // the person types (typing clears that field's message).
  const saveTried = useRef(false);
  useEffect(() => {
    if (!saveTried.current || !errors.length) return;
    saveTried.current = false;
    if (errors.some(error => error.field)) focusFirstInvalid(formRef.current);
  }, [errors]);
  const save = () => { saveTried.current = true; onSave(); };
  // The empty choice means "not recorded"; a stored term that is not among
  // the workspace's terms (or the terms could not load) stays selectable.
  const stored = String(form.paymentTermsId ?? '');
  const termOptions = (paymentTerms || []).map(term => (stored && term.recordId === stored ? { ...term, id: stored } : term));
  if (stored && !termOptions.some(term => term.id === stored)) termOptions.push({ id: stored, label: stored });
  const hints: Record<string, string> = {
    supplierCode: 'Use a unique code, such as SUP-001.',
    categories: 'Separate categories with commas.',
    paymentTermsId: paymentTerms === null ? 'Could not load the workspace payment terms. The stored term is kept.' : 'Leave empty when the term is not agreed yet.',
  };
  function field([key, label]: string[]) {
    const error = errors.find(item => item.field === key);
    const props = { id: `supplier-${key}`, value: form[key] ?? '', onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(key, event.target.value), style: inputStyle };
    const control = key === 'defaultCurrency'
      ? <select {...props}><option value="">{t('Choose currency')}</option>{orderedCurrencyCodes(workspaceCurrency, null, form.defaultCurrency).map(code => <option key={code} value={code}>{code}</option>)}</select>
      : key === 'paymentTermsId'
        ? <select {...props}><option value="">{t('Not recorded')}</option>{termOptions.map(term => <option key={term.id} value={term.id}>{term.label === term.id ? term.id : `${term.label} (${term.id})`}</option>)}</select>
        : <input {...props} type={key === 'email' ? 'email' : key === 'telephone' ? 'tel' : key === 'deliveryCycleDays' ? 'number' : 'text'} min={key === 'deliveryCycleDays' ? 0 : undefined} step={key === 'deliveryCycleDays' ? 1 : undefined} maxLength={500} />;
    return <div key={key} className={WIDE.includes(key) ? 'md:col-span-2' : ''}>
      <Field label={t(label)} required={REQUIRED.includes(key)} error={error ? t(error.message || 'Check the highlighted fields.') : null} hint={hints[key] ? t(hints[key]) : undefined}>{control}</Field>
    </div>;
  }
  const status = <Field key="status" label={t('Status')}>
    <select id="supplier-status" style={inputStyle} value={form.status} onChange={event => onChange('status', event.target.value)}>{[['active', 'Active'], ['draft', 'Draft'], ['inactive', 'Inactive']].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
  </Field>;
  // Messages with no field of their own (a lost connection, a refusal) sit in
  // the action bar.
  const formErrors = errors.filter(error => !error.field);
  const fieldErrors = errors.some(error => error.field);
  const message = formErrors.length || fieldErrors ? <>
    {fieldErrors && <div>{formCopy('checkFields')}</div>}
    {formErrors.map((error, index) => <div key={index}>{t(error.message || 'Could not save supplier. Please try again.')}</div>)}
  </> : null;
  return <form ref={formRef} noValidate data-testid="supplier-form" onSubmit={event => { event.preventDefault(); save(); }} className="space-y-5">
    <FocusFirstField />
    <FormHeader title={t(editing ? 'Edit supplier' : 'New supplier')} intro={t('Start with the essentials. Add contact and commercial details when available.')}>
      {currencyWarning && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">{t('Could not load workspace currency. Choose a currency before saving.')}</p>}
    </FormHeader>
    <fieldset disabled={saving} className="space-y-5">
      <FormSection title={t('Basic information')}><div className={formGridClass}>{basic.map(field)}{status}</div></FormSection>
      <FormSection title={t('Contact and address')}><div className={formGridClass}>{contact.map(field)}</div></FormSection>
      <FormSection title={t('Commercial terms')}><div className={formGridClass}>{commercial.map(field)}</div></FormSection>
      <Card className="p-4 sm:p-5">
        <details>
          <summary className="flex cursor-pointer list-none items-center gap-2"><ChevronDown size={16} style={{ color: A.sub }} /><h2 className="fc-section-title" style={{ color: A.label }}>{t('Tax and bank details')}</h2></summary>
          <p className="mt-1 text-xs" style={{ color: A.sub }}>{t('Tax identifiers depend on the supplier’s country.')}</p>
          <div className={`mt-4 ${formGridClass}`}>{tax.map(field)}</div>
        </details>
      </Card>
      <FormSection title={t('Internal notes')}>
        <textarea id="supplier-notes" aria-label={t('Internal notes')} style={{ ...inputStyle, resize: 'vertical' }} rows={3} maxLength={4000} value={form.internalComment || ''} onChange={event => onChange('internalComment', event.target.value)} />
      </FormSection>
    </fieldset>
    <FormActionBar onCancel={onCancel} submit={{ label: t('Save supplier'), onClick: save, busy: saving, testId: 'supplier-save' }} message={message} messageTestId="supplier-form-errors" />
  </form>;
}
