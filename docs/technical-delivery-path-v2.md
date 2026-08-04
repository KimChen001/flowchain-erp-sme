# FlowChain 技术交付路径 v2

状态：建议执行基线

日期：2026-08-04

范围：Phase 5.4B 之后的核心收口、交易闭环、Pilot 上线准备和 AI 动作接入

## 1. 文档目的

本文定义 FlowChain 下一阶段的技术实施顺序。它描述的是后续交付路径，
不代表文中所有能力当前已经可用。

目标是把 FlowChain 从一个覆盖面较广、测试较完整的 PostgreSQL 产品，
收口为一个可以真实试点的中小企业采购履约、收货、库存和异常协同平台。

总体顺序为：

```text
稳定主线
  -> 统一产品、状态和数据权威
  -> 打通一条正式交易链
  -> 开放受治理的主数据导入提交
  -> 完成生产 Pilot 基础
  -> 将 AI 草稿接入同一人工确认命令链
  -> 只根据试点证据增加扩展模块
```

## 2. 当前技术基线

### 2.1 已经具备的能力

- PostgreSQL 是唯一生产权威数据源。
- 已有租户、角色、权限和仓库范围基础。
- Prisma 已覆盖采购申请、RFQ、供应商报价、采购订单、收货、库存、
  审计、证据、Intake、销售出库、退货、财务协同、移动端和对账等对象。
- 现有收货过账服务已经具备事务归属、幂等、并发冲突检查、不可变库存流水、
  冲销、审计和变更流记录。
- 现有采购订单命令服务已经具备服务端身份解析、权限校验、幂等键、版本检查、
  行锁、事务内审计和变更流写入。
- Universal Intake 5.4B 已支持 Supplier、Item、Customer 的受限 CSV、XLSX、
  Paste Table、Paste JSON 解析，以及 Schema Snapshot、字段映射、规范化证据、
  校验和人工复核。
- 前端已有类型化路由清单，能够区分 Core、Extension、Internal、Frozen、Legacy。
- AI 读取以当前租户证据为基础，AI 调度层不拥有正式业务写权限。

### 2.2 已确认的主要断点

- 当前生成的前端权威矩阵包含 162 个 Route ID，产品面仍然偏大。
- 读写成熟度不一致：PR、PO 已有正式命令路径；RFQ 详情尚未接通；
  Receiving 写入仍受能力开关控制；很多库存和销售页面只有权威读取。
- Universal Intake 尚不能把复核后的 Supplier、Item、Customer 正式提交到业务表。
- 采购状态存在两套权威：`procurement-status-model.mjs` 和
  `procurement-workflow.mjs`。两者对 PR 和询价流程使用的内部状态词不一致。
- 部分前后端文件仍承担过多职责，历史页面和源码耦合测试尚未完全清理。
- 生产部署基础和 AI/服务器运行时收敛位于不同分支，并且都修改服务器组合层。
- 二进制 Artifact 已有存储端口，但默认实现仍然 fail closed，尚未接入持久对象存储。
- 一些历史文档仍把 JSON 或 Preview-only 阶段描述为当前架构。

### 2.3 当前验证基线

2026-08-04 在当前运行时收敛分支验证结果：

- `npm test`：1179 项，1165 通过，14 跳过，0 失败；
- `npm run typecheck`：通过；
- `npm run build`：通过；
- 生产构建仍有大 Chunk 警告，后续需要做页面级懒加载和拆包。

## 3. 产品边界和技术决策

### 3.1 默认核心产品

默认 Core 包含：

- 今日行动和运营优先级；
- Supplier、Item、Customer、Warehouse 和受控基础资料；
- Purchase Request；
- 内部 RFQ、供应商报价和比价；
- Purchase Order；
- Receiving、QC 和库存入账；
- 库存流水、余额、可用量和异常；
- Evidence Graph、Audit、Universal Intake 和经营报表；
- AI 证据解释和可复核动作草稿。

