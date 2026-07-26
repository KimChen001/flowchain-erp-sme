import { ArrowRight, ShieldAlert } from "lucide-react";
import { Link } from "react-router";
import { A, Card } from "../../components/ui";

type ImportsPanelProps = {
  initialView?: string;
  onNavigate?: (target: string) => void;
};

export default function ImportsPanel(_props: ImportsPanelProps) {
  return (
    <div className="mx-auto max-w-3xl py-10" data-testid="legacy-import-retired-page">
      <Card className="p-7">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "#fff8f0", color: A.orange }}>
            <ShieldAlert size={22} />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: A.orange }}>Legacy capability retired</div>
            <h1 className="mt-1 text-xl font-semibold" style={{ color: A.label }}>旧 Import 直接写入已停用</h1>
            <p className="mt-3 text-sm leading-6" style={{ color: A.sub }}>
              旧 Pilot Imports 不再创建预览批次、提交业务表或回滚历史批次。Universal Intake 是唯一面向未来的数据接入权威。
            </p>
            <div className="mt-4 rounded-xl p-4 text-xs leading-6" style={{ background: A.gray6, color: A.gray1 }}>
              CSV/XLSX parsing 将在 Phase 5.4B 开始；受治理的正式业务 commit adapters 将在 Phase 5.4C 开始。本版本所有正式业务提交仍 fail closed。
            </div>
            <Link to="/app/universal-intake" className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ background: A.blue }}>
              打开 Universal Intake Preview <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
