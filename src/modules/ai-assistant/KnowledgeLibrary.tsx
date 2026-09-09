import { useEffect, useState } from 'react';
import { apiJson } from '../../lib/api-client';
import { useI18n } from '../../i18n/I18n';

const endpoint = '/api/ai-runtime/knowledge';
type Source = { id: string; title: string; language: string; _count: { chunks: number } };
export type RagAnswer = { mode: string; citations: Array<{ id: string; documentId: string; title: string; position: number; excerpt: string }> };

function KnowledgeDocument({ id, onClose }: { id: string; onClose: () => void }) {
  const { language } = useI18n();
  const [document, setDocument] = useState<{ title: string; chunks: Array<{ id: string; position: number; content: string }> } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); apiJson<typeof document>(`${endpoint}/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setDocument).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [id]);
  return <div role="dialog" aria-modal="true" aria-label={language === 'zh-CN' ? '引用原文' : 'Source document'} className="pointer-events-auto fixed inset-4 z-[90] overflow-auto rounded-xl border bg-white p-5 shadow-2xl sm:inset-12">
    <button type="button" onClick={onClose} className="float-right rounded border px-3 py-1">{language === 'zh-CN' ? '关闭' : 'Close'}</button>
    <h2 className="mb-4 text-lg font-semibold">{document?.title || (language === 'zh-CN' ? '读取来源' : 'Loading source')}</h2>
    {error && <p role="alert">{error}</p>}
    {document?.chunks.map(chunk => <section key={chunk.id} className="mb-4 rounded-lg border p-3"><p className="mb-2 text-xs text-slate-500">{language === 'zh-CN' ? '段落' : 'Passage'} {chunk.position + 1}</p><p className="whitespace-pre-wrap break-words text-sm">{chunk.content}</p></section>)}
  </div>;
}

export function RagAnswerCard({ rag, title, summary }: { rag: RagAnswer; title: string; summary: string }) {
  const { language } = useI18n();
  const zh = language === 'zh-CN';
  const [source, setSource] = useState<string | null>(null);
  return <section data-testid="ai-knowledge-answer" className="space-y-3 rounded-xl border bg-white p-3">
    <h3 className="text-sm font-semibold">{title}</h3>
    {rag.mode !== 'generated' && rag.mode !== 'no_results' && <p className="text-xs text-amber-800">{zh ? '以下为检索原文摘录；模型未配置或本次生成结果不可用。' : 'These are retrieved excerpts. A model is not configured or its response was unavailable.'}</p>}
    <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>
    <div data-testid="ai-knowledge-citations" className="space-y-2">{rag.citations.map((citation, index) => <details key={citation.id} className="rounded-lg border p-2 text-xs"><summary className="cursor-pointer font-medium">[{index + 1}] {citation.title} · {zh ? '段落' : 'Passage'} {citation.position + 1}</summary><p className="my-2 whitespace-pre-wrap break-words">{citation.excerpt}</p><button type="button" onClick={() => setSource(citation.documentId)} className="text-blue-700 underline">{zh ? '打开来源' : 'Open source'}</button></details>)}</div>
    {source && <KnowledgeDocument id={source} onClose={() => setSource(null)} />}
  </section>;
}

export function KnowledgeLibrary({ onClose }: { onClose: () => void }) {
  const { language } = useI18n();
  const zh = language === 'zh-CN';
  const [items, setItems] = useState<Source[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [audience, setAudience] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const refresh = async () => { const result = await apiJson<{ items: Source[]; canManage: boolean }>(endpoint); setItems(result.items); setCanManage(result.canManage); };
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  async function save() {
    setBusy(true); setError('');
    try { await apiJson(endpoint, { method: 'POST', body: JSON.stringify({ title, content, language, requiredPermission: audience || null }) }); setTitle(''); setContent(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  return <div role="dialog" aria-modal="true" aria-label={zh ? '公司知识库' : 'Company knowledge library'} data-testid="knowledge-library" className="pointer-events-auto fixed inset-4 z-[80] overflow-auto rounded-xl border bg-white p-5 shadow-2xl sm:inset-12">
    <button type="button" onClick={onClose} className="float-right rounded border px-3 py-1">{zh ? '关闭' : 'Close'}</button>
    <h2 className="text-xl font-semibold">{zh ? '产品资料与公司知识库' : 'Product information & company knowledge'}</h2>
    <p className="my-3 text-sm text-slate-600">{zh ? '导入产品说明、术语表或公司手册。回答会引用当前工作区中你有权限阅读的资料。' : 'Import product guides, glossaries, or company handbooks. Answers cite documents you can read in this workspace.'}</p>
    {error && <p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
    {canManage && <div className="my-4 space-y-3 rounded-xl border p-4">
      <label className="block text-sm">{zh ? '标题' : 'Title'}<input data-testid="knowledge-title" value={title} maxLength={160} onChange={e => setTitle(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
      <label className="block text-sm">{zh ? '文本或 Markdown 文件' : 'Text or Markdown file'}<input type="file" accept=".txt,.md,text/plain,text/markdown" className="mt-1 block text-sm" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 300000) { setError(zh ? '文件过大，请分成较小的文档。' : 'File too large. Split it into smaller documents.'); return; } setContent(await file.text()); if (!title) setTitle(file.name); }} /></label>
      <label className="block text-sm">{zh ? '资料内容' : 'Document content'}<textarea data-testid="knowledge-content" value={content} maxLength={100000} onChange={e => setContent(e.target.value)} rows={7} className="mt-1 block w-full rounded border p-2" /></label>
      <label className="block text-sm">{zh ? '阅读范围' : 'Readers'}<select value={audience} onChange={e => setAudience(e.target.value)} className="ml-2 rounded border p-2"><option value="">{zh ? '工作区成员' : 'Workspace members'}</option><option value="finance.payable.read">{zh ? '应付账款阅读者' : 'Payables readers'}</option><option value="procurement.purchase_order.read">{zh ? '采购订单阅读者' : 'Purchase order readers'}</option></select></label>
      <button type="button" data-testid="knowledge-import" disabled={busy || !title.trim() || content.trim().length < 20} onClick={save} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? (zh ? '正在导入…' : 'Importing…') : (zh ? '导入并建立索引' : 'Import & index')}</button>
    </div>}
    <div className="space-y-2">{items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><button type="button" className="text-sm font-medium text-blue-700" onClick={() => setSource(item.id)}>{item.title}</button><span className="text-xs text-slate-500">{item._count.chunks} {zh ? '个段落' : 'passages'}</span>{canManage && <button type="button" className="text-xs text-slate-600" onClick={async () => { try { await apiJson(`${endpoint}/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Archive failed'); } }}>{zh ? '归档' : 'Archive'}</button>}</div>)}</div>
    {!items.length && <p className="text-sm text-slate-500">{zh ? '尚无可访问的资料。' : 'No accessible documents yet.'}</p>}
    {source && <KnowledgeDocument id={source} onClose={() => setSource(null)} />}
  </div>;
}