以下保持为可选 Extension：

- 销售订单和出库执行；
- 供应商发票与三单匹配协同；
- 退货与隔离区；
- 移动仓库作业；
- 外部供应商协同；
- 外部 ERP、消息和电商连接器。

以下在 Pilot 前保持冻结或只做集成边界：

- 银行、付款执行、总账和法定会计；
- 税务申报；
- 完整 CRM；
- HR 和薪酬；
- 通用低代码工作流和任意自定义实体；
- 缺少权威 BOM、提前期、需求和计划参数时的 MRP/S&OP。

### 3.2 架构风格

Pilot 阶段继续采用模块化单体，不拆微服务。

```text
React Application Shell
  -> 模块路由清单和类型化 API Client
  -> 轻量 HTTP Route Adapter
  -> Application Query / Command Service
  -> Domain Policy / Status Transition / Calculation
  -> Repository 或事务内 Prisma Adapter
  -> PostgreSQL

横向平台能力
  -> Signed Identity / Tenant Context
  -> RBAC / Warehouse Scope
  -> Idempotency / Optimistic Concurrency
  -> Audit / DomainChangeFeed
  -> Artifact Storage
  -> Observability / Background Delivery
```

核心闭环完成以前不引入：

- 微服务拆分；
- 通用 Event Sourcing；
- 自动扫描式路由注册；
- 新的全局前端状态框架；
- 为了“架构统一”而进行的全仓库一次性搬迁。

### 3.3 后端目标结构

新建或被修改的核心模块逐步收敛到：

```text
server/modules/<module>/
  application/
    commands/
    queries/
  domain/
    policies/
    status/
  infrastructure/
    prisma/
  http/
    routes/
```

现有对外 Export 保持为兼容 Facade，每次只迁移一个 Operation，避免大爆炸重构。

### 3.4 前端目标结构

```text
src/modules/<module>/
  routes.ts
  api.ts
  pages/
  components/
  state/
```

`FlowChainApp` 最终只负责：

- 登录和会话恢复；
- 应用布局；
- 全局导航；
- 全局搜索；
- AI Host；
- 全局错误边界。

业务页面选择和业务状态归各模块路由清单所有。

## 4. 统一交易内核

### 4.1 命令请求约定

所有核心正式写入使用统一 Command 约定。

客户端可以提交：

```json
{
  "idempotencyKey": "client-generated-unique-key",
  "expectedVersion": 3,
  "reason": "驳回、取消、冲销和覆盖策略时必填",
  "payload": {}
}
```

以下字段只能由服务器生成或解析：

- tenant / workspace；
- actor / effective roles；
- warehouse scope；
- requestId / traceId；
- commandType；
- permission decision；
- server timestamp。

任何正式命令都不能信任请求 Body 或未签名 Header 中的 tenantId、actorId、role。

### 4.2 命令执行顺序

```text
解析签名身份
  -> 解析租户和仓库范围
  -> 校验精确命令权限
  -> 校验幂等键和 Request Hash
  -> 锁定聚合或校验 expectedVersion
  -> 校验唯一状态转换权威
  -> 校验跨对象业务规则
  -> 在一个事务内提交业务对象、库存流水、审计和变更流
  -> 返回最新版本和安全结果投影
```

### 4.3 必须保持的系统不变量

1. 同一命令重试返回原结果，不能重复创建单据、流水或审计。
2. 同一幂等键对应不同 Payload 时返回稳定冲突。
3. 版本冲突返回当前权威版本和重新加载动作。
4. 驳回、退回修改、取消、冲销、策略覆盖必须填写原因。
5. 已过账库存流水不可修改；修正只能追加冲销或调整流水。
6. 业务修改、AuditLog 和 DomainChangeFeed 必须在同一个事务提交。
7. 事务失败后不能遗留半张单、半条流水、余额、审计或变更记录。
8. 所有自然键唯一性必须包含 tenantId。
9. 数量和金额使用固定精度 Decimal，JavaScript 浮点不能作为权威计算。
10. AI 不直接调用 Prisma 或正式 Command Service；AI 只能准备待人工确认的草稿。

