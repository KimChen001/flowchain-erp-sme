import { useId, useMemo, useRef, useState } from "react";
import { Field, inputStyle } from "../../components/ui";
import { useI18n } from "../../i18n/I18n";
import { formatQuantity } from "../../lib/format";
import { customerMatches, type PickerCustomer } from "./salesOrderFacts";

// The customer an order is for, typed and searched rather than scrolled: a
// workspace can hold a thousand customers whose names all start the same way
// ("Customer 12748 (United Kingdom)"). Typing narrows the list by customer
// number, name, country or address; the arrow keys and Enter choose, Escape
// closes. The field shows the chosen customer's whole name.
//
// The input is Field's own control, so the label, the required mark and the
// error message are tied to it as on every other field (formLayout.tsx).

// The first matches drawn; typing narrows the rest.
const SHOWN = 50;

export function CustomerPicker<T extends PickerCustomer>({
  customers,
  value,
  onChange,
  label,
  ariaLabel,
  required = false,
  error,
  children,
}: {
  customers: T[];
  value: string;
  onChange: (customer: T | null) => void;
  label: string;
  ariaLabel: string;
  required?: boolean;
  error?: string;
  // Facts about the chosen customer, under the field.
  children?: React.ReactNode;
}) {
  const { language } = useI18n();
  const say = (english: string, chinese: string) => (language === "en-US" ? english : chinese);
  const chosen = customers.find((customer) => customer.id === value) || null;
  // What is typed; null while the field shows the chosen customer.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const matches = useMemo(
    () => (query === null ? customers : customers.filter((customer) => customerMatches(customer, query))),
    [customers, query],
  );
  const shown = matches.slice(0, SHOWN);
  const choose = (customer: T) => {
    onChange(customer);
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
    <div className="relative" data-testid="sales-order-customer-picker">
      <Field label={label} required={required} error={error}>
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && shown[active] ? optionId(active) : undefined}
          autoComplete="off"
          placeholder={say("Search by customer number, name or country", "按客户编号、名称或国家搜索")}
          style={inputStyle}
          value={query ?? chosen?.name ?? ""}
          // Focus alone (a refused save moves it here) leaves the list closed;
          // a click, a key or typing opens it.
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
              // Closes the list, not the dialog the field may sit in.
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
            aria-label={say("Matching customers", "匹配的客户")}
            className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
          >
            {shown.map((customer, index) => (
              <li
                key={customer.id}
                id={optionId(index)}
                data-index={index}
                role="option"
                aria-selected={customer.id === value}
                // Chosen on mouse down, before the field loses focus and closes the list.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(customer);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex min-h-9 cursor-pointer flex-wrap items-center gap-x-2 px-3 py-1.5 ${index === active ? "bg-blue-50" : ""}`}
              >
                {/* Read as "Redwood Plumbing · CUST-RW". */}
                <span className="font-medium text-slate-800">{customer.name}</span>{" "}
                <span className="text-xs text-slate-500">· {customer.code}</span>
                {customer.country && !customer.name.includes(customer.country) && <span className="text-xs text-slate-500">· {customer.country}</span>}
              </li>
            ))}
            {!shown.length && (
              <li className="px-3 py-2 text-slate-500" role="presentation">
                {say("No customer matches. Try the customer number or part of the name.", "没有匹配的客户。请输入客户编号或部分名称。")}
              </li>
            )}
            {matches.length > shown.length && (
              <li className="border-t px-3 py-1.5 text-xs text-slate-500" role="presentation">
                {say(
                  `Showing ${shown.length} of ${formatQuantity(String(matches.length))}. Type to narrow the list.`,
                  `显示 ${matches.length} 个中的 ${shown.length} 个，输入可缩小范围。`,
                )}
              </li>
            )}
          </ul>
        )}
        {children}
      </Field>
    </div>
  );
}
