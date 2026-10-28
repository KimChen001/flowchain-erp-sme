import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Upload } from "lucide-react";
import { apiJson, AUTH_TOKEN_KEY } from "../../lib/api-client";
import { useDataImportCopy } from "./dataImportCopy";

export type DataImportType = "items" | "suppliers" | "customers" | "item-suppliers" | "opening-stock";

// The permission of the manual form for each record type; the server checks
// it again on every request.
export const DATA_IMPORT_PERMISSION: Record<DataImportType, string> = {
  items: "master_data.item.manage",
  "item-suppliers": "master_data.item.manage",
  suppliers: "master_data.supplier.manage",
  customers: "master_data.customer.manage",
  "opening-stock": "inventory.adjustment.create",
};

type Access = { enabled: boolean; permissions: Set<string> };
const NONE: Access = { enabled: false, permissions: new Set() };
// One read per session token, shared by every button on the page.
let cached: { token: string; access: Promise<Access> } | null = null;

function loadAccess(): Promise<Access> {
  const token = typeof window !== "undefined" ? localStorage.getItem(AUTH_TOKEN_KEY) || "" : "";
  if (cached?.token === token) return cached.access;
  const access = Promise.all([
    apiJson<{ capabilities: Array<{ id: string; enabled: boolean }> }>("/api/capabilities"),
    apiJson<{ effectivePermissions?: string[] }>("/api/authorization/context"),
  ])
    .then(([capabilities, context]) => ({
      enabled: capabilities.capabilities.some((entry) => entry.id === "data-import" && entry.enabled),
      permissions: new Set(context.effectivePermissions || []),
    }))
    .catch(() => {
      cached = null;
      return NONE;
    });
  cached = { token, access };
  return access;
}

// Offers nothing until the capability and permissions load, or when they
// cannot be read.
export function useDataImportAccess(): Access {
  const [access, setAccess] = useState<Access>(NONE);
  useEffect(() => {
    let alive = true;
    void loadAccess().then((value) => { if (alive) setAccess(value); });
    return () => { alive = false; };
  }, []);
  return access;
}

export function DataImportLink({ type, className }: { type: DataImportType; className?: string }) {
  const { copy } = useDataImportCopy();
  const access = useDataImportAccess();
  if (!access.enabled || !access.permissions.has(DATA_IMPORT_PERMISSION[type])) return null;
  return (
    <Link
      to={`/app/master-data/import?type=${type}`}
      data-testid={`data-import-link-${type}`}
      className={className || "inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"}
    >
      <Upload size={13} />
      {copy(type === "opening-stock" ? "Import opening stock" : "Import")}
    </Link>
  );
}
