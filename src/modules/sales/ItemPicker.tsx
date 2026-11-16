import { useEffect, useId, useRef, useState } from "react";
import { Field, inputStyle } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { apiJson } from "../../lib/api-client";

// The item of an order line, searched on the server as it is typed (design
// audit L4-01): the form used to list the first 200 active items, so nothing
// past them could be ordered. The search matches SKU or name; the arrow keys
// and Enter choose, Escape closes, as the customer field does
// (CustomerPicker.tsx).

export type PickerItem = { id: string; sku: string; name: string; unit?: string | null };
type ItemSearch = { items: PickerItem[]; itemsMore?: boolean };

// The pause after typing before the server is asked.
const DEBOUNCE_MS = 200;

export function ItemPicker({
  value,
  known,
  onChange,
  label,
  ariaLabel,
  required = false,
  error,
}: {
  value: string;
  // Items the form already knows (the draft's own and those chosen here), for
  // the chosen item's name.
  known: PickerItem[];
  onChange: (item: PickerItem | null) => void;
  label: string;
  ariaLabel: string;
  required?: boolean;
  error?: string;
}) {
  const { language } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const chosen = known.find((item) => item.id === value) || null;
  // What is typed; null while the field shows the chosen item.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<ItemSearch | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const asked = useRef(0);

  // Ask the server while the list is open: the first items, or those the
  // typed text matches. A later answer replaces an earlier one only if it is
  // for the latest question.
  useEffect(() => {
    if (!open) return;
    const text = (query ?? "").trim();
    const ask = ++asked.current;
    setState("loading");
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ view: "items", ...(text ? { itemQuery: text } : {}) });
      apiJson<ItemSearch>(`/api/sales/order-entry-data?${params.toString()}`)
        .then((answer) => { if (ask === asked.current) { setFound(answer); setActive(0); setState("idle"); } })
        .catch(() => { if (ask === asked.current) setState("error"); });
    }, text ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const shown = found?.items ?? [];
  const choose = (item: PickerItem) => {
    onChange(item);
    setQuery(null);
    setOpen(false);
  };
  const move = (step: number) => {
    if (!open) setOpen(true);
    const next = Math.max(0, Math.min(shown.length - 1, active + step));
    setActive(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const optionId = (index: number) => `${listId}-option-${index}`;
  return (
    <div className="relative" data-testid="sales-order-item-picker">
      <Field label={label} required={required} error={error}>
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
          autoComplete="off"
          placeholder={say("Search by SKU or item name", "按 SKU 或物料名称搜索")}
          style={inputStyle}
          value={query ?? (chosen ? `${chosen.sku} · ${chosen.name}` : "")}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setQuery(null);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter" && open && shown[active]) {
              event.preventDefault();
              choose(shown[active]);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setQuery(null);
            }
          }}
        />
        {open && (
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={say("Matching items", "匹配的物料")}
            className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
          >
            {shown.map((item, index) => (
              <li
                key={item.id}
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={item.id === value}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex min-h-9 cursor-pointer flex-wrap items-center gap-x-2 px-3 py-1.5 ${index === active ? "bg-blue-50" : ""}`}
              >
                <span className="font-medium text-slate-800">{item.sku}</span>
                <span className="text-xs text-slate-500">· {item.name}</span>
              </li>
            ))}
            {state === "loading" && !shown.length && (
              <li className="px-3 py-2 text-slate-500" role="presentation">{say("Searching…", "正在搜索…")}</li>
            )}
            {state === "error" && (
              <li className="px-3 py-2 text-red-700" role="presentation">{say("Items could not be searched. Try again.", "物料搜索失败，请重试。")}</li>
            )}
            {state === "idle" && found && !shown.length && (
              <li className="px-3 py-2 text-slate-500" role="presentation">{say("No active item matches. Try the SKU or part of the name.", "没有匹配的启用物料。请输入 SKU 或部分名称。")}</li>
            )}
            {found?.itemsMore && (
              <li className="border-t px-3 py-1.5 text-xs text-slate-500" role="presentation" data-testid="sales-order-item-more">
                {say(`Showing the first ${shown.length}. Type to narrow the list.`, `显示前 ${shown.length} 个，输入可缩小范围。`)}
              </li>
            )}
          </ul>
        )}
      </Field>
    </div>
  );
}