### 4.4 DomainChangeFeed 和 Integration Outbox

现有 `DomainChangeFeed` 继续承担内部变更和同步证据，不自动升级为外部消息队列。

真实邮件、消息、ERP、Supplier Portal 发送启用时，单独增加 Integration Outbox：

- destination adapter；
- eventType / schemaVersion；
- safe payload 或 payload reference；
- attemptCount / nextAttemptAt；
- delivered / failed / dead-letter 状态；
- tenantId、sourceCommandId 和业务对象引用。

Outbox 记录与业务动作同事务创建，外部发送由后台 Worker 异步完成。

## 5. 采购与收货状态权威

### 5.1 状态模型收敛

增加任何新采购能力以前，先统一采购状态目录。

具体步骤：

1. 盘点数据库值、API 值、UI Label、筛选条件、AI 规则和测试中使用的状态。
2. 覆盖 PR、Sourcing/RFQ、Supplier Response、PO、Receiving。
3. 定义唯一内部 Canonical Value 和中文展示 Label。
4. 在 API / Repository 边界增加兼容映射。
5. 所有 Query 和 Command Service 改用唯一状态目录。
6. 如果需要修改持久值，先生成 Preflight 报告，再做可恢复的数据迁移。
7. 数据库、API、Browser、Upgrade 测试通过后才删除第二套状态权威。

不能通过只改前端文案来改变后端状态语义。

### 5.2 第一条正式业务链

```text
Master Data
  -> Purchase Request
  -> 内部审批
  -> 采购路径决策
  -> RFQ / Supplier Response / Quote Comparison
  -> 人工复核 Award Recommendation
  -> Purchase Order Draft
  -> PO 审批和人工下发
  -> Receiving / QC
  -> Inventory Posting
  -> Invoice / Three-way Match 可见性
```

Direct PO 只有在以下条件同时成立时才允许：

- PR 已批准；
- Supplier 和价格有效；
- 金额符合租户采购策略；
- 当前用户具有对应权限；
- 没有必须走 RFQ 的新供应商、新物料或高风险条件。

### 5.3 第一版 RFQ 范围

第一版先做内部询价权威，不同时建设 Supplier Portal：

- RFQ 权威详情读取；
- RFQ Lines、拟询价供应商、截止日期和条款；
- 人工录入 Supplier Response；
- 报价 Revision 不可覆盖，只能追加新版本；
- 使用明确标准进行比价；
- Award Recommendation 需要人工复核；
- 明确转换为 PO Draft；
- 所有状态转换都写 Audit 和 Evidence Link。

本阶段不加入：

- 外部供应商身份；
- 邮件邀请；
- Supplier Login；
- 在线报价提交；
- 外部会话复用内部 WorkspaceInvitation。

### 5.4 收货范围

保留现有 Posting / Reversal Kernel 作为权威，后续工作以页面和能力收敛为主：

- 一个权威 Receiving 列表和详情；
- Draft 创建和编辑具有明确 Capability 和 Permission；
- 行级 acceptedQty、rejectedQty、warehouse、location；
- 正式提交前显示库存影响预览；
- 通过幂等键和版本检查只过账一次；
- 冲销只能追加反向流水且必须填写原因；
- 提供 Balance 与 Movement 的 Reconciliation Diagnostic；
- PO Workflow Status 与 Fulfillment Status 分开表达。

## 6. Universal Intake 5.4C 正式提交

### 6.1 实现顺序

1. Supplier Commit Adapter；
2. Item Commit Adapter；
3. Customer Commit Adapter；
4. 主数据提交稳定后，再评估交易单据导入。

### 6.2 Commit 请求必须引用的权威证据

