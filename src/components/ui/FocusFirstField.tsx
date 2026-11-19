import { useEffect, useRef } from "react";

// Placed inside an inline form that replaces a list ("New SKU", "New
// supplier"): when the form opens, keyboard focus goes to its first field
// instead of falling back to the top of the page with the button that opened it.
const FIELD = 'input:not([type="hidden"]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([disabled]):not([readonly])';

export function FocusFirstField() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = marker.current?.parentElement;
    const frame = requestAnimationFrame(() => {
      if (!root || root.contains(document.activeElement)) return;
      root.querySelector<HTMLElement>(FIELD)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <span ref={marker} hidden />;
}
