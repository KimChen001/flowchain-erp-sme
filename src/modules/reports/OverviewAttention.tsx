import { ArrowUpRight, ClipboardList, PackageSearch, Truck } from 'lucide-react';
import type { GovernedReport } from './governedReports';

export function OverviewAttention({ items, copy, onDrill }: { items: NonNullable<GovernedReport['attention']>; copy: (value: string) => string; onDrill: (path: string) => void }) {
  const icons = [Truck, PackageSearch, ClipboardList];
  return <section className="rounded-2xl border border-slate-200 bg-white p-5" data-testid="overview-attention">
    <h2 className="text-base font-semibold text-slate-900">{copy('Needs attention')}</h2>
    <p className="mt-1 text-xs text-slate-500">{copy('Counts use the current filters. Select a card to review the source records.')}</p>
    <div className="mt-4 grid gap-3 md:grid-cols-3">{items.map((item, index) => {
      const Icon = icons[index % icons.length];
      return <button key={item.id} onClick={() => onDrill(item.path)} className="group rounded-xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-blue-300 hover:bg-blue-50">
        <div className="flex items-center justify-between"><Icon size={18} className={item.count ? 'text-amber-600' : 'text-slate-400'} /><ArrowUpRight size={16} className="text-slate-400 group-hover:text-blue-600" /></div>
        <div className="mt-3 flex items-baseline gap-3"><span className="text-2xl font-semibold tabular-nums text-slate-900">{item.count}</span><span className="text-sm text-slate-600">{copy(item.label)}</span></div>
        <div className="mt-3 text-xs font-medium text-blue-600">{copy(item.action)}</div>
      </button>;
    })}</div>
  </section>;
}
