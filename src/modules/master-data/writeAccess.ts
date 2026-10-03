import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api-client";

// What the signed-in user may change in master data, from the effective
// permissions of their roles in Roles & permissions (never the legacy role).
// Item supplier links count as item edits, as on the server.
export type MasterDataWriteAccess = { items: boolean; suppliers: boolean; customers: boolean };

const NO_WRITES: MasterDataWriteAccess = { items: false, suppliers: false, customers: false };

// Offers no create or edit control until the permissions load, or when they
// cannot be read. The server checks every write either way.
export function useMasterDataWriteAccess(): MasterDataWriteAccess {
  const [access, setAccess] = useState<MasterDataWriteAccess>(NO_WRITES);
  useEffect(() => {
    let alive = true;
    apiJson<{ effectivePermissions?: string[] }>("/api/authorization/context")
      .then((context) => {
        if (!alive) return;
        const codes = new Set(context.effectivePermissions || []);
        setAccess({
          items: codes.has("master_data.item.manage"),
          suppliers: codes.has("master_data.supplier.manage"),
          customers: codes.has("master_data.customer.manage"),
        });
      })
      .catch(() => { if (alive) setAccess(NO_WRITES); });
    return () => { alive = false; };
  }, []);
  return access;
}
