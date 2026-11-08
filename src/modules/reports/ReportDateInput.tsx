import { useEffect, useState } from 'react';
import { analyticsCopy } from './analyticsCopy';

export function ReportDateInput({ label, value, language, onChange, className = "mt-1 h-8 w-full" }: { label: string; value: string; language: string; onChange: (value: string) => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = (date: string) => !date || (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date);
  return <input aria-label={label} placeholder="YYYY-MM-DD" type="text" inputMode="numeric" maxLength={10} value={draft}
    onChange={event => { const next = event.target.value; setDraft(next); event.target.setCustomValidity(valid(next) ? '' : analyticsCopy('Dates must use YYYY-MM-DD.', language)); if (valid(next)) onChange(next); }}
    onBlur={event => event.target.reportValidity()} className={`${className} rounded-lg bg-slate-50 px-2`} />;
}
