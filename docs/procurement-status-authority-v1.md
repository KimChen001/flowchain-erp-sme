# FlowChain 采购状态权威 v1

日期：2026-08-04

状态：代码权威已建立；本轮不修改数据库持久值

## 目的

本文件记录采购状态收敛后的唯一代码权威、兼容边界和后续数据迁移要求。

权威实现位于：

```text
server/domain/procurement-status-authority.mjs
```

`procurement-workflow.mjs` 和 `procurement-status-model.mjs` 只保留兼容 Facade，
不再各自维护一份状态数组或状态转换图。

## 状态分域

### 正式业务状态

| Domain | Canonical values | 说明 |
| --- | --- | --- |
| Purchase Request | `draft`, `submitted`, `approved`, `rejected`, `cancelled`, `converted` | 正式 PR 工作流 |
| RFQ | `draft`, `open`, `collecting_quotes`, `closed`, `cancelled` | 内部 RFQ 工作流 |
| Supplier Quotation | `draft`, `incomplete`, `submitted`, `shortlisted`, `not_selected`, `withdrawn` | 正式供应商报价状态 |
| Purchase Order | `draft`, `pending_approval`, `approved`, `rejected`, `issued`, `partially_received`, `fully_received`, `cancelled` | 当前 Schema 将工作流和履约投影保存在同一 `status` 字段 |
| Receiving Workflow | `draft`, `ready_for_receiving`, `received`, `cancelled` | 收货单业务工作流 |
| Receiving Posting | `unposted`, `posted`, `reversed` | 收货过账轴，独立于工作流 |

### Preview / Draft-only 状态

以下状态只属于预览、草稿或未来 Sourcing Event 模型，不能作为当前正式表的工作流权威：

- `purchaseRequestPreview`；
- `sourcingEventDraft`；
- `supplierResponseDraft`；
- `awardRecommendationDraft`；
- `purchaseOrderDraft`。

例如：

- `needs_info` 属于 PR Preview，不是正式 PR 持久状态；
- `award_recommended` 属于 Sourcing Event Draft，不是当前 `Rfq.status`；
- `ready_for_manual_issue` 属于 PO Draft，不是正式 `PurchaseOrder.status`。

## Purchase Order 的两个转换 Owner

当前 `PurchaseOrder.status` 同时承载工作流与收货履约投影，因此状态值共用一个目录，
但转换规则分为两个 Owner：

- `purchaseOrderWorkflow`：草稿、审批、下发；
- `purchaseOrderReceiving`：部分收货、全部收货和安全冲销恢复。

普通采购工作流不能直接把 `issued` 改为 `partially_received`；只有收货事务服务可以执行
履约状态变化。反向恢复也只能由收货冲销事务执行。

## Receiving 的三个字段

`ReceivingDocument` 当前有三个不同字段：

- `status`：历史列表或业务展示字段；
- `workflowStatus`：草稿、待收货、已收货、取消；
- `postingStatus`：未过账、已过账、已冲销。

正式命令判断必须使用 `workflowStatus` 和 `postingStatus`，不能用展示 `status`
替代过账状态。

## 兼容映射

本轮不直接改写数据库值。下列已存在输入在边界被映射到 Canonical Value：

| Domain | Compatibility input | Canonical value |
| --- | --- | --- |
| Purchase Request | `open`, `requested`, `pending_review` | `submitted` |
| Purchase Request | `converted_to_rfq` | `converted` |
| RFQ | `active` | `open` |
| RFQ | `collecting_responses` | `collecting_quotes` |
| Supplier Quotation | `received` | `submitted` |
| Purchase Order | `open`, `ready_for_receiving` | `issued` |
| Purchase Order | `received`, `completed` | `fully_received` |
| Receiving Workflow | `approved` | `ready_for_receiving` |
| Receiving Workflow | `partially_received` | `received` |

兼容值不会被加入 Canonical Value 数组。调用方可以使用
`allowCompatibility: false` 进行严格校验。

## 收货可执行边界

允许正式收货过账的 Canonical Receiving Workflow：

- `ready_for_receiving`；
- `received`。

允许接收货物的 Canonical PO 状态：

- `approved`；
- `issued`；
- `partially_received`。

历史值通过兼容映射判断，但新代码不得继续产生这些历史值。

## 本轮代码变更

- 新增单一状态目录、转换目录和兼容映射。
- `procurement-workflow.mjs` 改为从单一权威导出 PR、RFQ、PO 转换。
- `procurement-status-model.mjs` 改为 Preview-only 兼容 Facade。
- `procurement-workflow-service.mjs` 移除本地 RFQ 转换表，并使用状态常量。
- Receiving Policy 通过权威 Normalizer 判断可过账状态。
- 增加正式状态、Preview 分离、兼容映射、转换 Owner 和 Receiving 边界测试。

## 明确不在本轮处理

- 不执行数据库状态迁移；
- 不增加 Prisma Enum 或 Check Constraint；
- 不启用新的 RFQ、PO、Receiving Capability；
- 不增加 Supplier Portal；
- 不改变现有 API Response 中的公开状态值；
- 不把 Preview Draft 自动升级为正式业务对象。

## 后续迁移要求

正式修改持久值以前必须：

1. 查询每个租户中 PR、RFQ、Quotation、PO、Receiving 的 distinct status；
2. 输出未知值和兼容值计数；
3. 明确每个兼容值的目标状态以及业务含义是否丢失；
4. 提供 Upgrade Preflight；
5. 使用 Additive Migration 和可恢复的数据转换；
6. 同时更新 Local Scenario、导入模板、筛选条件、AI 规则和 Browser Test；
7. 新代码停止产生兼容值以后，才允许增加数据库 Constraint。

## 下一实现切片

状态权威稳定后，下一切片为 Canonical RFQ Detail：

```text
Tenant-scoped RFQ direct read
  -> RFQ lines
  -> Supplier quotations and revisions
  -> Evidence / permission / empty / not-found states
  -> Canonical RFQ detail page
```
