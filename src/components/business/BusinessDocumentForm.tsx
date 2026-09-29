import { useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useUnsavedChanges } from "../navigation/UnsavedChangesProvider";
import { A, Card } from "../ui";
import { useI18n } from "../../i18n/I18n";
import { todayInTimeZone } from "../../lib/format";

export function BusinessDocumentForm({ documentLabel, documentId, listPath, mode = "new" }: {
  documentLabel: string;
  documentId?: string;
  listPath: string;
  mode?: "new" | "edit";
}) {
  const navigate = useNavigate();
  const { timezone } = useI18n();
  const [reference, setReference] = useState(documentId || "");
  const [businessDate, setBusinessDate] = useState(() => todayInTimeZone(timezone));
  const [party, setParty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [dirty, setDirty] = useState(false);

  function saveDraft() {
    setDirty(false);
    toast.success(`${documentLabel}${mode === "new" ? "草稿已保存" : "修改已保存"}`, { description: "当前工作区只保存表单草稿，不自动过账。" });
  }

  useUnsavedChanges({ key: `business-form:${listPath}:${documentId || "new"}`, label: `${mode === "new" ? "新建" : "编辑"}${documentLabel}`, dirty, onSave: saveDraft });
  const change = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setter(event.target.value); setDirty(true); };

  return <Card className="p-6" data-testid="business-document-form">
    <div className="mb-5 flex items-center justify-between gap-4">
      <button type="button" className="fc-action-button fc-action-secondary" onClick={() => navigate(listPath)}><ArrowLeft size={14} />返回列表</button>
      <span className="fc-caption" style={{ color: dirty ? A.orange : A.gray2 }}>{dirty ? "有未保存修改" : "修改已保存"}</span>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <label className="fc-label">单据编号<input className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={reference} placeholder={mode === "new" ? "保存后自动生成" : undefined} onChange={change(setReference)} /></label>
      <label className="fc-label">业务日期<input type="date" className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={businessDate} onChange={change(setBusinessDate)} /></label>
      <label className="fc-label md:col-span-2">业务对象<input className="mt-1 h-9 w-full rounded-lg border px-3 fc-input-text" value={party} placeholder="客户、供应商或仓库" onChange={change(setParty)} /></label>
      <label className="fc-label md:col-span-2">备注<textarea className="mt-1 min-h-28 w-full rounded-lg border p-3 fc-input-text" value={remarks} onChange={change(setRemarks)} /></label>
    </div>
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className="fc-action-button fc-action-secondary" onClick={() => navigate(listPath)}>取消</button>
      <button type="button" className="fc-action-button fc-action-primary" onClick={saveDraft}><Save size={14} />保存草稿</button>
    </div>
  </Card>;
}
