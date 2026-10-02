import { useCallback, useEffect, useState } from "react";
import { apiJson } from "./api-client";

type WarehouseOption = { id: string; code?: string; label?: string };

// One request per page load: every page that shows a warehouse id asks the
// same selector, so the names are read once and shared.
let pending: Promise<Record<string, string>> | null = null;

function loadWarehouseNames() {
  pending ??= apiJson<{ options?: WarehouseOption[] }>("/api/master-data/warehouses/select")
    .then((payload) => Object.fromEntries((payload?.options || []).flatMap((option) => {
      const name = String(option.label || "").trim();
      if (!name) return [];
      return [[option.id, name], ...(option.code && option.code !== option.id ? [[option.code, name]] : [])];
    })))
    .catch(() => {
      pending = null;
      return {};
    });
  return pending;
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
