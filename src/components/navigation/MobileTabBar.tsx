import React, { useEffect, useState } from "react";
import { BarChart3, CheckSquare, MessageCircle, MoreHorizontal, PackageCheck, X } from "lucide-react";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";

// Below the lg breakpoint the sidebar is hidden, so phones and small tablets
// get five bottom tabs instead (owner decision, 2026-10-08): Today,
// Approvals, Receive, Assistant and More. More lists every page the reader
// may open. The tabs replace the old dropdown and the floating assistant
// button, which covered list rows.

export type MobileNavItem = { id: string; routeId: string; label: string; icon: React.ElementType };
export type MobileTab = "today" | "approvals" | "receive" | "more";

export function MobileTabBar({
  items,
  activeTab,
  canOpen,
  onOpenTab,
  onNavigate,
  onOpenAssistant,
}: {
  items: MobileNavItem[];
  activeTab: MobileTab;
  canOpen: (routeId: string) => boolean;
  onOpenTab: (tab: Exclude<MobileTab, "more">) => void;
  onNavigate: (routeId: string) => void;
  onOpenAssistant: () => void;
}) {
  const { t } = useI18n();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [moreOpen]);

  const tabs: Array<{ id: MobileTab | "assistant"; label: string; icon: React.ElementType; visible: boolean; onClick: () => void }> = [
    { id: "today", label: t("mobile.today"), icon: BarChart3, visible: canOpen("overview"), onClick: () => onOpenTab("today") },
    { id: "approvals", label: t("mobile.approvals"), icon: CheckSquare, visible: canOpen("procurement:workbench"), onClick: () => onOpenTab("approvals") },
    { id: "receive", label: t("mobile.receive"), icon: PackageCheck, visible: canOpen("procurement:receiving"), onClick: () => onOpenTab("receive") },
    { id: "assistant", label: t("mobile.assistant"), icon: MessageCircle, visible: true, onClick: onOpenAssistant },
    { id: "more", label: t("mobile.more"), icon: MoreHorizontal, visible: true, onClick: () => setMoreOpen(true) },
  ];
  const shown = tabs.filter((tab) => tab.visible);

  return (
    <>
      <nav
        aria-label={t("mobile.tabs")}
        data-testid="mobile-tab-bar"
        className="fc-mobile-tabbar lg:hidden"
        style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
      >
        {shown.map((tab) => {
          const active = tab.id === activeTab || (tab.id === "more" && moreOpen);
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={`mobile-tab-${tab.id}`}
              aria-current={active && tab.id !== "more" ? "page" : undefined}
              onClick={tab.onClick}
              className="fc-mobile-tab"
              style={{ color: active ? A.blue : A.gray1, fontWeight: active ? 600 : 500 }}
            >
              <tab.icon size={20} strokeWidth={active ? 2.1 : 1.8} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
      {moreOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="mobile-more-sheet">
          <button type="button" aria-label={t("mobile.close")} className="absolute inset-0 bg-slate-900/45" onClick={() => setMoreOpen(false)} />
          <div role="dialog" aria-modal="true" aria-label={t("mobile.moreTitle")} className="fc-mobile-sheet">
            <div className="fc-mobile-sheet-handle" />
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold" style={{ color: A.label }}>{t("mobile.moreTitle")}</h2>
              <button type="button" onClick={() => setMoreOpen(false)} aria-label={t("mobile.close")} className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: A.gray1 }}>
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`mobile-more-${item.id}`}
                  onClick={() => { setMoreOpen(false); onNavigate(item.routeId); }}
                  className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl px-2 py-3 text-center text-xs font-medium"
                  style={{ background: A.gray6, color: A.label }}
                >
                  <item.icon size={20} strokeWidth={1.8} style={{ color: A.blue }} />
                  <span className="leading-tight">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
