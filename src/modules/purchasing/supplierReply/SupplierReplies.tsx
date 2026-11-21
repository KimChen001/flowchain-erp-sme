import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { A, Card, SectionHeader } from "../../../components/ui";
import { listButtonClass } from "../../../components/ui/listLayout";
import { useI18n } from "../../../i18n/I18n";
import { apiJson } from "../../../lib/api-client";
import { usePermissionSet } from "../../../lib/usePermissionSet";
import { procurementErrorCode, procurementErrorText } from "../../procurement/procurementErrors";
import { supplierReplyCardSchema } from "../../../../shared/supplier-reply-contract.mjs";
import { SupplierReplyCard } from "./SupplierReplyCard";
import { SUPPLIER_REPLY_ERROR_TEXT, supplierReplyText, type SupplierReplyCopyKey } from "./supplierReplyCopy";
import { SUPPLIER_REPLY_PASTE_LIMIT, featuredReplies } from "./supplierReplyLogic";
import type { SupplierReplyCardData } from "./supplierReplyTypes";

// A supplier's replies on one order and the box to paste a new one
// (docs/supplier-reply-dates-design.md §4.2):
//   on the order's page ("order"): "Record supplier reply" on an issued or
//     partly received order, the latest reply's card and the earlier ones;
//   on a chased overdue item in Today ("today"): "Got a reply? Paste it
//     here", and the open reply's card.
// Pasting, recording and dismissing need procurement.purchase_order.revise;
// without it a reader sees the cards but not their buttons.

const BUTTON = { primary: `${listButtonClass.primary} !text-[12px]`, secondary: `${listButtonClass.secondary} !text-[12px]` };
const PASTE_STATUSES = new Set(["issued", "partially_received"]);
const REVISE = "procurement.purchase_order.revise";

// The cards the server sent that match the contract; one that does not is
// left out rather than shown half-read.
function validCards(value: unknown): SupplierReplyCardData[] {
  const list = Array.isArray((value as { replies?: unknown })?.replies) ? (value as { replies: unknown[] }).replies : [];
  return list.filter((card) => supplierReplyCardSchema.safeParse(card).success) as SupplierReplyCardData[];
}