- IntakeBatch ID；
- SchemaSnapshot ID 和版本；
- MappingProfile ID 和版本；
- ReviewSession 和 Decision；
- Selected / Excluded Record Set；
- Normalized Snapshot Hash；
- Idempotency Key；
- Create-only 或 Governed Upsert 策略。

Commit API 不能接收调用方重新拼装的标准业务对象。服务器必须重新读取
Parser-owned、已复核的规范化记录和证据。

### 6.3 第一版提交策略

- 只允许 Create 和 Allowlisted Safe Update。
- 不允许 Delete、Merge 或自动创建引用对象。
- Existing-different 记录必须展示字段级 Diff。
- Excluded Row 必须显式保存到复核证据。
- 在 Commit 事务内再次校验租户自然键和引用对象。
- 成功重放返回第一次 Commit Result。
- 失败只记录安全失败证据，不能修改业务表。
- 第一版在 5000 行上限内采用一个 Reviewed Batch 原子提交。

如果未来因性能需要分块提交，Chunk、进度、失败恢复和补偿必须成为显式产品行为，
不能在后台静默部分成功。

## 7. 前端产品面收敛

### 7.1 权威页面结构

每个核心业务对象统一使用：

```text
List
  -> Detail Header / Status
  -> Lines / Business Facts
  -> Related Evidence
  -> 当前状态允许的 Actions
  -> Impact Preview
  -> Confirmation / Reason
  -> Updated Timeline / Audit Link
```

Action 必须同时根据权威状态、Permission、Capability、Version 计算。
隐藏按钮不是安全边界，后端授权仍然是最终权威。

### 7.2 路由和历史页面治理

- 每个核心业务对象只保留一个 Canonical Route。
- 只有存在一对一替代页面时才保留 Redirect。
- 无明确替代的 Legacy Route 显示真实的已退休状态。
- 将读取历史组件文件名和源码字符串的测试迁移为 API / Browser 行为测试。
- 删除旧页面前必须完成零运行时引用和替代行为验证。
- Route Metadata 按模块拆分，生成的 Authority Matrix 继续由 CI 校验。
- 默认导航只展示 Core 和明确开放的 Conditional Core。

### 7.3 页面状态要求

每个权威页面必须区分：

- loading；
- authoritative empty；
- permission denied；
- capability disabled；
- stale version / conflict；
- validation failure；
- service unavailable；
- signed scope 内的 record not found。

任何异常状态都不能回退到非权威业务数据。

## 8. 生产 Pilot 基础

### 8.1 分支整合顺序

1. 当前 AI / Server Runtime Consolidation 通过特征测试和无业务写测试后合并。
2. 将 Production Deployment Foundation 重新基于新的服务器组合层整理。
3. Readiness 和 Graceful Shutdown 接入已经拆出的 Lifecycle Module，
   不恢复巨型 Bootstrap。
4. 合并前重新运行容器、启动、迁移、会话、静态资源、API 和 Browser 验收。

### 8.2 Pilot 必备能力

- Immutable Production Image；
- Listen 前完成环境校验；
- Liveness 和 Readiness 分离；
- 停止接收新任务后再关闭 PostgreSQL 的 Graceful Shutdown；
- 带 Preflight 的 Additive Migration；
- 已演练的 Backup / Restore；
- 持久 Artifact 和 Attachment Storage；
- 生产身份方案或 Managed Identity 决策；
- Session Revocation 和 Secret Rotation；
- Request ID 和不泄露密钥的结构化日志；
- Error Tracking、Latency、DB Pool 和 Slow Query 监控；
- Staging / Production 数据和配置隔离；
- 发布后 Smoke Test 和应用回滚文档；
- 生产环境禁止自动加载预置业务场景数据。

### 8.3 Pilot 初始服务目标

以下目标先在 Staging 测量，再决定是否形成正式 SLO：

- 安全测试中跨租户和越权仓库读取为零；
- 幂等和重试测试中重复过账为零；
- 故障注入测试中部分提交为零；
- Core List / Detail API 具备分页和可观测性；
- Deterministic AI 不依赖外部 Provider 也可工作；
- Process Restart 和 Restore 后权威业务事实保持一致。

