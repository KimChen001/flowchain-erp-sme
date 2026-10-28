import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./api-client";

type WarehouseRow = { id: string; code?: string; name?: string };

// One request per page load: every page that shows a warehouse id asks for
// the same list, so the names are read once and shared. The full list is read,
// not the selector of active warehouses, so history on a warehouse that was
// later set inactive still shows its name.
let pending: Promise<Record<string, string>> | null = null;

function loadWarehouseNames() {
  pending ??= apiJson<{ warehouses?: WarehouseRow[] }>("/api/master-data/warehouses")
    .then((payload) => Object.fromEntries((payload?.warehouses || []).flatMap((row) => {
      const name = String(row.name || "").trim();
      if (!name || !row.id) return [];
      return [[row.id, name], ...(row.code && row.code !== row.id ? [[row.code, name]] : [])];
    })))
    .catch(() => {
      pending = null;
      return {};
    });
  return pending;
}

/** Reads the names again on the next page that asks, after a warehouse is added or renamed. */
export function forgetWarehouseNames() {
  pending = null;
}

/**
 * Returns a function that shows a warehouse by its name instead of its stored
 * id. An id with no known warehouse (or before the names load) is shown as is,
 * so nothing is hidden. The stored id is never changed.
 */
export function useWarehouseNames() {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void loadWarehouseNames().then((next) => { if (active) setNames(next); });
    return () => { active = false; };
  }, []);
  return useCallback((id?: string | null) => {
    const value = String(id || "").trim();
    return value ? names[value] || value : "";
  }, [names]);
}
