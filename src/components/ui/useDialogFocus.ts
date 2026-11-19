import { useEffect, useRef, type RefObject } from "react";

// The keyboard behaviour every modal dialog and drawer shares:
// - focus moves into the dialog when it opens (its [data-autofocus] element,
//   else its first control, else the dialog itself);
// - Tab and Shift+Tab stay inside it;
// - Escape closes it;
// - focus goes back to the control that opened it when it closes.
// Only the dialog opened last answers the keyboard, so a confirm dialog over
// a drawer closes first.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openDialogs: symbol[] = [];

function focusableIn(node: HTMLElement) {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element.getClientRects().length > 0);
}

export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void, { escape = true }: { escape?: boolean } = {}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = Symbol("dialog");
    openDialogs.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const node = ref.current;
      if (!node || node.contains(document.activeElement)) return;
      const target = node.querySelector<HTMLElement>("[data-autofocus]") || focusableIn(node)[0] || node;
      target.focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      const node = ref.current;
      if (!node) return;
      if (event.key === "Escape" && escape) {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusableIn(node);
      if (!list.length) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      const index = openDialogs.indexOf(id);
      if (index >= 0) openDialogs.splice(index, 1);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, escape, ref]);
}
