import { Copy, Eye } from "lucide-react";
import { A, Chip } from "../../components/ui";
import { BusinessEntityLink } from "../../components/business/BusinessEntityLink";
import type { CustomerMaster, PrintTemplateCatalogItem } from "./standardData";
import { orNotProvided, useMasterDataCopy } from "./masterDataCopy";

function creditStyle(status: string) {
  if (status === "正常") return { color: A.green, bg: "#f0faf4" };
  if (status === "受限") return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}

export function CustomerTable({ customers }: { customers: CustomerMaster[] }) {
  const { copy } = useMasterDataCopy();
  if (customers.length === 0) return <div className="px-6 py-12 text-center text-sm text-slate-500">{copy("No customers yet. Create or import customers to continue.")}</div>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-xs"><thead><tr>{["Customer code", "Customer name", "Contact", "Phone", "Address", "Credit status", "Payment terms", "Status", "Actions"].map((item) => <th key={item} className="px-4 py-3 text-left" style={{ color: A.gray1 }}>{copy(item)}</th>)}</tr></thead><tbody>{customers.map((item) => {
    const credit = creditStyle(item.creditStatus);
    return <tr key={item.code} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-4 py-3 font-semibold"><BusinessEntityLink entityType="customer" entityId={item.code}>{item.code}</BusinessEntityLink></td><td className="px-4 py-3 font-medium"><BusinessEntityLink entityType="customer" entityId={item.code}>{item.name}</BusinessEntityLink></td><td className="px-4 py-3">{orNotProvided(item.contact)}</td><td className="px-4 py-3">{orNotProvided(item.phone)}</td><td className="px-4 py-3 max-w-[260px] truncate">{orNotProvided(item.address)}</td><td className="px-4 py-3">{item.creditStatus ? <Chip label={item.creditStatus} color={credit.color} bg={credit.bg} /> : orNotProvided(item.creditStatus)}</td><td className="px-4 py-3">{orNotProvided(item.paymentTerms)}</td><td className="px-4 py-3"><Chip label={item.status} color={item.status === "停用" ? A.red : A.green} bg={item.status === "停用" ? "#fff1f0" : "#f0faf4"} /></td><td className="px-4 py-3"><BusinessEntityLink entityType="customer" entityId={item.code} className="rounded-md bg-slate-100 px-2.5 py-1.5">{copy("View details")}</BusinessEntityLink></td></tr>;
  })}</tbody></table></div>;
}

export function PrintTemplateTable({ templates, onCopy }: { templates: PrintTemplateCatalogItem[]; onCopy: (item: PrintTemplateCatalogItem) => void }) {
  const { copy, locale } = useMasterDataCopy();
  const updated = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : value; };
  return <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-xs"><thead><tr>{["Template name", "Document type", "Default", "Last updated", "Actions"].map((item) => <th key={item} className="px-4 py-3 text-left" style={{ color: A.gray1 }}>{copy(item)}</th>)}</tr></thead><tbody>{templates.map((item) => {
    const name = item.copyOf ? copy("{name} (copy)", { name: copy(item.copyOf) }) : copy(item.name);
    return <tr key={item.id} style={{ borderTop: `1px solid ${A.border}` }}><td className="px-4 py-3 font-semibold" style={{ color: A.label }}>{name}</td><td className="px-4 py-3">{copy(item.documentType)}</td><td className="px-4 py-3"><Chip label={copy(item.isDefault ? "Default" : "Custom")} color={item.isDefault ? A.green : A.blue} bg={item.isDefault ? "#f0faf4" : "#f0f6ff"} /></td><td className="px-4 py-3">{updated(item.updatedAt)}</td><td className="px-4 py-3"><div className="flex gap-2"><button onClick={() => onCopy(item)} className="px-2.5 py-1.5 rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.label }}><Copy size={12} />{copy("Copy template")}</button><details className="relative"><summary className="list-none cursor-pointer px-2.5 py-1.5 rounded-md flex items-center gap-1" style={{ background: A.gray6, color: A.label }}><Eye size={12} />{copy("Preview")}</summary><div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border bg-white p-3 shadow-lg"><div className="font-semibold">{name}</div><div className="mt-2 text-slate-500">{copy("Document type: {value}", { value: copy(item.documentType) })}</div><div className="mt-1 text-slate-500">{copy("Updated: {value}", { value: updated(item.updatedAt) })}</div></div></details></div></td></tr>;
  })}</tbody></table></div>;
}
