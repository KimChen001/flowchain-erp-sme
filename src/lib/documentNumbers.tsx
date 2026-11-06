import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiJson } from "./api-client";

/**
 * Document numbers of purchase requests, RFQs and purchase orders.
 *
 * Each of these documents keeps its internal id (the global key used in URLs,
 * links and API calls) and has a per-workspace number (PREFIX-YYYYMM-NNNN)
 * that people read. Rows created before numbering have number = id. Pages show
 * the number; links and calls keep using the id.
 *
 * Numbers come from the payload when it carries them (`number`, `poNumber` …)
 * and otherwise from one batched lookup per tick:
 * GET /api/procurement/document-numbers?purchase_order=<id>,<id>&purchase_request=<id>&rfq=<id>
 * Results are kept for the session. While a number loads, or when the lookup
 * fails or omits an id, the id is shown, so nothing is hidden.
 */
export type DocumentNumberType = "purchase_order" | "purchase_request" | "rfq";

export const documentNumberTypes: readonly DocumentNumberType[] = ["purchase_order", "purchase_request", "rfq"];

export function isDocumentNumberType(value: unknown): value is DocumentNumberType {
  return value === "purchase_order" || value === "purchase_request" || value === "rfq";
}

const BATCH_LIMIT = 200;
const known: Record<DocumentNumberType, Map<string, string>> = { purchase_order: new Map(), purchase_request: new Map(), rfq: new Map() };
// Ids already asked for (in flight, answered or failed): never asked twice in a session.
const asked: Record<DocumentNumberType, Set<string>> = { purchase_order: new Set(), purchase_request: new Set(), rfq: new Set() };
const queued: Record<DocumentNumberType, Set<string>> = { purchase_order: new Set(), purchase_request: new Set(), rfq: new Set() };
const waiters = new Set<() => void>();
const listeners = new Set<() => void>();
let snapshot = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<unknown> = Promise.resolve();
let notifyScheduled = false;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  // Never inside a render: a payload may be remembered while a page renders.
  queueMicrotask(() => {
    notifyScheduled = false;
    snapshot += 1;
    listeners.forEach((listener) => listener());
  });
}

/** Remembers a number the payload already carries, so it is not looked up. */
export function rememberDocumentNumber(type: DocumentNumberType, id: unknown, number: unknown) {
  const key = clean(id);
  const value = clean(number);
  if (!key || !value) return;
  asked[type].add(key);
  if (known[type].get(key) === value) return;
  known[type].set(key, value);
  notify();
}

/** Remembers the numbers of payload rows, e.g. rememberDocumentNumbers("purchase_order", orders, (o) => [o.po, o.number]). */
export function rememberDocumentNumbers<T>(type: DocumentNumberType, rows: readonly T[] | null | undefined, pick: (row: T) => [unknown, unknown]) {
  for (const row of rows || []) {
    const [id, number] = pick(row);
    rememberDocumentNumber(type, id, number);
  }
}

/**
 * The number of a document: `number` when the payload carries it, else the
 * number known now, else its id ("" for no id). Looks nothing up.
 */
export function documentNumberFor(type: DocumentNumberType, id: unknown, number?: unknown) {
  const key = clean(id);
  return clean(number) || (key ? known[type].get(key) || key : "");
}

async function lookUp(batch: Record<DocumentNumberType, string[]>) {
  const params = new URLSearchParams();
  for (const type of documentNumberTypes) if (batch[type].length) params.set(type, batch[type].join(","));
  try {
    const payload = await apiJson<{ numbers?: Partial<Record<DocumentNumberType, Record<string, unknown>>> }>(`/api/procurement/document-numbers?${params.toString()}`);
    for (const type of documentNumberTypes) {
      const numbers = payload?.numbers?.[type];
      if (numbers && typeof numbers === "object") for (const [id, number] of Object.entries(numbers)) rememberDocumentNumber(type, id, number);
    }
  } catch {
    // The id stays on screen; the lookup is not repeated in this session.
  }
}

function flush() {
  flushTimer = null;
  const work: Promise<void>[] = [];
  for (;;) {
    const batch = {} as Record<DocumentNumberType, string[]>;
    let size = 0;
    for (const type of documentNumberTypes) {
      batch[type] = [...queued[type]].slice(0, BATCH_LIMIT);
      batch[type].forEach((id) => queued[type].delete(id));
      size += batch[type].length;
    }
    if (!size) break;
    work.push(lookUp(batch));
  }
  inFlight = Promise.all([inFlight, ...work]);
  void inFlight.then(() => {
    const done = [...waiters];
    waiters.clear();
    done.forEach((resolve) => resolve());
  });
}

function request(type: DocumentNumberType, ids: readonly unknown[]) {
  let added = false;
  for (const id of ids) {
    const key = clean(id);
    if (!key || asked[type].has(key)) continue;
    asked[type].add(key);
    queued[type].add(key);
    added = true;
  }
  if (added && !flushTimer) flushTimer = setTimeout(flush, 0);
  return added;
}

/**
 * Resolves the numbers of these documents (for exports the browser builds):
 * a map from id to number, with the id for any document whose number is unknown.
 */
export async function resolveDocumentNumbers(type: DocumentNumberType, ids: readonly unknown[]) {
  request(type, ids);
  if (flushTimer) await new Promise<void>((resolve) => waiters.add(resolve));
  await inFlight;
  return new Map(ids.map((id) => clean(id)).filter(Boolean).map((id) => [id, documentNumberFor(type, id)]));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return snapshot;
}

/**
 * The number to show for a document: `number` when the payload carries it,
 * else the remembered or looked-up number, else the id. A null type (another
 * kind of record) returns the id unchanged and looks nothing up.
 */
export function useDocumentNumber(type: DocumentNumberType | null | undefined, id: unknown, number?: unknown) {
  const key = clean(id);
  const given = clean(number);
  // Re-renders only when this document's number arrives, not on every lookup.
  const current = useSyncExternalStore(subscribe, () => (type && key ? documentNumberFor(type, key) : key), () => key);
  useEffect(() => {
    if (!type || !key) return;
    if (given) rememberDocumentNumber(type, key, given);
    else request(type, [key]);
  }, [type, key, given]);
  if (!type || !key) return key;
  return given || current;
}

/**
 * For a list of records of any kind, as [entityType, id] pairs: looks up the
 * numbers of the purchase requests, RFQs and purchase orders among them
 * together and returns a function from (entityType, id) to the text to show:
 * the number for those documents (the id while it loads or when unknown),
 * the id for any other kind of record.
 */
export function useDocumentNumbers(refs: ReadonlyArray<readonly [unknown, unknown]>) {
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const signature = refs.flatMap(([type, id]) => isDocumentNumberType(type) && clean(id) ? [`${type}\u0001${clean(id)}`] : []).join("\u0000");
  useEffect(() => {
    if (!signature) return;
    for (const entry of signature.split("\u0000")) {
      const [type, id] = entry.split("\u0001");
      if (isDocumentNumberType(type)) request(type, [id]);
    }
  }, [signature]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((type: unknown, id: unknown) => isDocumentNumberType(type) ? documentNumberFor(type, id) : clean(id), [version]);
}

/** Shows a document's number as text (its id while the number loads or when it has none). */
export function DocumentNumber({ type, id, number, fallback = "" }: { type: DocumentNumberType; id?: string | null; number?: string | null; fallback?: string }) {
  const value = useDocumentNumber(type, id, number);
  return <>{value || fallback}</>;
}