## 9. AI 动作接入

### 9.1 AI 允许做的事情

- 读取当前签名租户上下文；
- 解释证据和数据限制；
- 对运营异常排序；
- 比较已经录入并复核的供应商响应；
- 准备采购、跟进和异常草稿；
- 导航到权威业务对象和复核页面。

### 9.2 AI 禁止做的事情

- 自动批准或驳回单据；
- 自动发布 RFQ；
- 自动定标；
- 自动下发 PO；
- 自动过账或冲销收货；
- 自动修改库存；
- 自动批准发票或执行结算；
- 自动创建外部身份；
- 未经人工确认外发供应商消息。

### 9.3 Draft 到 Command 的唯一桥梁

```text
AI Response
  -> 持久 ActionDraft、Evidence、Validation
  -> 人工打开 Canonical Review Page
  -> 服务器重新构建并校验 Proposed Command
  -> 用户基于当前 Entity Version 确认
  -> 正常 Command Route 执行
  -> Audit 关联 Draft、Confirmation、Command 和 Result
```

AI Response 本身永远不能作为可信业务命令直接执行。

### 9.4 第一批 AI 场景

- PO 延迟或阻塞；
- 收货差异或缺少 QC 证据；
- 库存短缺以及相关需求和供应证据；
- 供应商报价或跟进缺口；
- Invoice / PO / GRN 三单匹配差异解释。

评测指标包括：

- Evidence Correctness；
- False Positive Rate；
- Draft Adoption Rate；
- 人工修改比例；
- 被拒绝建议比例；
- Time to Resolution。

Prompt 数量和聊天次数不作为产品成功指标。

## 10. 分阶段 PR 路径

### Wave A：稳定基线和统一权威

#### A1. Runtime 和 AI Consolidation

- 合并当前服务器职责拆分和 AI Handler Registry。
- 保持 Route Order、Signed Session、Sanitized Error 和 AI No-Mutation Contract。

退出门禁：完整 Source Test、Typecheck、Build 和 AI / Server Characterization 通过。

#### A2. Production Lifecycle Integration

- 将 Container、Runtime Config、Readiness、Graceful Shutdown 和 Staging 部署
  重新接到 A1 之后的架构。

退出门禁：Production Image 可以迁移、启动、Ready、服务 API / Static Asset 并正常停机。

#### A3. 单一能力和文档权威

- 更新当前 Architecture 和 Roadmap Index。
- 将 JSON 时代和已被替代的计划标为 Historical。
- 尽量从可执行 Metadata 生成 Read / Write / Capability Matrix。

退出门禁：当前文档不再声明未实现的运行时能力。

#### A4. Procurement Status Authority

- 对两套采购状态模型做 Characterization。
- 冻结唯一 Status Catalog 和 Compatibility Mapping。
- 补齐 Database / API / Browser Transition Test。

退出门禁：PR、RFQ、Response、PO、Receiving 每个状态和转换只有一个 Owner。

### Wave B：核心交易闭环

#### B1. Command Kernel Convention

- 抽取通用身份、幂等、版本、审计和错误约定。
- 不替换现有正确的 Aggregate Transaction Ownership。

退出门禁：PO 和 Receiving 行为保持不变，新命令使用同一 Contract。

#### B2. Canonical RFQ Detail

- 增加 Tenant-scoped RFQ Direct Read。
- 展示 Lines、Responses、Quote Revisions、Evidence 和权限状态。

退出门禁：RFQ List ID 可以进入真实详情；验收通过后才移除 `NOT_IMPLEMENTED`。

#### B3. RFQ Response、Comparison 和 Award Command

- 增加内部 Response Capture、Revision、Close、Comparison、Recommendation、
  Reviewed Award 和 PO Draft Conversion。

