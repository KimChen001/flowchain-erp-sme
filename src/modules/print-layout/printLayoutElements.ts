import type { PrintDocumentType, PrintElementType, PrintLayoutElement, PrintLayoutTemplate } from "./printLayoutTypes";

// The interface copy the new elements and the per-print fields start with.
// It is template content once added: editable, and saved as typed.
export type PrintLayoutCopyKey =
  | "printLayout.element.text" | "printLayout.element.textValue"
  | "printLayout.element.comment" | "printLayout.element.commentPlaceholder"
  | "printLayout.element.remark"
  | "printLayout.element.terms" | "printLayout.element.termsValue"
  | "printLayout.element.signature" | "printLayout.element.signatureValue"
  | "printLayout.element.line"
  | "printLayout.instancePlaceholder"
  | `printLayout.instance.${PrintInstanceFieldKey}`;
export type PrintLayoutCopy = (key: PrintLayoutCopyKey, variables?: Record<string, string | number>) => string;

export const PRINT_INSTANCE_FIELD_KEYS: Record<PrintDocumentType, readonly PrintInstanceFieldKey[]> = {
  receive_sheet: ["receiving-note", "quality-note", "supplier-delivery-note", "warehouse-note"],
  delivery_note: ["delivery-note", "packing-note", "customer-request", "transport-note"],
  sign_receipt: ["receipt-note", "customer-comments", "damage-note", "exception-note"],
};
export type PrintInstanceFieldKey =
  | "receiving-note" | "quality-note" | "supplier-delivery-note" | "warehouse-note"
  | "delivery-note" | "packing-note" | "customer-request" | "transport-note"
  | "receipt-note" | "customer-comments" | "damage-note" | "exception-note";

export function printInstanceFields(documentType: PrintDocumentType, copy: PrintLayoutCopy) {
  return PRINT_INSTANCE_FIELD_KEYS[documentType].map((key: PrintInstanceFieldKey) => ({ key, label: copy(`printLayout.instance.${key}` as const) }));
}

export function instanceElementId(key: string) { return `instance-${key}`; }

// The per-print fields as elements of the template, added where missing.
export function withInstanceFields(template: PrintLayoutTemplate, documentType: PrintDocumentType, copy: PrintLayoutCopy) {
  const existing = new Set(template.elements.map((element) => element.id));
  const startY = Math.max(template.page.margin + 220, template.page.height - 265);
  const additions = printInstanceFields(documentType, copy)
    .filter((field) => !existing.has(instanceElementId(field.key)))
    .map((field, index): PrintLayoutElement => ({
      id: instanceElementId(field.key), type: "comment", title: field.label, placeholder: copy("printLayout.instancePlaceholder", { label: field.label }),
      contentMode: "instance", x: template.page.margin, y: startY + index * 54,
      width: template.page.width - template.page.margin * 2, height: 46, visible: true, draggable: true, resizable: true,
      style: { fontSize: 11, lineHeight: 1.45, align: "left", bordered: false },
    }));
  return { ...template, elements: [...template.elements, ...additions] };
}

export type NewPrintElementType = "text" | "comment" | "remark" | "terms" | "signature" | "line";
export const NEW_PRINT_ELEMENT_TYPES: readonly NewPrintElementType[] = ["text", "comment", "remark", "terms", "signature", "line"];

// An element added from the toolbar, its starting text in the interface language.
export function createPrintElement(kind: NewPrintElementType, index: number, copy: PrintLayoutCopy, now = Date.now()): PrintLayoutElement {
  const definitions: Record<NewPrintElementType, { type: PrintElementType; title: string; value?: string; placeholder?: string; mode?: "static" | "instance"; width: number; height: number }> = {
    text: { type: "text", title: copy("printLayout.element.text"), value: copy("printLayout.element.textValue"), mode: "static", width: 320, height: 54 },
    comment: { type: "comment", title: copy("printLayout.element.comment"), placeholder: copy("printLayout.element.commentPlaceholder"), mode: "instance", width: 420, height: 90 },
    remark: { type: "comment", title: copy("printLayout.element.remark"), mode: "instance", width: 420, height: 80 },
    terms: { type: "terms", title: copy("printLayout.element.terms"), value: copy("printLayout.element.termsValue"), mode: "static", width: 520, height: 110 },
    signature: { type: "signature", title: copy("printLayout.element.signature"), value: copy("printLayout.element.signatureValue"), mode: "static", width: 460, height: 58 },
    line: { type: "line", title: copy("printLayout.element.line"), width: 500, height: 20 },
  };
  const definition = definitions[kind];
  return {
    id: `${definition.type}-${now}-${index}`, type: definition.type, title: definition.title, value: definition.value,
    placeholder: definition.placeholder,
    contentMode: definition.mode, x: 72 + (index % 3) * 18, y: 300 + (index % 6) * 65,
    width: definition.width, height: definition.height, visible: true, draggable: true, resizable: true,
    style: { fontSize: definition.type === "terms" || definition.type === "comment" ? 11 : 12, lineHeight: 1.45, align: "left", bordered: definition.type === "comment" },
  };
}

// A typed number kept inside what a saved layout may hold (the shared check);
// a cleared input becomes the smallest value allowed, never an empty or zero font.
export function clampLayoutNumber(raw: string, min: number, max: number) {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
