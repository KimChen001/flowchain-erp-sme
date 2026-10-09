import { Eye, EyeOff, Trash2 } from "lucide-react";
import { PRINT_LAYOUT_LIMITS, PRINT_LAYOUT_STYLE_LIMITS } from "../../../shared/business-documents.mjs";
import { clampLayoutNumber } from "./printLayoutElements";
import type { PrintFieldOption, PrintLayoutElement } from "./printLayoutTypes";

const numberKeys = ["x", "y", "width", "height"] as const;

const FONT = PRINT_LAYOUT_STYLE_LIMITS.fontSize;
const LINE = PRINT_LAYOUT_STYLE_LIMITS.lineHeight;
const COORDINATE = PRINT_LAYOUT_LIMITS.coordinate;

export default function PrintElementInspector({
  elements, selected, fieldOptions, instanceValue, onSelect, onChange, onInstanceValueChange, onDelete,
}: {
  elements: PrintLayoutElement[];
  selected?: PrintLayoutElement;
  fieldOptions: PrintFieldOption[];
  instanceValue?: string;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<PrintLayoutElement>) => void;
  onInstanceValueChange: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <aside className="print-layout-inspector" data-testid="print-layout-inspector">
      <div className="print-inspector-section">
        <div className="print-inspector-title">版式元素</div>
        <div className="print-layer-list">
          {elements.map((element) => (
            <button key={element.id} type="button" className={selected?.id === element.id ? "active" : ""} onClick={() => onSelect(element.id)}>
              <span>{element.title}</span>{element.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
          ))}
        </div>
      </div>
      {!selected ? <div className="print-inspector-empty">选择画布元素后编辑属性。</div> : (
        <div className="print-inspector-section print-property-form">
          <div className="print-inspector-title">元素属性</div>
          <label>元素类型<input value={selected.type} disabled /></label>
          <label>元素名称<input data-testid="print-element-name-input" value={selected.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
          {selected.type !== "table" && selected.type !== "line" && selected.type !== "pageNumber" && selected.type !== "barcode" && selected.type !== "qrcode" && (
            <label>内容来源<select data-testid="print-content-mode-select" value={selected.contentMode || (selected.type === "field" ? "field" : "static")} onChange={(event) => onChange({ contentMode: event.target.value as "static" | "field" | "instance" })}>
              <option value="static">模板固定内容</option><option value="field">业务数据</option><option value="instance">本次打印内容</option>
            </select></label>
          )}
          {(["text", "comment", "terms", "footer", "signature"].includes(selected.type) && selected.contentMode !== "field") && (
            <label>{selected.contentMode === "instance" ? "本次打印文字" : selected.id === "title" ? "自定义标题" : "显示文字"}
              <textarea data-testid={selected.id === "title" ? "print-title-input" : "print-value-input"} rows={5} value={selected.contentMode === "instance" ? instanceValue || "" : selected.value || ""} placeholder={selected.placeholder} onChange={(event) => selected.contentMode === "instance" ? onInstanceValueChange(event.target.value) : onChange({ value: event.target.value })} />
            </label>
          )}
          {(selected.contentMode === "field" || selected.type === "field") && (
            <label>字段绑定<select value={selected.field || ""} onChange={(event) => onChange({ field: event.target.value })}>
              {fieldOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select></label>
          )}
          <div className="print-property-grid">
            {numberKeys.map((key) => (
              <label key={key}>{key}<input data-testid={`print-${key}-input`} type="number" min={0} value={selected[key]} onChange={(event) => onChange({ [key]: clampLayoutNumber(event.target.value, 0, COORDINATE) })} /></label>
            ))}
          </div>
          <label>字号<input data-testid="print-font-size-input" type="number" min={FONT.min} max={FONT.max} value={selected.style?.fontSize || 12} onChange={(event) => onChange({ style: { ...selected.style, fontSize: clampLayoutNumber(event.target.value, FONT.min, FONT.max) } })} /></label>
          <label>行高<input data-testid="print-line-height-input" type="number" min={LINE.min} max={LINE.max} step={0.1} value={selected.style?.lineHeight || 1.45} onChange={(event) => onChange({ style: { ...selected.style, lineHeight: clampLayoutNumber(event.target.value, LINE.min, LINE.max) } })} /></label>
          <label>对齐<select data-testid="print-align-select" value={selected.style?.align || "left"} onChange={(event) => onChange({ style: { ...selected.style, align: event.target.value as "left" | "center" | "right" } })}>
            <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
          </select></label>
          <label className="print-check"><input type="checkbox" checked={Boolean(selected.style?.bold)} onChange={(event) => onChange({ style: { ...selected.style, bold: event.target.checked } })} />粗体</label>
          <label className="print-check"><input data-testid="print-border-toggle" type="checkbox" checked={Boolean(selected.style?.bordered)} onChange={(event) => onChange({ style: { ...selected.style, bordered: event.target.checked } })} />边框</label>
          <label className="print-check"><input data-testid="print-visible-toggle" type="checkbox" checked={selected.visible} onChange={(event) => onChange({ visible: event.target.checked })} />显示元素</label>
          {selected.type === "table" && (
            <div className="print-column-editor" data-testid="print-column-editor">
              <div className="print-inspector-title">表格列</div>
              {(selected.tableColumns || []).map((column, index) => (
                <div key={column.key} className="print-column-row">
                  <input aria-label={`${column.key}列标题`} value={column.title} onChange={(event) => {
                    const tableColumns = [...(selected.tableColumns || [])]; tableColumns[index] = { ...column, title: event.target.value }; onChange({ tableColumns });
                  }} />
                  <input aria-label={`${column.key}列宽`} type="number" min={40} value={column.width || 80} onChange={(event) => {
                    const tableColumns = [...(selected.tableColumns || [])]; tableColumns[index] = { ...column, width: clampLayoutNumber(event.target.value, 0, COORDINATE) }; onChange({ tableColumns });
                  }} />
                  <label className="print-check"><input aria-label={`${column.key}列显示`} type="checkbox" checked={column.visible} onChange={(event) => {
                    const tableColumns = [...(selected.tableColumns || [])]; tableColumns[index] = { ...column, visible: event.target.checked }; onChange({ tableColumns });
                  }} />显示</label>
                </div>
              ))}
            </div>
          )}
          {!selected.required && <button type="button" className="print-danger-button" onClick={onDelete}><Trash2 size={13} /> 删除元素</button>}
        </div>
      )}
    </aside>
  );
}