退出门禁：两家供应商报价可以比较，一次授权人工决策只能生成一个 PO Draft。

#### B4. Canonical Receiving Enablement

- Canonical UI 接入现有 Posting / Reversal Kernel。
- 增加 Impact Preview、Reason、Version Conflict Recovery 和 Evidence Navigation。

退出门禁：Partial / Full Receipt、Retry、Reversal、Reconciliation 在 PostgreSQL 上通过。

#### B5. Inventory Invariant Closure

- 将大型 Inventory Command Service 按 Operation 渐进拆分。
- 建立 Balance 对 Immutable Movement 的 Reconciliation Diagnostic。

退出门禁：Transfer、Count、Adjustment、Receiving、Outbound、Reversal 在并发和故障下注不漂移。

### Wave C：受治理的租户入驻

#### C1. Supplier Commit Adapter

退出门禁：Reviewed Supplier Batch 能在同租户内 Create / Safe Update，具备 Diff、幂等、审计和原子性。

#### C2. Item Commit Adapter

退出门禁：SKU、Unit、Supplier、Warehouse 和引用关系在 Commit 事务内再次权威校验。

#### C3. Customer Commit Adapter

退出门禁：建立权威 Customer Existing-record Comparison 和 Tenant Natural Key Governance。

### Wave D：Pilot Operating Readiness

- Durable Artifact Storage；
- Production Identity / Session；
- Deployment Integration；
- Backup / Restore Drill；
- Observability 和 Runbook；
- 独立的 Dependency Security Upgrade；
- Core Frontend Code Splitting；
- Empty Tenant 和真实业务量 Pilot 环境。

退出门禁：新工作区可被 Provision、Onboard、Operate、Restart、Upgrade、Backup、Restore，
全程不需要人工修数据库。

### Wave E：AI Exception Workflow

- Evidence-backed Draft 接入 Canonical Review Page；
- Confirmed Draft 只通过正常 Command Kernel 执行；
- 增加评测和运营指标；
- 外部 Provider 可选，Degraded Behavior 保持 Deterministic。

退出门禁：每个 AI 来源业务写入都有人工确认人、当前版本检查、Command Execution、
Audit Link 和权威 Result。

### Wave F：根据试点选择扩展

只能根据 Pilot 证据选择：

- Supplier Collaboration / External RFX Portal；
- Sales / Outbound；
- Mobile Receiving / Counting；
- Operational Finance Matching；
- Kingdee、Odoo、SAP、Email、Messaging、Commerce Adapter；
- 具备权威输入后的 Forecast / MRP。

每个 Extension 必须单独定义 Capability、Permission、Tenant Scope、Data Authority、
Migration、Failure Semantics、Audit 和 E2E Test。

## 11. 黄金链路验收脚本

核心版本只有在以下流程不使用预置业务数据、不手工改数据库时才算完成：

1. Provision 新 Tenant、Admin、Buyer、Approver、Receiver 和 Warehouse Scope。
2. 通过 Universal Intake 导入并复核 Supplier、Item。
3. 创建并提交 Purchase Request。
4. 由另一名授权用户批准 PR。
5. 选择 RFQ 路径并创建 RFQ。
6. 录入两家 Supplier Response 和一次 Quote Revision。
7. 关闭响应并查看 Comparison。
8. 批准 Award Recommendation，生成唯一 PO Draft。
9. 审批并人工下发 PO。
10. 创建 Partial Receiving，查看 Inventory Impact Preview。
11. Post Receiving，验证 PO Quantity、Movement、Balance、Evidence、Audit、ChangeFeed。
12. Post 剩余数量，验证 Fulfillment Completion。
13. 查看 Invoice 和 Three-way Match，不执行付款。
14. 对一笔允许冲销的收货填写原因并 Reverse。
15. 验证 Reversal Movement、PO Fulfillment、Balance Reconciliation 和 Audit。
16. 重启服务并再次验证全部业务事实。

必须覆盖的负向场景：

