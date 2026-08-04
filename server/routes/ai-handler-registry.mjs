function preReadHandler({ id, resolve, when, action, summary, persist, timingBranch = id }) {
  return {
    id,
    phase: "pre_read_context",
    resolve,
    when,
    fastPath: "pre_read_context",
    timingBranch,
    audit: result => ({
      action,
      summary: summary(result),
      entity: result.intent.name,
      ...(persist === undefined ? {} : { persist }),
    }),
  };
}

function readContextHandler({ id, resolve, when, action, summary, persist, timingBranch = id }) {
  return {
    id,
    phase: "read_context",
    resolve,
    when,
    timingBranch,
    audit: result => ({
      action,
      summary: summary(result),
      entity: result.intent.name,
      ...(persist === undefined ? {} : { persist }),
    }),
  };
}

export const AI_HANDLER_IDS = Object.freeze({
  responseContractV2: "response_contract_v2",
  sessionGrounding: "session_grounding",
  financeFastPath: "finance_collaboration_fast_path",
  masterDataFastPath: "master_data_quality_fast_path",
  inventoryAllocationFastPath: "inventory_allocation_fast_path",
  salesDemandFastPath: "sales_demand_fast_path",
  evidenceGraphFastPath: "evidence_graph_fast_path",
  dataLimitationFastPath: "data_limitation_fast_path",
  inventoryStatusBeforeProcurement: "inventory_status_before_procurement",
  procurementFastPath: "procurement_operational_fast_path",
  supplierFollowupFastPath: "supplier_followup_fast_path",
  receivingGapFastPath: "receiving_gap_fast_path",
  supplierFastPath: "supplier_operational_fast_path",
  rfqFastPath: "rfq_operational_fast_path",
  cockpitPreRead: "cockpit_fast_path_pre_read_context",
  statusFastPath: "status_fast_path_pre_read_context",
  draftFastPath: "draft_preparation_fast_path",
  compoundQuery: "compound_query",
  cockpitQuery: "cockpit_fast_path",
  supplierQuery: "supplier_operational",
  evidenceReuse: "evidence_reuse",
  statusQuery: "status_query",
  procurementQuery: "procurement_operational",
  rfqQuery: "rfq_operational",
  deferredProcurementException: "deferred_procurement_exception",
  financeQuery: "finance_collaboration",
  draftPreparation: "draft_preparation",
  localWorkbench: "local_workbench",
  marketData: "market_data",
  providerFallback: "provider_fallback",
  configuredAi: "configured_ai",
});

