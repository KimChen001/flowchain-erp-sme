import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { A } from "../ui";

type DirtyRegistration = { key: string; label: string; onSave?: () => void | Promise<void> };
type UnsavedContextValue = { register: (entry: DirtyRegistration) => () => void };

const UnsavedContext = createContext<UnsavedContextValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<Map<string, DirtyRegistration>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const register = useCallback((entry: DirtyRegistration) => {
    setEntries((current) => new Map(current).set(entry.key, entry));
    return () => setEntries((current) => { const next = new Map(current); next.delete(entry.key); return next; });
  }, []);
  const dirty = entries.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useBeforeUnload(useCallback((event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "当前修改尚未保存，确定离开吗？";
  }, [dirty]));

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
            <h2 className="fc-modal-title">当前修改尚未保存</h2>
            <p className="fc-body mt-2" style={{ color: A.sub }}>{Array.from(entries.values()).map((entry) => entry.label).join("、")}尚未保存，确定离开吗？</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button className="fc-action-button fc-action-secondary" onClick={() => blocker.reset?.()}>继续编辑</button>
              <button className="fc-action-button fc-action-danger" onClick={() => { setEntries(new Map()); blocker.proceed?.(); }}>放弃修改</button>
              <button className="fc-action-button fc-action-primary" disabled={saving} onClick={saveAndLeave}>{saving ? "保存中…" : "保存并离开"}</button>
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
  useEffect(() => {
    if (!context || !dirty) return;
    return context.register({ key, label, onSave: () => saveRef.current?.() });
  }, [context, dirty, key, label]);
}
