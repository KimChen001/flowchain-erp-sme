import type React from "react";
import type { PrintDocumentData, PrintLayoutElement, PrintLayoutTemplate } from "./printLayoutTypes";
import { useI18n } from "../../i18n/I18n";

// The words the canvas prints itself, in the interface language (design audit L16).
const CANVAS_COPY = {
  pageNumber: ["Page 1 of 1", "第 1 页 / 共 1 页"],
  colon: [": ", "："],
  barcode: ["Barcode placeholder", "条码占位"],
  qrcode: ["QR code placeholder", "二维码占位"],
} as const;

function textValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function ElementContent({ element, data, instanceValues }: { element: PrintLayoutElement; data: PrintDocumentData; instanceValues: Record<string, string> }) {
  const { language } = useI18n();
  const say = (key: keyof typeof CANVAS_COPY) => CANVAS_COPY[key][language === "en-US" ? 0 : 1];
  const style: React.CSSProperties = {
    fontSize: element.style?.fontSize || 12,
    fontWeight: element.style?.bold ? 700 : element.style?.fontWeight || 400,
    textAlign: element.style?.align || "left",
    lineHeight: element.style?.lineHeight || 1.45,
  };
  if (element.type === "table") {
    const columns = (element.tableColumns || []).filter((column) => column.visible);
    return (
      <table className="print-data-table" data-testid="print-data-table" style={{ fontSize: element.style?.fontSize || 11 }}>
        <thead><tr>{columns.map((column) => <th key={column.key} style={{ width: column.width, textAlign: column.align || "left" }}>{column.title}</th>)}</tr></thead>
        <tbody>{data.lines.map((row, index) => (
          <tr key={`${String(row.sku || "line")}-${index}`}>{columns.map((column) => <td key={column.key} style={{ width: column.width, textAlign: column.align || "left" }}>{textValue(row[column.key])}</td>)}</tr>
        ))}</tbody>
      </table>
    );
  }
  if (element.type === "line") return <div style={{ borderTop: `${element.style?.borderWidth || 1}px solid #111`, marginTop: element.height / 2 }} />;
  if (element.type === "pageNumber") return <div style={style} data-testid="print-page-number">{say("pageNumber")}</div>;
  if (element.type === "barcode") return <div className="print-placeholder-code" style={style}><small>{say("barcode")}</small><br />||||| {textValue(data[element.field || "documentNo"])}</div>;
  if (element.type === "qrcode") return <div className="print-placeholder-qr" style={style}><small>{say("qrcode")}</small><br />QR<br />{textValue(data[element.field || "documentNo"])}</div>;
  const mode = element.contentMode || (element.type === "field" ? "field" : "static");
  const value = mode === "instance" ? instanceValues[element.id] : mode === "field" ? data[element.field || ""] : element.value;
  if (element.type === "field" || mode === "field") return <div style={style}><span className="print-field-label">{element.title}{say("colon")}</span>{textValue(value)}</div>;
  if (element.type === "signature") return <div className="print-multiline-content" style={style}>{value ? String(value) : element.title}</div>;
  return <div className="print-multiline-content" style={style}>{value ? String(value) : element.placeholder || element.title}</div>;
}

export default function PrintCanvas({
  template, data, instanceValues, selectedId, scale, onSelect, onElementChange,
}: {
  template: PrintLayoutTemplate;
  data: PrintDocumentData;
  instanceValues: Record<string, string>;
  selectedId: string;
  scale: number;
  onSelect: (id: string) => void;
  onElementChange: (id: string, patch: Partial<PrintLayoutElement>) => void;
}) {
  function startPointer(event: React.PointerEvent, element: PrintLayoutElement, mode: "move" | "resize") {
    if ((mode === "move" && !element.draggable) || (mode === "resize" && !element.resizable)) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(element.id);
    const start = { x: event.clientX, y: event.clientY, left: element.x, top: element.y, width: element.width, height: element.height };
    const move = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - start.x) / scale;
      const dy = (pointer.clientY - start.y) / scale;
      if (mode === "move") {
        onElementChange(element.id, {
          x: Math.max(0, Math.min(template.page.width - element.width, Math.round(start.left + dx))),
          y: Math.max(0, Math.min(template.page.height - element.height, Math.round(start.top + dy))),
        });
      } else {
        onElementChange(element.id, {
          width: Math.max(40, Math.min(template.page.width - element.x, Math.round(start.width + dx))),
          height: Math.max(20, Math.min(template.page.height - element.y, Math.round(start.height + dy))),
        });
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  return (
    <div className="print-canvas-scaled" style={{ width: template.page.width * scale, height: template.page.height * scale }}>
      <div
        className="print-canvas-sheet"
        data-testid="print-canvas"
        data-orientation={template.page.orientation}
        style={{ width: template.page.width, height: template.page.height, transform: `scale(${scale})` }}
        onPointerDown={() => onSelect("")}
      >
        {template.elements.filter((element) => element.visible).map((element) => (
          <div
            key={element.id}
            className={`print-layout-element ${selectedId === element.id ? "is-selected" : ""} ${element.style?.bordered ? "is-bordered" : ""}`}
            data-testid={`print-element-${element.id}`}
            data-element-id={element.id}
            data-instance-empty={(element.contentMode === "instance" && !instanceValues[element.id]) || undefined}
            role="button"
            tabIndex={0}
            onPointerDown={(event) => startPointer(event, element, "move")}
            onClick={(event) => { event.stopPropagation(); onSelect(element.id); }}
            style={{ left: element.x, top: element.y, width: element.width, height: element.height, borderWidth: element.style?.borderWidth }}
          >
            <ElementContent element={element} data={data} instanceValues={instanceValues} />
            {selectedId === element.id && element.resizable && (
              <span className="print-resize-handle" data-testid="print-resize-handle" onPointerDown={(event) => startPointer(event, element, "resize")} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