export function createAiHandlerRegistry(d) {
  return Object.freeze([
    {
      id: AI_HANDLER_IDS.responseContractV2,
      phase: "pre_read_context",
      resolve: state => state.compoundCandidate
        ? null
        : d.buildAiResponseContractV2(state.db, state.body, state.routeOptions),
      fastPath: "response_contract_v2",
      includeUsedWeb: false,
      includeExternalMs: false,
      modelTiming: "elapsed",
      audit: result => ({
        action: "ai_response_contract_v2",
        summary: `AI answered ${result.intent.name} with response contract v2`,
        entity: result.intent.name,
        persist: false,
      }),
    },
    {
      id: AI_HANDLER_IDS.sessionGrounding,
      phase: "pre_read_context",
      resolve: state => d.buildAiSessionGroundedResponse(state.db, state.body, { cache: {} }),
      fastPath: "session_grounding",
      modelTiming: "elapsed",
      audit: result => ({
        action: "ai_session_grounding_query",
        summary: `AI answered ${result.intent.name} via ${result.provider}`,
        entity: result.intent.name,
      }),
    },
    preReadHandler({
      id: AI_HANDLER_IDS.financeFastPath,
      resolve: state => d.buildAiFinanceCollaborationResponse(state.db, state.body),
      action: "ai_finance_collaboration_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.masterDataFastPath,
      resolve: state => d.buildAiMasterDataQualityResponse(state.db, state.body),
      action: "ai_master_data_quality_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.inventoryAllocationFastPath,
      resolve: state => d.buildAiInventoryAllocationResponse(state.db, state.body),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_inventory_allocation_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.salesDemandFastPath,
      resolve: state => d.buildAiSalesDemandResponse(state.db, state.body),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_sales_demand_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.evidenceGraphFastPath,
      resolve: state => d.buildAiEvidenceGraphResponse(state.db, state.body),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_evidence_graph_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.dataLimitationFastPath,
      resolve: state => d.buildAiDataLimitationResponse(state.db, state.body, { cache: {} }),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_data_limitation_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.inventoryStatusBeforeProcurement,
      resolve: state => {
        state.statusBeforeProcurement = d.buildAiChatStatusResponse(state.db, state.body, state.routeOptions);
        return state.statusBeforeProcurement;
      },
      when: (result, state) =>
        !state.compoundCandidate &&
        !state.repositoryBackedReadContext &&
        state.dataMode === "user" &&
        result?.intent?.name === "inventory_status_query" &&
        d.shouldRunInventoryBeforeProcurement(state.body, result),
      action: "ai_status_fast_path",
      summary: result => `AI answered ${result.intent.name} before procurement routing`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.procurementFastPath,
      resolve: state => d.buildAiProcurementOperationalResponse(state.db, state.body, state.routeOptions),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_procurement_operational_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.supplierFollowupFastPath,
      resolve: state => d.buildAiEvidenceReuseResponse(state.db, state.body, { cache: {} }),
      when: (result, state) =>
        !state.repositoryBackedReadContext &&
        !state.compoundCandidate &&
        result?.intent?.name === "supplier_followup_query" &&
        !["srm", "supplier"].includes(state.fastPathModuleId),
      action: "ai_supplier_followup_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.receivingGapFastPath,
      resolve: state => d.buildAiReceivingGapResponse(state.db, state.body),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_receiving_gap_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.supplierFastPath,
      resolve: state => d.buildAiSupplierOperationalResponse(state.db, state.body, state.routeOptions),
      when: (_result, state) =>
        !state.compoundCandidate &&
        (!state.repositoryBackedReadContext || ["srm", "supplier"].includes(state.fastPathModuleId)),
      action: "ai_supplier_operational_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.rfqFastPath,
      resolve: state => d.buildAiRfqOperationalResponse(state.db, state.body, { ensureRfqs: state.routeOptions.ensureRfqs }),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_rfq_operational_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.cockpitPreRead,
      resolve: state => (!state.compoundCandidate && !state.repositoryBackedReadContext)
        ? d.buildAiCockpitFastPathResponse(state.db, state.body, { cache: {} })
        : null,
      action: "ai_cockpit_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
      persist: false,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.statusFastPath,
      resolve: state => state.statusBeforeProcurement || d.buildAiChatStatusResponse(state.db, state.body, state.routeOptions),
      when: (result, state) =>
        !state.compoundCandidate &&
        ((!state.repositoryBackedReadContext && d.shouldRunInventoryStatusBeforeReadContext(state.body, result)) ||
          result?.intent?.name === "planning_status_query"),
      action: "ai_status_fast_path",
      summary: result => `AI answered ${result.intent.name} before read-context build`,
    }),
    preReadHandler({
      id: AI_HANDLER_IDS.draftFastPath,
      resolve: state => d.buildAiDraftPreparationResponse(state.db, state.body, {
        authorization: state.ctx.req.headers.authorization || "",
      }),
      when: (_result, state) => !state.compoundCandidate,
      action: "ai_draft_prepared",
      summary: result => `AI prepared ${result.intent.name} before read-context build with ${result.cards.find(card => card.type === "missing_fields")?.fields?.length || 0} missing fields`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.compoundQuery,
      resolve: state => d.buildAiCompoundQueryResponse(state.db, state.body, {
        cache: state.readModelCache,
        ...state.routeOptions,
      }),
      action: "ai_compound_query",
      summary: result => `AI answered compound query with ${result.subIntents?.length || 0} sub-intents`,
      persist: false,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.cockpitQuery,
      resolve: state => d.buildAiCockpitFastPathResponse(state.db, state.body, { cache: state.readModelCache }),
      action: "ai_cockpit_fast_path",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
      persist: false,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.supplierQuery,
      resolve: state => d.buildAiSupplierOperationalResponse(state.db, state.body, state.routeOptions),
      when: (_result, state) => !state.repositoryBackedReadContext || ["srm", "supplier"].includes(state.fastPathModuleId),
      action: "ai_supplier_operational_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.evidenceReuse,
      resolve: state => d.buildAiEvidenceReuseResponse(state.db, state.body, { cache: state.readModelCache }),
      action: "ai_evidence_reuse_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.statusQuery,
      resolve: state => {
        const result = d.buildAiChatStatusResponse(state.db, state.body, state.routeOptions);
        state.deferredProcurementException = result?.intent?.name === "procurement_exception_query" ? result : null;
        return state.deferredProcurementException ? null : result;
      },
      action: "ai_chat_status_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.procurementQuery,
      resolve: state => d.buildAiProcurementOperationalResponse(state.db, state.body, state.routeOptions),
      action: "ai_procurement_operational_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.rfqQuery,
      resolve: state => d.buildAiRfqOperationalResponse(state.db, state.body, { ensureRfqs: state.routeOptions.ensureRfqs }),
      action: "ai_rfq_operational_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.deferredProcurementException,
      resolve: state => state.deferredProcurementException,
      action: "ai_chat_status_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.financeQuery,
      resolve: state => d.buildAiFinanceCollaborationResponse(state.db, state.body),
      action: "ai_finance_collaboration_query",
      summary: result => `AI answered ${result.intent.name} via ${result.provider}`,
    }),
    readContextHandler({
      id: AI_HANDLER_IDS.draftPreparation,
      resolve: state => d.buildAiDraftPreparationResponse(state.db, state.body, {
        authorization: state.ctx.req.headers.authorization || "",
      }),
      action: "ai_draft_prepared",
      summary: result => `AI prepared ${result.intent.name} with ${result.cards.find(card => card.type === "missing_fields")?.fields?.length || 0} missing fields`,
    }),
    {
      id: AI_HANDLER_IDS.localWorkbench,
      phase: "fallback",
      resolve: state => d.shouldUseLocalWorkbenchReply(state.body.question)
        ? { provider: "local", content: d.localAiReply(state.body, state.db, state.ctx) }
        : null,
      afterResult: ({ result, state }) => { result.confidence = d.aiConfidence(state.body, state.db, result, state.ctx); },
      audit: (_result, state) => ({
        action: "ai_chat",
        summary: `AI answered ${state.body.moduleId || "unknown"} question via local`,
        entity: state.body.moduleId || "ai",
      }),
    },
    {
      id: AI_HANDLER_IDS.marketData,
      phase: "fallback",
      resolve: state => {
        const answer = d.marketPriceReply(state.body.question, state.db);
        return answer ? { provider: "market-data", content: answer, message: answer } : null;
      },
      afterResult: ({ result, state }) => { result.confidence = d.aiConfidence(state.body, state.db, result, state.ctx); },
      audit: (_result, state) => ({
        action: "ai_chat",
        summary: `AI answered ${state.body.moduleId || "unknown"} question via market-data`,
        entity: state.body.moduleId || "ai",
      }),
    },
    {
      id: AI_HANDLER_IDS.providerFallback,
      phase: "fallback",
      resolve: state => {
        if (d.getAiProviderSafetyState().enabled) return null;
        state.technicalDiagnostic = d.isTechnicalProviderDiagnosticPrompt(state.body.question);
        return state.technicalDiagnostic
          ? d.providerDisabledResponse({ startedAt: state.startedAt, branchStartedAt: state.branchStartedAt, body: state.body })
          : d.buildUnknownGuidedFallbackResponse(state.body, d.classifyAiBusinessIntent(state.body));
      },
      decorate: ({ candidate, state }) => state.technicalDiagnostic
        ? candidate
        : {
            ...candidate,
            timingMs: Date.now() - state.startedAt,
            externalMs: 0,
            modelMs: Date.now() - state.branchStartedAt,
          },
      audit: (_result, state) => ({
        action: state.technicalDiagnostic ? "ai_chat_provider_blocked" : "ai_guided_fallback",
        summary: state.technicalDiagnostic
          ? `AI provider fallback blocked for ${state.body.moduleId || "unknown"}`
          : `AI guided unknown ${state.body.moduleId || "unknown"} question`,
        entity: state.body.moduleId || "ai",
        persist: state.technicalDiagnostic,
      }),
      timingBranch: (_result, state) => state.technicalDiagnostic ? "provider_disabled" : "guided_fallback",
    },
    {
      id: AI_HANDLER_IDS.configuredAi,
      phase: "fallback",
      resolve: async state => {
        const useWeb = state.body.useWeb === true ||
          (state.body.useWeb !== false && d.shouldFetchExternalSignals(state.body.question));
        let externalMs = 0;
        if (useWeb) {
          const externalStartedAt = Date.now();
          state.body.externalSignals = await d.fetchExternalSignals();
          externalMs = Date.now() - externalStartedAt;
        }
        const modelStartedAt = Date.now();
        state.branchStartedAt = modelStartedAt;
        let result;
        try {
          result = await d.callConfiguredAi(state.body, state.db, state.ctx);
        } catch {
          result = d.providerFailureResponse({ body: state.body, db: state.db, ctx: state.ctx });
        }
        return {
          ...result,
          usedWeb: useWeb,
          timingMs: Date.now() - state.startedAt,
          externalMs,
          modelMs: Date.now() - modelStartedAt,
        };
      },
      decorate: ({ candidate }) => candidate,
      afterResult: ({ result, state }) => { result.confidence = d.aiConfidence(state.body, state.db, result, state.ctx); },
      audit: (result, state) => ({
        action: "ai_chat",
        summary: `AI answered ${state.body.moduleId || "unknown"} question via ${result.provider}`,
        entity: state.body.moduleId || "ai",
      }),
    },
  ]);
}

export function aiHandlersForPhase(registry, phase) {
  return registry.filter(handler => handler.phase === phase);
}
