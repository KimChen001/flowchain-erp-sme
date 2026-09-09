import { A, Card, Chip } from "../../components/ui";
import type { SupplierSrmRow } from "../../domain/srm/helpers";
import { fmt } from "../../lib/format";
import {
  tdActionClass,
  tdNameClass,
  tdNowrapClass,
  tdNumericClass,
  thClass,
} from "../../components/ui/workbenchTable";
import { workspaceCopy } from "../../i18n/workspaceCopy";

const copy = (label: string) => workspaceCopy(label, typeof document === "undefined" ? "en-US" : document.documentElement.lang);

export type SupplierTableMode = "master" | "performance" | "certification";

function statusStyle(status: string) {
  if (["低", "已认证", "启用", "战略", "核心", "执行中"].includes(status)) return { color: A.green, bg: "#f0faf4" };
  if (["高", "整改中", "整改", "已到期"].includes(status)) return { color: A.red, bg: "#fff1f0" };
  return { color: A.orange, bg: "#fff8f0" };
}

export default function SupplierTable({ rows, onDetail, mode }: { rows: SupplierSrmRow[]; onDetail: (row: SupplierSrmRow) => void; mode: SupplierTableMode }) {
  const visible = mode === "certification"
      ? rows.filter((row) => row.supplier.certificationStatus !== "已认证" || row.supplier.status !== "启用")
      : rows;
  const headers = mode === "master"
    ? ["供应商编号 / 供应商编码", "供应商名称", "供应商类型 / 品类", "状态", "主要联系人", "默认币种", "采购负责人", "相关 RFQ 数", "相关 PO 数", "未完成 PO 数", "收货异常数", "发票差异数", "已收未票金额", "最近交易日期", "风险等级", "下一步", "操作"]
    : mode === "certification"
      ? ["供应商", "认证状态", "准入状态", "缺失资料", "到期风险", "整改事项", "复核项目", "负责人", "下一步", "操作"]
      : ["供应商", "评分", "准时率", "质量合格率", "响应分", "风险状态", "开放 PO", "发票差异", "对账异常", "下一步", "操作"];

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[1480px]">
          <thead>
            <tr style={{ borderBottom: "0.5px solid rgba(0,0,0,0.06)" }}>
              {headers.map((header) => (
                <th key={header} className={thClass} style={{ color: A.gray1 }}>{copy(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => {
              const riskStyle = statusStyle(row.supplier.riskStatus);
              const certStyle = statusStyle(row.supplier.certificationStatus);
              const recordStyle = statusStyle(row.supplier.status);
              const supplierType = row.flag === "整改" ? "整改关注" : row.flag === "战略" ? "战略" : "核心";
              const missingDocs = row.supplier.certificationStatus === "已认证" ? "无" : "营业执照 / 质量体系";
              const expiryRisk = row.supplier.certificationStatus === "整改中" ? "证照即将到期" : row.supplier.certificationStatus === "待复核" ? "需年度复核" : "低";
              const remediation = row.supplier.certificationStatus === "已认证" ? "年度复核" : row.nextAction;
              if (mode === "master") {
                return (
                  <tr key={row.supplier.code} style={{ borderBottom: index < visible.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={tdNowrapClass} style={{ color: A.blue }}>{row.supplier.code}</td>
                    <td className={`${tdNameClass} max-w-[220px] font-semibold`} style={{ color: A.label }}>{row.supplier.name}</td>
                    <td className={`${tdNameClass} max-w-[180px]`} style={{ color: A.sub }}>{copy(supplierType)} / {row.category}</td>
                    <td className={tdNowrapClass}><Chip label={row.operationalStatus} color={recordStyle.color} bg={recordStyle.bg} /></td>
                    <td className={tdNowrapClass} style={{ color: A.label }}>{row.supplier.contact}</td>
                    <td className={tdNowrapClass} style={{ color: A.label }}>{row.supplier.currency}</td>
                    <td className={tdNowrapClass} style={{ color: A.label }}>{row.buyerOwner}</td>
                    <td className={tdNumericClass} style={{ color: A.label }}>{row.p2pSummary.rfqCount}</td>
                    <td className={tdNumericClass} style={{ color: A.label }}>{row.p2pSummary.poCount}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: row.p2pSummary.openPoCount ? A.blue : A.gray2 }}>{row.p2pSummary.openPoCount}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: row.p2pSummary.receivingExceptionCount ? A.orange : A.green }}>{row.p2pSummary.receivingExceptionCount}</td>
                    <td className={`${tdNumericClass} font-semibold`} style={{ color: row.p2pSummary.invoiceVarianceCount ? A.orange : A.green }}>{row.p2pSummary.invoiceVarianceCount}</td>
                    <td className={tdNumericClass} style={{ color: row.p2pSummary.receivedNotInvoicedAmount ? A.orange : A.green }}>{fmt(row.p2pSummary.receivedNotInvoicedAmount)}</td>
                    <td className={tdNowrapClass} style={{ color: A.sub }}>{row.p2pSummary.latestTransactionDate}</td>
                    <td className={tdNowrapClass}><Chip label={row.supplier.riskStatus} color={riskStyle.color} bg={riskStyle.bg} /></td>
                    <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.blue }}>{copy(row.nextAction)}</td>
                    <td className={tdActionClass}>
                      <button onClick={() => onDetail(row)} className="px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>{copy("查看运营档案")}</button>
                    </td>
                  </tr>
                );
              }
              if (mode === "certification") {
                return (
                  <tr key={row.supplier.code} style={{ borderBottom: index < visible.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                    <td className={`${tdNameClass} max-w-[220px] font-semibold`} style={{ color: A.label }}>
                      <span className="block truncate">{row.supplier.name}</span>
                      <div className="fc-caption mt-0.5" style={{ color: A.gray2 }}>{row.supplier.code} · {row.category}</div>
                    </td>
                    <td className={tdNowrapClass}><Chip label={row.supplier.certificationStatus} color={certStyle.color} bg={certStyle.bg} /></td>
                    <td className={tdNowrapClass}><Chip label={row.supplier.status} color={recordStyle.color} bg={recordStyle.bg} /></td>
                    <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: missingDocs === "无" ? A.green : A.orange }}>{copy(missingDocs)}</td>
                    <td className={tdNowrapClass} style={{ color: expiryRisk === "低" ? A.green : A.orange }}>{copy(expiryRisk)}</td>
                    <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.blue }}>{remediation}</td>
                    <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.sub }}>{copy("资质文件 / 税务资料 / 联系信息")}</td>
                    <td className={tdNowrapClass} style={{ color: A.label }}>{row.supplier.contact}</td>
                    <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.blue }}>{row.nextAction}</td>
                    <td className={tdActionClass}>
                      <button onClick={() => onDetail(row)} className="px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>{copy("查看详情")}</button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.supplier.code} style={{ borderBottom: index < visible.length - 1 ? "0.5px solid rgba(0,0,0,0.04)" : "none" }}>
                  <td className={`${tdNameClass} max-w-[220px] font-semibold`} style={{ color: A.label }}>
                    <span className="block truncate">{row.supplier.name}</span>
                    <div className="fc-caption mt-0.5" style={{ color: A.gray2 }}>{row.supplier.code} · {row.flag}</div>
                  </td>
                  <td className={`${tdNumericClass} font-semibold`} style={{ color: row.rating >= 4.5 ? A.green : row.rating >= 4 ? A.blue : A.orange }}>{row.rating.toFixed(1)}</td>
                  <td className={tdNumericClass} style={{ color: A.label }}>{row.onTimeRate}%</td>
                  <td className={tdNumericClass} style={{ color: A.label }}>{row.qualityRate}%</td>
                  <td className={tdNumericClass} style={{ color: A.label }}>{row.responseScore}</td>
                  <td className={tdNowrapClass}><Chip label={row.supplier.riskStatus} color={riskStyle.color} bg={riskStyle.bg} /></td>
                  <td className={`${tdNumericClass} font-semibold`} style={{ color: row.openPoCount ? A.blue : A.gray2 }}>{row.openPoCount}</td>
                  <td className={`${tdNumericClass} font-semibold`} style={{ color: row.invoiceVarianceCount ? A.orange : A.green }}>{row.invoiceVarianceCount}</td>
                  <td className={tdNowrapClass} style={{ color: row.reconciliationException ? A.red : A.green }}>{copy(row.reconciliationException ? "需复核" : "稳定")}</td>
                  <td className={`${tdNameClass} max-w-[180px] truncate`} style={{ color: A.blue }}>{row.nextAction}</td>
                  <td className={tdActionClass}>
                    <button onClick={() => onDetail(row)} className="px-2.5 py-1 rounded-md font-medium" style={{ background: A.gray6, color: A.blue }}>{copy("查看详情")}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