export function SupplierReplies({ orderId, orderStatus, entry, onRecorded }: {
  orderId: string;
  // The order's status, where the page knows it: pasting is offered on an
  // issued or partly received order. Today's chased items are such orders.
  orderStatus?: string;
  entry: "order" | "today";
  // After dates were recorded, so the page reloads the order.
  onRecorded?: () => void;
}) {
  const { language, workspaceToday, formatNumber } = useI18n();
  const t = (key: SupplierReplyCopyKey, values?: Record<string, string | number>) => supplierReplyText(language, key, values);
  const permissions = usePermissionSet();
  const mayChange = Boolean(permissions?.has(REVISE));
  const canPaste = mayChange && (entry === "today" || PASTE_STATUSES.has(String(orderStatus || "")));
  const [replies, setReplies] = useState<SupplierReplyCardData[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  // Today: the box opens again over an open card only on request.
  const [pasteAgain, setPasteAgain] = useState(false);
  // Today: the reply just pasted or decided stays in view with what became
  // of it, a "nothing to record" one included.
  const [shownId, setShownId] = useState<string | null>(null);
  // The sentence a refusal left on a reply (a stale card, a reply no longer
  // open), kept here so the card's reload does not lose it.
  const [notices, setNotices] = useState<Record<string, string>>({});
  // The order's replies (SUPPLIER_REPLY_ROUTES.list and .paste), written out
  // so the write-route caller test reads them.
  const replies_ = `/api/procurement/orders/${encodeURIComponent(orderId)}/supplier-replies`;

  const load = useCallback(async () => {
    try {
      setReplies(validCards(await apiJson(replies_)));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [replies_]);
  // Today's item loads its replies when the person opens it.
  useEffect(() => { if (entry === "order" || open) void load(); }, [entry, open, load]);

  const paste = async () => {
    const reply = text.trim();
    if (!reply || reply.length > SUPPLIER_REPLY_PASTE_LIMIT) return;
    setBusy(true);
    try {
      const result = await apiJson<{ reply: SupplierReplyCardData }>(replies_, {
        method: "POST",
        body: JSON.stringify({ text: reply, ...(receivedOn ? { receivedOn } : {}) }),
      });
      setText("");
      setReceivedOn("");
      if (entry === "order") setOpen(false);
      setPasteAgain(false);
      setShownId(result.reply.id);
      setNotices({});
      // A new reply replaces an open one; the list says so on reload.
      await load();
      if (!supplierReplyCardSchema.safeParse(result.reply).success) return;
      setReplies((current) => [result.reply, ...(current || []).filter((card) => card.id !== result.reply.id)]);
    } catch (error) {
      toast.error(t("pasteFailed"), { description: <span title={procurementErrorCode(error)}>{procurementErrorText(error, language, [t("retry"), t("retry")], SUPPLIER_REPLY_ERROR_TEXT)}</span> });
    } finally {
      setBusy(false);
    }
  };
  const refused = (id: string) => async (kind: "stale" | "moved" | "closed") => {
    setNotices((current) => ({ ...current, [id]: t(kind) }));
    setShownId(id);
    await load();
  };
  const changed = (next: SupplierReplyCardData, recorded: boolean) => {
    setReplies((current) => (current || []).map((card) => (card.id === next.id ? next : card)));
    setShownId(next.id);
    setNotices((current) => { const { [next.id]: _done, ...rest } = current; return rest; });
    if (recorded) onRecorded?.();
  };

  const list = replies || [];
  const length = text.length;
  const formShown = (current: SupplierReplyCardData | null) => canPaste && open && (entry === "order" || !current || pasteAgain);
  const pasteForm = (current: SupplierReplyCardData | null) => formShown(current) ? (
    <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-2 text-xs" data-testid="supplier-reply-paste">
      <label className="block text-xs font-normal">
        <span className="font-medium">{t("pasteLabel")}</span>
        <textarea className="mt-1 block min-h-28 w-full rounded border bg-white p-2" aria-label={t("pasteLabel")} placeholder={t("pastePlaceholder")} value={text} onChange={(event) => setText(event.target.value)} data-testid="supplier-reply-paste-text" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs font-normal">
          <span>{t("receivedOn")}</span>
          <input type="date" className="rounded border bg-white px-1 py-0.5 max-sm:min-h-9" max={workspaceToday || undefined} value={receivedOn || workspaceToday} onChange={(event) => setReceivedOn(event.target.value)} data-testid="supplier-reply-received-on" />
        </label>
        <span style={{ color: length > SUPPLIER_REPLY_PASTE_LIMIT ? A.danger : A.sub }} data-testid="supplier-reply-count">{t("characters", { n: formatNumber(length), limit: formatNumber(SUPPLIER_REPLY_PASTE_LIMIT) })}</span>
        <div className="ml-auto flex gap-2">
          <button type="button" className={BUTTON.secondary} onClick={() => (entry === "today" && current ? setPasteAgain(false) : setOpen(false))}>{t("cancel")}</button>
          <button type="button" disabled={busy || !text.trim() || length > SUPPLIER_REPLY_PASTE_LIMIT} className={BUTTON.primary} data-testid="supplier-reply-read" onClick={() => void paste()}>{busy ? t("reading") : t("read")}</button>
        </div>
      </div>
      {length > SUPPLIER_REPLY_PASTE_LIMIT ? <p style={{ color: A.danger }} role="alert">{t("tooLong", { limit: formatNumber(SUPPLIER_REPLY_PASTE_LIMIT) })}</p> : null}
    </div>
  ) : null;

  if (entry === "today") {
    if (!canPaste) return null;
    const { featured } = featuredReplies(list, list.find((card) => card.id === shownId) || null);
    const current = featured[0] || null;
    return (
      <div className="w-full" data-testid="supplier-reply-today">
        <button type="button" className="flex items-center gap-1 text-xs font-medium text-blue-600" aria-expanded={open} data-testid="supplier-reply-open" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{t("openFromToday")}
        </button>
        {pasteForm(current)}
        {open && loadFailed ? <p className="mt-1 text-xs" style={{ color: A.sub }}>{t("loadFailed")}</p> : null}
        {open ? featured.map((card) => <div key={`${card.id}:${card.orderVersion}:${card.state}`} className="mt-2"><SupplierReplyCard card={card} onChanged={changed} onRefused={refused(card.id)} notice={notices[card.id] || null} mayChange={mayChange} /></div>) : null}
        {open && current && !pasteAgain ? <button type="button" className="mt-1 text-xs font-medium text-blue-600" data-testid="supplier-reply-paste-again" onClick={() => setPasteAgain(true)}>{t("pasteAnother")}</button> : null}
      </div>
    );
  }

  // The order page: nothing to show to a reader who cannot paste on an order
  // with no replies.
  if (!canPaste && !list.length) return null;
  const { featured, earlier } = featuredReplies(list);
  const latest = featured[0] || null;
  return (
    // A section of the order page like its others: the title above, the card below.
    <section data-testid="supplier-replies">
      <SectionHeader title={t("sectionTitle")} right={canPaste && !open ? <button type="button" className={BUTTON.secondary} data-testid="supplier-reply-open" onClick={() => setOpen(true)}>{t("openFromOrder")}</button> : undefined} />
      <Card className="p-4">
      <p className="text-xs" style={{ color: A.sub }}>{t("sectionNote")}</p>
      {pasteForm(latest || null)}
      {loadFailed ? <p className="mt-2 text-xs" style={{ color: A.sub }}>{t("loadFailed")}</p> : null}
      {replies && !list.length && !open ? <p className="mt-2 text-xs" style={{ color: A.sub }}>{t("none")}</p> : null}
      {featured.map((card) => <div key={`${card.id}:${card.orderVersion}:${card.state}`} className="mt-3"><SupplierReplyCard card={card} onChanged={changed} onRefused={refused(card.id)} notice={notices[card.id] || null} mayChange={mayChange} /></div>)}
      {earlier.length ? (
        <div className="mt-3">
          <button type="button" className="flex items-center gap-1 text-xs font-medium" style={{ color: A.gray1 }} aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
            {showEarlier ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{t("earlier", { n: earlier.length })}
          </button>
          {showEarlier ? <div className="mt-2 space-y-2">{earlier.map((card) => <SupplierReplyCard key={`${card.id}:${card.orderVersion}:${card.state}`} card={card} onChanged={changed} onRefused={refused(card.id)} notice={notices[card.id] || null} mayChange={mayChange} />)}</div> : null}
        </div>
      ) : null}
      </Card>
    </section>
  );
}