- Cross-tenant Object ID；
- 缺少 Warehouse Scope；
- 相同 / 不同 Payload 的重复 Idempotency Key；
- Stale Version；
- Unsafe State Transition；
- 非法 Quantity 和 Decimal Boundary；
- Document、Ledger、Audit、ChangeFeed 阶段的 Transaction Fault Injection；
- Disabled Capability；
- Expired / Revoked Session；
- Empty PostgreSQL Database。

## 12. 每个 PR 的验证门禁

### 12.1 通用门禁

```bash
npm test
npm run typecheck
npm run build
```

### 12.2 按风险增加的门禁

- Procurement Command：PostgreSQL Atomicity、Authorization、Version、Browser Procurement。
- Receiving：DB、API、Decimal Parity、Browser、Reversal、Fault Injection。
- Inventory：DB / API / Browser Operation 和 Reconciliation。
- Intake：Migration、Parser Safety、PostgreSQL Durability、API Authorization、Browser Wizard、Commit Replay。
- Production Runtime：Container Build、Migration Deploy、Readiness、Graceful Shutdown、Static Asset、Smoke Test。
- AI：Handler Order、Advertised Tool Registry、Evidence Correctness、No Business Mutation、Provider Disabled、Contextual Review。

### 12.3 数据库迁移门禁

每个 Schema Change 必须具备：

- 默认 Additive Migration；
- 不兼容数据的 Preflight；
- 从最新发布版本升级测试；
- Fresh Database 测试；
- Rollback 或 Forward Recovery 方案；
- 禁止生产环境夹具或非权威数据回退；
- 不可逆转换前明确 Backup Requirement。

## 13. 可量化完成标准

达到以下条件才视为 Core Closure：

- 每个默认 Core Route 都有明确 Read / Write Maturity。
- 黄金链路中不存在意外 501、非权威数据回退或人工改库。
- 每个 Core Mutation 只有一个 Command Owner。
- PR、RFQ、PO、Receiving 只有一个状态权威。
- Retry 不能重复产生业务影响。
- Receiving / Reversal 的 Ledger 和 Balance 始终可对账。
- Universal Intake 可通过受治理 Adapter 提交 Supplier、Item、Customer。
- Hidden Extension 不能通过 Navigation、Search 或缓存 Flag 暴露。
- AI 在人工确认前始终保持 Query / Draft Only。
- Staging Deployment、Restart、Backup、Restore、Migration Exercise 全部通过。
- Source Test、Typecheck、Build、核心 PostgreSQL Suite 和 Browser Acceptance 全绿。

## 14. 停止继续扩展的条件

出现以下任一情况，暂停当前 Wave，先修复边界：

- Production Read 返回 Test Fixture 或 Static Business Fact；
- Core Route 绕过 Transaction-owned Command 直接写 Prisma；
- Tenant 或 Actor 来自客户端可控字段；
- Audit / ChangeFeed 与业务修改不能原子提交；
- Status Alias 造成含糊状态转换；
- Retry 能重复生成 Document、Movement、Award 或 Posting；
- AI 未经人工确认可以正式写业务；
- Migration 需要在无 Backup / Preflight 情况下破坏性修复；
- Disabled Extension 改变 Core 默认行为。

## 15. 推荐的第一个实现切片

主线整合完成后，第一个实现切片为：

```text
Procurement Status Authority
  -> Authoritative RFQ Detail
  -> Internal Supplier Response / Quote Revision
  -> Comparison / Reviewed Award
  -> Exactly-once PO Draft Conversion
```

这一切片补齐当前 PR 和 PO 之间最明显的断点，同时可以验证 Command Kernel，
但不需要同时引入外部供应商身份、消息发送、库存修改或财务执行。

该切片通过后，再将 Canonical Receiving UI 接入已经较成熟的 Posting / Reversal Kernel，
随后实现 Universal Intake 5.4C 的 Supplier 和 Item Commit Adapter。
