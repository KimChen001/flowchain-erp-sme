import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { A } from "../ui";
import { useI18n } from "../../i18n/I18n";

// [English, Chinese]
const copy = {
  title: ["You have unsaved changes", "当前修改尚未保存"],
  body: ["{labels} has unsaved changes. Leave anyway?", "{labels}尚未保存，确定离开吗？"],
  keep: ["Keep editing", "继续编辑"],
  discard: ["Discard changes", "放弃修改"],
  saveAndLeave: ["Save and leave", "保存并离开"],
  saving: ["Saving…", "保存中…"],
} as const;

type DirtyRegistration = { key: string; label: string; onSave?: () => void | Promise<void> };
type UnsavedContextValue = { register: (entry: DirtyRegistration) => () => void };

const UnsavedContext = createContext<UnsavedContextValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<Map<string, DirtyRegistration>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const { language } = useI18n();
  const text = (key: keyof typeof copy) => copy[key][language === "en-US" ? 0 : 1];
  const register = useCallback((entry: DirtyRegistration) => {
    setEntries((current) => new Map(current).set(entry.key, entry));
    return () => setEntries((current) => { const next = new Map(current); next.delete(entry.key); return next; });
  }, []);
  const dirty = entries.size > 0;
  const canSave = Array.from(entries.values()).every((entry) => entry.onSave);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useBeforeUnload(useCallback((event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = text("title");
  }, [dirty, language]));

  async function saveAndLeave() {
    setSaving(true);
    try {
      for (const entry of entries.values()) await entry.onSave?.();
      setEntries(new Map());
      blocker.proceed?.();
    } finally {
      setSaving(false);
    }
  }

  const value = useMemo(() => ({ register }), [register]);
  return (
    <UnsavedContext.Provider value={value}>
      {children}
      {blocker.state === "blocked" && (
        <div className="fc-overlay-enter fixed inset-0 z-[140] flex items-center justify-center p-6" data-testid="unsaved-changes-dialog" style={{ background: "rgba(15,23,42,.42)", backdropFilter: "blur(6px)" }}>
          <div className="fc-dialog-enter w-full max-w-md rounded-2xl bg-white p-6" style={{ boxShadow: "0 24px 60px rgba(15,23,42,.24)" }}>
            <h2 className="fc-modal-title">{text("title")}</h2>
            <p className="fc-body mt-2" style={{ color: A.sub }}>{text("body").replace("{labels}", Array.from(entries.values()).map((entry) => entry.label).join(language === "en-US" ? ", " : "、"))}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button className="fc-action-button fc-action-secondary" onClick={() => blocker.reset?.()}>{text("keep")}</button>
              <button className="fc-action-button fc-action-danger" onClick={() => { setEntries(new Map()); blocker.proceed?.(); }}>{text("discard")}</button>
              {/* Only offered when every open form can actually save. */}
              {canSave ? <button className="fc-action-button fc-action-primary" disabled={saving} onClick={saveAndLeave}>{saving ? text("saving") : text("saveAndLeave")}</button> : null}
            </div>
          </div>
        </div>
      )}
    </UnsavedContext.Provider>
  );
}

export function useUnsavedChanges({ key, label, dirty, onSave }: DirtyRegistration & { dirty: boolean }) {
  const context = useContext(UnsavedContext);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const canSave = Boolean(onSave);
  useEffect(() => {
    if (!context || !dirty) return;
    return context.register({ key, label, ...(canSave ? { onSave: () => saveRef.current?.() } : {}) });
  }, [context, dirty, key, label, canSave]);
}
