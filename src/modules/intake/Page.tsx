import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FileArchive, Layers3, RefreshCw, ShieldCheck } from "lucide-react";
import { A, Card } from "../../components/ui";
import { typography } from "../../components/ui/typography";
import { apiJson } from "../../lib/api-client";

type Artifact = {
  id: string;
  sourceType: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
};

type Batch = {
  id: string;
  artifactId: string;
  batchType: string;
  status: string;
  recordCount: number;
  validRecordCount: number;
  warningCount: number;
  errorCount: number;
  reviewStatus?: string | null;
  createdAt: string;
};

type MappingProfile = {
  id: string;
  name: string;
  recordType: string;
  version: number;
  status: string;
  fieldMappings: Array<{ id: string }>;
};

type ValidationIssue = {
  id: string;
  severity: "error" | "warning" | "info";
  code: string;
  field?: string | null;
  message: string;
  resolved: boolean;
};

const limitations = [
  "CSV/XLSX parsing: not yet enabled",
  "Business commit adapters: not yet enabled",
  "Email intake: not yet enabled",
  "PDF/OCR: not yet enabled",
];

const formatBytes = (value: number) => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;

export default function UniversalIntakePage() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [mappings, setMappings] = useState<MappingProfile[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [artifactResult, batchResult, mappingResult] = await Promise.all([
        apiJson<{ artifacts: Artifact[] }>("/api/intake/artifacts?limit=25"),
        apiJson<{ batches: Batch[] }>("/api/intake/batches?limit=25"),
        apiJson<{ mappingProfiles: MappingProfile[] }>("/api/intake/mapping-profiles?limit=25"),
      ]);
      setArtifacts(artifactResult.artifacts);
      setBatches(batchResult.batches);
      setMappings(mappingResult.mappingProfiles);
      setSelectedBatchId(current => current || batchResult.batches[0]?.id || "");
    } catch (next) {
      setError(next instanceof Error ? next.message : "Intake foundation data is unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selectedBatchId) { setIssues([]); return; }
    apiJson<{ issues: ValidationIssue[] }>(`/api/intake/batches/${encodeURIComponent(selectedBatchId)}/issues?limit=100`)
      .then(result => setIssues(result.issues))
      .catch(() => setIssues([]));
  }, [selectedBatchId]);

  const selectedBatch = useMemo(() => batches.find(batch => batch.id === selectedBatchId) || null, [batches, selectedBatchId]);
  const openIssues = issues.filter(issue => !issue.resolved);

  return (
    <div className="space-y-5" data-testid="universal-intake-foundation">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-wide" style={{ color: A.blue }}>PREVIEW · POSTGRESQL AUTHORITY</div>
          <h1 className="mt-1 text-2xl font-semibold" style={{ color: A.label }}>Universal Intake Foundation</h1>
          <p className={`${typography.body} mt-2 max-w-3xl`} style={{ color: A.sub }}>
            原始来源、处理批次、映射、校验与人工复核的受控基础。这里展示数据库中的真实记录，不执行正式业务导入。
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: A.border, color: A.blue }}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />刷新
        </button>
      </div>

      <Card className="p-4" style={{ background: "#fff9ed" }}>
        <div className="flex gap-3">
          <ShieldCheck size={20} style={{ color: A.orange }} />
          <div>
            <div className="text-sm font-semibold" style={{ color: A.label }}>当前产品边界</div>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {limitations.map(item => <div key={item} className="text-xs" style={{ color: A.sub }}>{item}</div>)}
            </div>
          </div>
        </div>
      </Card>

      {error && <Card className="p-4" data-testid="intake-load-error"><div className="flex gap-2 text-sm" style={{ color: A.red }}><AlertCircle size={18} />{error}</div></Card>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2"><FileArchive size={18} style={{ color: A.blue }} /><h2 className={typography.sectionTitle}>Artifacts</h2></div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>{artifacts.length} 个来源对象</div>
          <div className="mt-4 space-y-3">
            {artifacts.length === 0 && <div className="text-sm" style={{ color: A.gray2 }}>暂无 artifact metadata。</div>}
            {artifacts.map(artifact => (
              <div key={artifact.id} className="rounded-lg border p-3" style={{ borderColor: A.border }}>
                <div className="truncate text-sm font-medium" style={{ color: A.label }}>{artifact.originalFilename}</div>
                <div className="mt-1 text-xs" style={{ color: A.sub }}>{artifact.sourceType} · {formatBytes(artifact.sizeBytes)}</div>
                <div className="mt-1 truncate font-mono text-[10px]" style={{ color: A.gray2 }}>SHA-256 {artifact.checksumSha256}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2"><Layers3 size={18} style={{ color: A.blue }} /><h2 className={typography.sectionTitle}>Intake batches</h2></div>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>{batches.length} 个 PostgreSQL batch</div>
          <div className="mt-4 space-y-2">
            {batches.length === 0 && <div className="text-sm" style={{ color: A.gray2 }}>暂无 intake batch。</div>}
            {batches.map(batch => (
              <button key={batch.id} type="button" onClick={() => setSelectedBatchId(batch.id)} className="w-full rounded-lg border p-3 text-left" style={{ borderColor: selectedBatchId === batch.id ? A.blue : A.border, background: selectedBatchId === batch.id ? "#f5f9ff" : A.white }}>
                <div className="flex justify-between gap-3"><span className="truncate text-sm font-medium">{batch.batchType}</span><span className="text-xs" style={{ color: A.blue }}>{batch.status}</span></div>
                <div className="mt-1 text-xs" style={{ color: A.sub }}>记录 {batch.recordCount} · 有效 {batch.validRecordCount} · 错误 {batch.errorCount}</div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className={typography.sectionTitle}>Mapping profiles</h2>
          <div className="mt-1 text-xs" style={{ color: A.sub }}>版本化声明式映射，不保存可执行代码</div>
          <div className="mt-4 space-y-3">
            {mappings.length === 0 && <div className="text-sm" style={{ color: A.gray2 }}>暂无 mapping profile。</div>}
            {mappings.map(mapping => (
              <div key={mapping.id} className="rounded-lg border p-3" style={{ borderColor: A.border }}>
                <div className="flex justify-between gap-2"><span className="text-sm font-medium">{mapping.name}</span><span className="text-xs" style={{ color: A.blue }}>{mapping.status}</span></div>
                <div className="mt-1 text-xs" style={{ color: A.sub }}>{mapping.recordType} · v{mapping.version} · {mapping.fieldMappings.length} fields</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className={typography.sectionTitle}>Batch detail and validation</h2>
        {!selectedBatch && <div className="mt-3 text-sm" style={{ color: A.gray2 }}>选择 batch 后查看校验与 review 状态。</div>}
        {selectedBatch && (
          <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
            <div className="rounded-lg p-4" style={{ background: A.gray6 }}>
              <div className="text-xs" style={{ color: A.sub }}>Batch</div>
              <div className="mt-1 break-all text-sm font-medium">{selectedBatch.id}</div>
              <div className="mt-3 text-xs" style={{ color: A.sub }}>Review status</div>
              <div className="mt-1 text-sm">{selectedBatch.reviewStatus || "not opened"}</div>
              <div className="mt-3 text-xs" style={{ color: A.sub }}>Open issues</div>
              <div className="mt-1 text-sm">{openIssues.length}</div>
            </div>
            <div className="space-y-2">
              {issues.length === 0 && <div className="text-sm" style={{ color: A.gray2 }}>没有 validation issues。</div>}
              {issues.map(issue => (
                <div key={issue.id} className="rounded-lg border p-3" style={{ borderColor: A.border }}>
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-xs" style={{ color: issue.severity === "error" ? A.red : A.orange }}>{issue.code}</span>
                    <span className="text-xs" style={{ color: A.sub }}>{issue.resolved ? "resolved" : issue.severity}</span>
                  </div>
                  <div className="mt-1 text-sm">{issue.message}</div>
                  {issue.field && <div className="mt-1 text-xs" style={{ color: A.sub }}>字段：{issue.field}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
