import { useEffect, useState } from "react";

// Phones are below Tailwind's md breakpoint (768px), the width phone.css
// switches lists to cards at.
const PHONE = "(max-width: 767px)";

export function usePhone() {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : null;
  const [phone, setPhone] = useState(Boolean(query?.matches));
  useEffect(() => {
    if (!query) return;
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [query]);
  return phone;
}
