import { useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router";

// The name a detail page gives its breadcrumb, such as its document number
// (GRN-1042, AV-5512). Many detail addresses end in a stored id, and the
// breadcrumb must never show an id such as a UUID to the reader.
let current: { path: string; label: string } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Names the current detail page in the breadcrumb once its record is loaded. */
export function useDetailCrumb(label: string | null | undefined) {
  const { pathname } = useLocation();
  useEffect(() => {
    const text = String(label ?? "").trim();
    if (!text) return;
    current = { path: pathname, label: text };
    notify();
    return () => {
      if (current?.path === pathname) {
        current = null;
        notify();
      }
    };
  }, [pathname, label]);
}

/** The name the page at this address gave itself, if any. */
export function useDetailCrumbLabel(pathname: string) {
  const crumb = useSyncExternalStore(subscribe, () => current, () => null);
  return crumb?.path === pathname ? crumb.label : null;
}

// A stored id rather than a name: a UUID, alone or after a short prefix
// (USR-…, WH-…, ITEM-…).
export const looksLikeStoredId = (segment: string) =>
  /^(?:[A-Za-z]{1,8}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
