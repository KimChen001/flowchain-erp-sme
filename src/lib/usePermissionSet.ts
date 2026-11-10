import { useEffect, useState } from "react";
import { readAuthorizationContext } from "./authorizationContext";

// The effective permission codes of the signed-in user; null while loading
// and empty when they cannot be read, so no command is offered. The server
// checks every command again.
export function usePermissionSet() {
  const [permissions, setPermissions] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    readAuthorizationContext()
      .then((context) => { if (alive) setPermissions(new Set(context.effectivePermissions || [])); })
      .catch(() => { if (alive) setPermissions(new Set()); });
    return () => { alive = false; };
  }, []);
  return permissions;
}
