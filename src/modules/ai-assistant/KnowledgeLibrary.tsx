import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../../lib/api-client';
import { useI18n } from '../../i18n/I18n';

const endpoint = '/api/ai-runtime/knowledge';
type Source = { id: string; title: string; language: string; indexStatus: 'semantic' | 'partial' | 'keyword' | 'outdated'; indexAttemptStatus?: string; indexAttemptError?: string; indexAttemptFinishedAt?: string; indexedChunks?: number; embeddingModel: string | null; embeddingDimensions: number | null; _count: { chunks: number } };
type Capabilities = { embeddingConfigured: boolean; vectorStorage: string; model: string | null; dimensions: number | null };
type PendingFile = { fileName: string; contentBase64: string };
export type RagAnswer = { mode: string; citations: Array<{ id: string; documentId: string; title: string; position: number; excerpt: string; sourceNumber?: number }> };

function KnowledgeDocument({ id, chunkId, onClose }: { id: string; chunkId?: string; onClose: () => void }) {
  const { language } = useI18n();
  const [document, setDocument] = useState<{ title: string; chunks: Array<{ id: string; position: number; content: string }> } | null>(null);
  const [error, setError] = useState('');
  const highlighted = useRef<HTMLElement | null>(null);
  useEffect(() => { highlighted.current?.scrollIntoView({ block: 'center' }); }, [document, chunkId]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose]);
  useEffect(() => { const controller = new AbortController(); apiJson<typeof document>(`${endpoint}/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setDocument).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [id]);
  return <div role="dialog" aria-modal="true" aria-label={language === 'zh-CN' ? '引用原文' : 'Source document'} className="pointer-events-auto fixed inset-4 z-[90] overflow-auto rounded-xl border bg-white p-5 shadow-2xl sm:inset-12">
    <button type="button" onClick={onClose} className="float-right rounded border px-3 py-1">{language === 'zh-CN' ? '关闭' : 'Close'}</button>
    <h2 className="mb-4 text-lg font-semibold">{document?.title || (language === 'zh-CN' ? '读取来源' : 'Loading source')}</h2>
    {error && <p role="alert">{error}</p>}
    {document && chunkId && !document.chunks.some(chunk => chunk.id === chunkId) && <p role="status" className="mb-3 text-sm text-amber-800">{language === 'zh-CN' ? '原文已更新，原引用段落不再可用。' : 'The source has changed. The cited passage is no longer available.'}</p>}
    {document?.chunks.map(chunk => <section key={chunk.id} ref={chunk.id === chunkId ? highlighted : undefined} data-cited={chunk.id === chunkId ? 'true' : undefined} className={`mb-4 rounded-lg border p-3 ${chunk.id === chunkId ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-100' : ''}`}><p className="mb-2 text-xs text-slate-500">{language === 'zh-CN' ? '段落' : 'Passage'} {chunk.position + 1}{chunk.id === chunkId ? (language === 'zh-CN' ? ' · 已引用' : ' · Cited passage') : ''}</p><p className="whitespace-pre-wrap break-words text-sm">{chunk.content}</p></section>)}
  </div>;
}

export function RagAnswerCard({ rag, title, summary }: { rag: RagAnswer; title: string; summary: string }) {
  const { language } = useI18n();
  const zh = language === 'zh-CN';
  const [source, setSource] = useState<{ documentId: string; chunkId: string } | null>(null);
  return <section data-testid="ai-knowledge-answer" className="space-y-3 rounded-xl border bg-white p-3">
    <h3 className="text-sm font-semibold">{title}</h3>
    {rag.mode !== 'generated' && rag.mode !== 'no_results' && rag.mode !== 'unavailable' && <p className="text-xs text-amber-800">{zh ? '以下为检索原文摘录；模型未配置或本次生成结果不可用。' : 'These are retrieved excerpts. A model is not configured or its response was unavailable.'}</p>}
    <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>
    <div data-testid="ai-knowledge-citations" className="space-y-2">{rag.citations.map((citation, index) => <details key={citation.id} className="rounded-lg border p-2 text-xs"><summary className="cursor-pointer font-medium">[{citation.sourceNumber || index + 1}] {citation.title} · {zh ? '段落' : 'Passage'} {citation.position + 1}</summary><p className="my-2 whitespace-pre-wrap break-words">{citation.excerpt}</p><button type="button" onClick={() => setSource({ documentId: citation.documentId, chunkId: citation.id })} className="text-blue-700 underline">{zh ? '打开引用段落' : 'Open cited passage'}</button></details>)}</div>
    {source && <KnowledgeDocument id={source.documentId} chunkId={source.chunkId} onClose={() => setSource(null)} />}
  </section>;
}

export function KnowledgeLibrary({ onClose }: { onClose: () => void }) {
  const { language } = useI18n();
  const zh = language === 'zh-CN';
  const [items, setItems] = useState<Source[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [audience, setAudience] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const refresh = useCallback(async () => { const result = await apiJson<{ items: Source[]; canManage: boolean; capabilities?: Capabilities }>(endpoint); setItems(result.items); setCanManage(result.canManage); setCapabilities(result.capabilities || null); }, []);
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!items.some(item => item.indexAttemptStatus === 'processing') && !busy) return;
    const timer = window.setInterval(() => refresh().catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [items, busy, refresh]);
  function failureText(code?: string) {
    if (code === 'KNOWLEDGE_EMBEDDING_NOT_CONFIGURED') return zh ? '未配置 embedding；资料仍可用于关键词检索。' : 'Embedding is not configured. Keyword search remains available.';
    if (code === 'interrupted') return zh ? '上次索引任务被中断，可以重试。' : 'The previous indexing attempt was interrupted. Retry to continue.';
    return zh ? '上次索引未完成。原有索引已保留，可以重试。' : 'The last indexing attempt failed. The previous index was kept. You can retry.';
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const body = { title, language, requiredPermission: audience || null, ...(pendingFile || { content }) };
      await apiJson(pendingFile ? `${endpoint}/import` : endpoint, { method: 'POST', body: JSON.stringify(body) });
      setTitle(''); setContent(''); setPendingFile(null); await refresh();
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setBusy(false); }
  }
  return <div role="dialog" aria-modal="true" aria-label={zh ? '公司知识库' : 'Company knowledge library'} data-testid="knowledge-library" className="pointer-events-auto fixed inset-4 z-[80] overflow-auto rounded-xl border bg-white p-5 shadow-2xl sm:inset-12">
    <button type="button" onClick={onClose} className="float-right rounded border px-3 py-1">{zh ? '关闭' : 'Close'}</button>
    <h2 className="text-xl font-semibold">{zh ? '产品资料与公司知识库' : 'Product information & company knowledge'}</h2>
    <p className="my-3 text-sm text-slate-600">{zh ? '导入产品说明、术语表或公司手册。回答会引用当前工作区中你有权限阅读的资料。' : 'Import product guides, glossaries, or company handbooks. Answers cite documents you can read in this workspace.'}</p>
    {capabilities && <div data-testid="knowledge-readiness" className="mb-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><strong>{zh ? '检索状态' : 'Search readiness'}</strong><p className="mt-1">{capabilities.embeddingConfigured ? (zh ? 'Embedding 服务已配置，完成索引后可使用语义检索。' : 'Embedding is configured. Semantic search is available after successful indexing.') : (zh ? '当前使用关键词检索。配置 embedding 服务后可建立语义索引。' : 'Keyword search is active. Configure an embedding provider to build semantic indexes.')}</p>{canManage && <p className="mt-1 text-xs text-slate-500">{capabilities.model || (zh ? '未选择模型' : 'No embedding model selected')} · {capabilities.vectorStorage === 'pgvector' ? 'PostgreSQL / pgvector' : (zh ? '本地向量检索（未启用 pgvector）' : 'Local vector search (pgvector not enabled)')}</p>}</div>}
    <button type="button" onClick={() => refresh().catch(e => setError(e.message))} className="mb-3 text-sm text-blue-700">{zh ? '刷新状态' : 'Refresh status'}</button>
    {error && <p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
    {canManage && <div className="my-4 space-y-3 rounded-xl border p-4">
      <label className="block text-sm">{zh ? '标题' : 'Title'}<input data-testid="knowledge-title" value={title} maxLength={160} onChange={e => setTitle(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
      <label className="block text-sm">{zh ? '资料文件' : 'Document file'}<input type="file" accept=".txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="mt-1 block text-sm" onChange={e => { const file = e.target.files?.[0]; if (!file) return; setError(''); if (file.size > 5 * 1024 * 1024) { setPendingFile(null); setError(zh ? '文件不能超过 5 MB，请拆分后再导入。' : 'Files are limited to 5 MB. Split the document before importing.'); return; } const reader = new FileReader(); reader.onload = () => { const value = String(reader.result || ''); setPendingFile({ fileName: file.name, contentBase64: value.slice(value.indexOf(',') + 1) }); setContent(''); if (!title) setTitle(file.name.replace(/\.[^.]+$/, '')); }; reader.onerror = () => setError(zh ? '无法读取文件。' : 'The file could not be read.'); reader.readAsDataURL(file); }} />{pendingFile && <span className="mt-1 block text-xs text-slate-500">{zh ? '已选择：' : 'Selected: '}{pendingFile.fileName}</span>}</label>
      <label className="block text-sm">{zh ? '资料内容' : 'Document content'}<textarea data-testid="knowledge-content" value={content} maxLength={100000} onChange={e => { setContent(e.target.value); setPendingFile(null); }} rows={7} placeholder={pendingFile ? (zh ? '将从所选文件中提取文字' : 'Text will be extracted from the selected file') : undefined} className="mt-1 block w-full rounded border p-2" /></label>
      <label className="block text-sm">{zh ? '阅读范围' : 'Readers'}<select value={audience} onChange={e => setAudience(e.target.value)} className="ml-2 rounded border p-2"><option value="">{zh ? '工作区成员' : 'Workspace members'}</option><option value="finance.payable.read">{zh ? '应付账款阅读者' : 'Payables readers'}</option><option value="procurement.purchase_order.read">{zh ? '采购订单阅读者' : 'Purchase order readers'}</option></select></label>
      <button type="button" data-testid="knowledge-import" disabled={busy || !title.trim() || (!pendingFile && content.trim().length < 20)} onClick={save} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? (zh ? '正在导入…' : 'Importing…') : (zh ? '导入并建立索引' : 'Import & index')}</button>
    </div>}
    <div className="space-y-3">{items.map(item => {
      const processing = workingId === item.id || item.indexAttemptStatus === 'processing';
      const ready = item.indexStatus === 'semantic';
      return <article key={item.id} data-testid="knowledge-document-row" className="rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" className="text-left text-sm font-semibold text-blue-700" onClick={() => setSource(item.id)}>{item.title}</button>
          <span className={`rounded-full px-2 py-1 text-xs ${ready ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{processing ? (zh ? '索引中' : 'Processing') : ready ? (zh ? '语义索引就绪' : 'Ready · semantic') : item.indexStatus === 'outdated' ? (zh ? '需重建索引' : 'Reindex required') : item.indexStatus === 'partial' ? (zh ? '部分索引' : 'Partial index') : (zh ? '关键词检索可用' : 'Keyword search available')}</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">{item.indexedChunks || 0} / {item._count.chunks} {zh ? '个段落已向量化' : 'passages embedded'}{item.embeddingModel ? ` · ${item.embeddingModel} · ${item.embeddingDimensions}d` : ''}</p>
        {item.indexAttemptStatus === 'failed' && !processing && <p role="status" className="mt-2 text-xs text-amber-800">{failureText(item.indexAttemptError)}</p>}
        {canManage && <div className="mt-3 flex gap-4">
          <button type="button" disabled={busy || processing} className="text-xs text-blue-700 disabled:opacity-50" onClick={async () => {
            setBusy(true); setWorkingId(item.id); setError('');
            try { await apiJson(`${endpoint}/${encodeURIComponent(item.id)}/reindex`, { method: 'POST' }); }
            catch (e) { setError(e instanceof Error ? e.message : (zh ? '索引失败' : 'Reindex failed')); }
            finally { await refresh().catch(() => {}); setBusy(false); setWorkingId(null); }
          }}>{processing ? (zh ? '索引中…' : 'Indexing…') : item.indexAttemptStatus === 'failed' ? (zh ? '重试索引' : 'Retry indexing') : (zh ? '重建索引' : 'Reindex')}</button>
          <button type="button" disabled={busy || processing} className="text-xs text-slate-600 disabled:opacity-50" onClick={async () => {
            setBusy(true); setError('');
            try { await apiJson(`${endpoint}/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : (zh ? '归档失败' : 'Archive failed')); }
            finally { setBusy(false); }
          }}>{zh ? '归档' : 'Archive'}</button>
        </div>}
      </article>;
    })}</div>
    {!items.length && <p className="text-sm text-slate-500">{zh ? '尚无可访问的资料。' : 'No accessible documents yet.'}</p>}
    {source && <KnowledgeDocument id={source} onClose={() => setSource(null)} />}
  </div>;
}
