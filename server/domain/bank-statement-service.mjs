import { createHash, randomUUID } from "node:crypto";
import { assertAuthorized } from "../auth/authorization-service.mjs";
import { createLocalDurableAttachmentStorage } from "./attachment-storage-provider.mjs";
import { canonicalBankStatementFingerprint, bankAmountString, bankAmountUnits, parseBankStatement } from "./bank-statement-parser.mjs";
import { capabilityForEnvironment } from "./capability-registry.mjs";
import { resolveProvisionedActor } from "./pilot-identity.mjs";
import { assertSafeBankMappingConfiguration } from "./bank-projection-policy.mjs";
import { buildBankImportBatchDto, buildBankImportRowDto, buildBankMappingDto, buildBankStatementLineDto } from "./bank-statement-dto.mjs";

export class BankStatementError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.name = "BankStatementError"; this.code = code; this.status = status; this.details = details; }
}

const text = (value) => String(value ?? "").trim();
const fail = (code, message, status = 400, details) => { throw new BankStatementError(code, message, status, details); };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const jsonHash = (value) => digest(JSON.stringify(value, Object.keys(value || {}).sort()));
const date = (value, code = "BANK_STATEMENT_DATE_INVALID") => { if (!value) return null; const parsed = new Date(value); if (Number.isNaN(parsed.getTime())) fail(code, "Date is invalid.", 422); return parsed; };
const version = (value) => { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) fail("BANK_STATEMENT_VERSION_INVALID", "expectedVersion must be a non-negative integer.", 422); return parsed; };
const ALGORITHM_VERSION = "bank-match-v1.1";
const ALLOWED_ACCOUNT_TYPES = new Set(["bank", "payment_platform"]);

function enabled(env) {
  const capability = capabilityForEnvironment("bank-statement-reconciliation", env);
  if (!capability?.enabled) fail("BANK_RECONCILIATION_CAPABILITY_NOT_AVAILABLE", "Bank statement reconciliation requires database persistence and explicit enablement.", 409);
}

function identity(context) {
  const value = context?.identity || context;
  if (!value?.authenticated || !text(value.tenantId)) fail("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  return value;
}

const has = (actor, permission) => Boolean(actor.permissionCodes?.has(permission));
const authorize = (actor, permission) => assertAuthorized({ actor, permission, tenantId: actor.tenantId });
const limits = (env) => ({ maxFileBytes: Number(env.FLOWCHAIN_BANK_IMPORT_MAX_FILE_BYTES || 20 * 1024 * 1024), maxRows: Number(env.FLOWCHAIN_BANK_IMPORT_MAX_ROWS || 10_000), maxSheets: Number(env.FLOWCHAIN_BANK_IMPORT_MAX_SHEETS || 3) });
const mimeAllowed = (name, mime) => (/\.csv$/i.test(name) && /csv|text\/plain|octet-stream/i.test(mime)) || (/\.xlsx$/i.test(name) && /spreadsheetml|octet-stream/i.test(mime));
const serial = (value) => value?.toISOString?.() || value || null;
const batchProjection = buildBankImportBatchDto;
const lineProjection = buildBankStatementLineDto;
const rowProjection = (row, actor, columnMapping = {}) => buildBankImportRowDto(row, actor, columnMapping);

export function createBankStatementService({ prisma, env = process.env, storageProvider, idFactory = randomUUID, now = () => new Date() } = {}) {
  if (!prisma) throw new Error("prisma is required");
  const storage = storageProvider || createLocalDurableAttachmentStorage({ env, digest });
  const actorFor = async (context, permission) => { enabled(env); const actor = await resolveProvisionedActor(prisma, identity(context)); authorize(actor, permission); return actor; };
  const owned = async (model, id, actor, include) => { const row = await model.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, ...(include ? { include } : {}) }); if (!row) fail("BANK_STATEMENT_NOT_FOUND", "Bank statement resource was not found.", 404); return row; };
  const audit = (tx, actor, action, entityType, entityId, summary, metadata) => tx.auditLog.create({ data: { id: idFactory(), tenantId: actor.tenantId, actorId: actor.user.id, source: "bank_statement_service", module: "finance", action, entityType, entityId, summary, metadata } });
  const change = (tx, actor, entityType, entityId, entityVersion, operation = "upsert", permission = "finance.bank_statement.read", extra = {}) => tx.domainChangeFeed.create({ data: { tenantId: actor.tenantId, entityType, entityId, operation, entityVersion, actorId: actor.user.id, source: "bank_statement_service", requestId: extra.requestId || null, payloadHash: digest(Buffer.from(`${entityType}:${entityId}:${entityVersion ?? ""}:${operation}`)), sensitivityGroups: ["finance_amounts", "finance_partner_snapshot"], moduleKey: "finance", authorizationClass: permission, resourceTenantId: actor.tenantId } });

  async function listMappings(context) { const actor = await actorFor(context, "finance.bank_mapping.read"); return { items: (await prisma.bankStatementMappingTemplate.findMany({ where: { tenantId: actor.tenantId }, orderBy: [{ templateCode: "asc" }, { version: "desc" }] })).map(buildBankMappingDto) }; }
  async function getMapping(id, context) { const actor = await actorFor(context, "finance.bank_mapping.read"); return buildBankMappingDto(await owned(prisma.bankStatementMappingTemplate, id, actor)); }
  async function createMapping(input, context) {
    const actor = await actorFor(context, "finance.bank_mapping.manage");
    try { assertSafeBankMappingConfiguration({ columnMapping: input.columnMapping, metadata: input.metadata }); } catch (error) { fail(error.code, error.message, error.status, error.details); }
    const account = await prisma.cashbookAccount.findFirst({ where: { id: text(input.cashbookAccountId), tenantId: actor.tenantId, status: "active" } });
    if (!account || !ALLOWED_ACCOUNT_TYPES.has(account.accountType)) fail("BANK_STATEMENT_ACCOUNT_NOT_ELIGIBLE", "An active bank or payment-platform cashbook account is required.", 409);
    const templateCode = text(input.templateCode).toUpperCase(); if (!templateCode || !text(input.name)) fail("BANK_MAPPING_INVALID", "Template code and name are required.", 422);
    const existing = await prisma.bankStatementMappingTemplate.findFirst({ where: { tenantId: actor.tenantId, templateCode }, orderBy: { version: "desc" } });
    if (existing) fail("BANK_MAPPING_CODE_EXISTS", "Mapping template code already exists; update it to create a new version.", 409);
    const tenant = text(input.timezone) ? null : await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { timezone: true } });
    const data = { id: idFactory(), tenantId: actor.tenantId, templateCode, name: text(input.name), bankName: text(input.bankName) || null, formatType: text(input.formatType).toLowerCase(), cashbookAccountId: account.id, fileEncoding: text(input.fileEncoding || "auto_detect").toLowerCase(), sheetName: text(input.sheetName) || null, headerRowNumber: Number(input.headerRowNumber || 1), firstDataRowNumber: Number(input.firstDataRowNumber || 2), dateFormat: text(input.dateFormat) || null, decimalSeparator: text(input.decimalSeparator || "."), thousandsSeparator: text(input.thousandsSeparator ?? ","), debitCreditMode: text(input.debitCreditMode).toLowerCase(), signConvention: text(input.signConvention).toLowerCase(), timezone: text(input.timezone || tenant?.timezone || "America/New_York"), columnMapping: input.columnMapping || {}, createdById: actor.user.id, updatedById: actor.user.id, metadata: { ...(input.metadata || {}), credentialsStored: false } };
    // The parser performs the canonical mapping/security validation without accepting any rows.
    if (!new Set(["csv", "xlsx"]).has(data.formatType) || !data.debitCreditMode || !data.signConvention || !Object.keys(data.columnMapping).length) fail("BANK_MAPPING_INVALID", "Mapping format, amount mode, sign convention, and columns are required.", 422);
    const created = await prisma.bankStatementMappingTemplate.create({ data });
    await audit(prisma, actor, "bank_mapping_created", "BankStatementMappingTemplate", created.id, `Created bank mapping ${templateCode} v1.`, { templateCode, version: 1, cashbookAccountId: account.id });
    return buildBankMappingDto(created);
  }
  async function updateMapping(id, input, context) {
    const actor = await actorFor(context, "finance.bank_mapping.manage"); const current = await owned(prisma.bankStatementMappingTemplate, id, actor);
    const nextColumnMapping = input.columnMapping || current.columnMapping;
    const nextMetadata = { ...(current.metadata || {}), ...(input.metadata || {}), previousVersionId: current.id, credentialsStored: false };
    try { assertSafeBankMappingConfiguration({ columnMapping: nextColumnMapping, metadata: nextMetadata }); } catch (error) { fail(error.code, error.message, error.status, error.details); }
    if (current.version !== version(input.expectedVersion)) fail("BANK_MAPPING_VERSION_CONFLICT", "Mapping changed concurrently.", 409);
    const next = await prisma.$transaction(async (tx) => {
      await tx.bankStatementMappingTemplate.update({ where: { id: current.id }, data: { status: "superseded", updatedById: actor.user.id } });
      const created = await tx.bankStatementMappingTemplate.create({ data: { id: idFactory(), tenantId: current.tenantId, templateCode: current.templateCode, version: current.version + 1, status: "active", name: text(input.name || current.name), bankName: text(input.bankName ?? current.bankName) || null, formatType: current.formatType, cashbookAccountId: current.cashbookAccountId, fileEncoding: text(input.fileEncoding || current.fileEncoding), sheetName: text(input.sheetName ?? current.sheetName) || null, headerRowNumber: Number(input.headerRowNumber || current.headerRowNumber), firstDataRowNumber: Number(input.firstDataRowNumber || current.firstDataRowNumber), dateFormat: text(input.dateFormat ?? current.dateFormat) || null, decimalSeparator: text(input.decimalSeparator || current.decimalSeparator), thousandsSeparator: text(input.thousandsSeparator ?? current.thousandsSeparator), debitCreditMode: text(input.debitCreditMode || current.debitCreditMode), signConvention: text(input.signConvention || current.signConvention), timezone: text(input.timezone || current.timezone), columnMapping: nextColumnMapping, updatedById: actor.user.id, createdById: actor.user.id, metadata: nextMetadata } });
      await audit(tx, actor, "bank_mapping_versioned", "BankStatementMappingTemplate", created.id, `Created bank mapping ${created.templateCode} v${created.version}.`, { previousVersionId: current.id, version: created.version }); return created;
    }, { isolationLevel: "Serializable" });
    return buildBankMappingDto(next);
  }

  async function stageUpload(input, context) {
    const actor = await actorFor(context, "finance.bank_statement.import"); const fileName = text(input.fileName), mimeType = text(input.mimeType).toLowerCase();
    if (!fileName || !mimeAllowed(fileName, mimeType) || /\.xlsm$/i.test(fileName)) fail("BANK_STATEMENT_FILE_TYPE_UNSUPPORTED", "Only CSV and XLSX statement files are accepted.", 422);
    let bytes; try { bytes = Buffer.from(text(input.contentBase64), "base64"); } catch { fail("BANK_STATEMENT_UPLOAD_INVALID", "Upload content is invalid.", 422); }
    const configured = limits(env); if (!bytes.length || bytes.length > configured.maxFileBytes) fail("BANK_STATEMENT_FILE_SIZE_INVALID", "Statement file is empty or too large.", 413);
    const sha256 = digest(bytes); if (text(input.sha256) && text(input.sha256).toLowerCase() !== sha256) fail("BANK_STATEMENT_UPLOAD_HASH_MISMATCH", "Supplied SHA-256 does not match the file.", 422);
    const id = idFactory(), storageKey = `${actor.tenantId}/${id}`; await storage.put(storageKey, bytes, sha256);
    const upload = await prisma.stagedUpload.create({ data: { id, tenantId: actor.tenantId, fileName, mimeType, sizeBytes: bytes.length, sha256, storageKey, status: "staged", createdById: actor.user.id, expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000), storageProvider: storage.provider, storageVersion: "v1", persistedAt: now(), storageHealthStatus: "healthy", metadata: { bankStatement: true, binaryInBusinessJson: false } } });
    await audit(prisma, actor, "bank_statement_file_staged", "StagedUpload", upload.id, `Staged bank statement ${fileName}.`, { sha256, sizeBytes: bytes.length, durable: true });
    return { uploadId: upload.id, fileName, mimeType, sizeBytes: bytes.length, sha256, status: upload.status, expiresAt: serial(upload.expiresAt) };
  }

  async function createBatch(input, context) {
    const actor = await actorFor(context, "finance.bank_statement.import");
    const [account, mapping, upload] = await Promise.all([
      prisma.cashbookAccount.findFirst({ where: { id: text(input.cashbookAccountId), tenantId: actor.tenantId, status: "active" } }),
      prisma.bankStatementMappingTemplate.findFirst({ where: { id: text(input.mappingTemplateId), tenantId: actor.tenantId, status: "active" } }),
      prisma.stagedUpload.findFirst({ where: { id: text(input.uploadId), tenantId: actor.tenantId, status: "staged" } }),
    ]);
    if (!account || !ALLOWED_ACCOUNT_TYPES.has(account.accountType)) fail("BANK_STATEMENT_ACCOUNT_NOT_ELIGIBLE", "An active bank or payment-platform account is required.", 409);
    if (!mapping || mapping.cashbookAccountId !== account.id) fail("BANK_MAPPING_NOT_AVAILABLE", "An active mapping for the same account is required.", 409);
    if (!upload || upload.createdById !== actor.user.id || upload.expiresAt <= now()) fail("BANK_STATEMENT_UPLOAD_NOT_AVAILABLE", "A current actor-owned staged upload is required.", 409);
    const currency = text(input.currency || account.currency).toUpperCase(); if (currency !== account.currency) fail("BANK_STATEMENT_CURRENCY_MISMATCH", "Statement and cashbook account currency must match; FX is unavailable.", 409);
    const count = await prisma.bankStatementImportBatch.count({ where: { tenantId: actor.tenantId } });
    const batch = await prisma.bankStatementImportBatch.create({ data: { id: idFactory(), tenantId: actor.tenantId, batchNumber: text(input.batchNumber) || `BST-${String(count + 1).padStart(6, "0")}`, cashbookAccountId: account.id, mappingTemplateId: mapping.id, mappingTemplateVersion: mapping.version, uploadId: upload.id, fileName: upload.fileName, fileMimeType: upload.mimeType, fileSha256: upload.sha256, sourceType: text(input.sourceType || "file_upload"), coverageType: text(input.coverageType || "transaction_export"), statementStartDate: date(input.statementStartDate), statementEndDate: date(input.statementEndDate), openingBalance: input.openingBalance == null ? null : bankAmountString(bankAmountUnits(input.openingBalance)), closingBalance: input.closingBalance == null ? null : bankAmountString(bankAmountUnits(input.closingBalance)), currency, bankNameSnapshot: mapping.bankName, createdById: actor.user.id, metadata: { bankApiConnected: false, balanceCompletenessClaimed: text(input.coverageType) === "full_statement" } } });
    await audit(prisma, actor, "bank_statement_batch_created", "BankStatementImportBatch", batch.id, `Created bank statement batch ${batch.batchNumber}.`, { uploadId: upload.id, fileSha256: upload.sha256, mappingTemplateId: mapping.id, mappingTemplateVersion: mapping.version });
    return batchProjection(batch, actor);
  }

  async function parseBatch(id, context) {
    const actor = await actorFor(context, "finance.bank_statement.validate"); const batch = await owned(prisma.bankStatementImportBatch, id, actor, { mappingTemplate: true, upload: true });
    if (batch.workflowStatus !== "draft") fail("BANK_STATEMENT_BATCH_IMMUTABLE", "Only a draft batch may be parsed.", 409);
    const bytes = await storage.get(batch.upload.storageKey); if (digest(bytes) !== batch.fileSha256) fail("BANK_STATEMENT_UPLOAD_HASH_MISMATCH", "Stored statement hash does not match batch evidence.", 409);
    const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { locale: true } });
    const parsed = parseBankStatement({ bytes, fileName: batch.fileName, mimeType: batch.fileMimeType, mapping: batch.mappingTemplate, limits: limits(env), tenantLocale: tenant?.locale });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.bankStatementImportRow.deleteMany({ where: { tenantId: actor.tenantId, batchId: batch.id } });
      await tx.bankStatementImportRow.createMany({ data: parsed.rows.map((row) => ({ id: idFactory(), tenantId: actor.tenantId, batchId: batch.id, sourceSheet: row.sourceSheet, sourceRowNumber: row.sourceRowNumber, rawRowHash: row.rawRowHash, rawData: row.rawData, normalizedTransactionId: row.normalizedTransactionId, normalizedTransactionDate: row.normalizedTransactionDate, normalizedPostingDate: row.normalizedPostingDate, normalizedValueDate: row.normalizedValueDate, normalizedDirection: row.normalizedDirection, normalizedAmount: row.normalizedAmount, normalizedCurrency: row.normalizedCurrency || batch.currency, normalizedCounterpartyName: row.normalizedCounterpartyName, normalizedCounterpartyAccountMasked: row.normalizedCounterpartyAccountMasked, normalizedCounterpartyAccountHash: row.normalizedCounterpartyAccountHash, normalizedDescription: row.normalizedDescription, normalizedBankReference: row.normalizedBankReference, normalizedCustomerReference: row.normalizedCustomerReference, normalizedRunningBalance: row.normalizedRunningBalance, validationStatus: row.validationStatus, duplicateStatus: row.duplicateStatus, issueCodes: row.issueCodes, overrideData: row.issue ? { issue: row.issue } : undefined })) });
      const accountEvidence = parsed.rows.find((row) => row.bankAccountIdentifierHash);
      const result = await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { totalRowCount: parsed.totalRowCount, errorRowCount: parsed.errorRowCount, accountIdentifierMasked: accountEvidence?.bankAccountIdentifierMasked || batch.accountIdentifierMasked, accountIdentifierHash: accountEvidence?.bankAccountIdentifierHash || batch.accountIdentifierHash, validationStatus: "not_validated", version: { increment: 1 }, metadata: { ...(batch.metadata || {}), detectedEncoding: parsed.detectedEncoding, parserLimits: parsed.limits } } });
      await audit(tx, actor, "bank_statement_batch_parsed", "BankStatementImportBatch", batch.id, `Parsed ${parsed.totalRowCount} bank statement rows.`, { fileSha256: batch.fileSha256, mappingTemplateVersion: batch.mappingTemplateVersion, totalRowCount: parsed.totalRowCount, errorRowCount: parsed.errorRowCount }); return result;
    }, { isolationLevel: "Serializable" });
    return batchProjection(updated, actor);
  }

  async function validateBatch(id, context) {
    const actor = await actorFor(context, "finance.bank_statement.validate"); const batch = await owned(prisma.bankStatementImportBatch, id, actor, { rows: true });
    if (batch.workflowStatus !== "draft" || !batch.rows.length) fail("BANK_STATEMENT_BATCH_NOT_PARSED", "A parsed draft batch is required.", 409);
    let credits = 0n, debits = 0n, exact = 0, possible = 0, errors = 0, accepted = 0;
    await prisma.$transaction(async (tx) => {
      const seenTransactionIds = new Map(), seenCanonicalFingerprints = new Map();
      for (const row of [...batch.rows].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber)) {
        if (["error", "excluded"].includes(row.validationStatus)) { if (row.validationStatus === "error") errors += 1; continue; }
        const issueCodes = [...row.issueCodes]; let duplicateStatus = "none", validationStatus = "valid";
        if (row.normalizedCurrency !== batch.currency) { issueCodes.push("BANK_STATEMENT_CURRENCY_MISMATCH"); validationStatus = "error"; errors += 1; }
        const fingerprint = canonicalBankStatementFingerprint({ cashbookAccountId: batch.cashbookAccountId, currency: row.normalizedCurrency, direction: row.normalizedDirection, amount: row.normalizedAmount, transactionDate: row.normalizedTransactionDate, valueDate: row.normalizedValueDate, bankReference: row.normalizedBankReference, counterpartyAccountHash: row.normalizedCounterpartyAccountHash, description: row.normalizedDescription });
        const exactLine = await tx.bankStatementLine.findFirst({ where: { tenantId: actor.tenantId, cashbookAccountId: batch.cashbookAccountId, status: "active", OR: row.normalizedTransactionId ? [{ bankTransactionId: row.normalizedTransactionId }, { canonicalFingerprint: fingerprint }] : [{ canonicalFingerprint: fingerprint }] } });
        const priorTransactionRowId = row.normalizedTransactionId ? seenTransactionIds.get(row.normalizedTransactionId) : null;
        const priorFingerprintRowId = seenCanonicalFingerprints.get(fingerprint);
        let duplicateEvidence = {};
        if (exactLine) { duplicateStatus = "exact_duplicate"; validationStatus = "error"; issueCodes.push("BANK_STATEMENT_TRANSACTION_ALREADY_IMPORTED"); duplicateEvidence = { duplicateSource: "committed_line", duplicateOfLineId: exactLine.id }; exact += 1; errors += 1; }
        else if (priorTransactionRowId) { duplicateStatus = "exact_duplicate"; validationStatus = "error"; issueCodes.push("BANK_ROW_DUPLICATE_TRANSACTION_ID_IN_BATCH"); duplicateEvidence = { duplicateSource: "same_batch_row", duplicateOfRowId: priorTransactionRowId }; exact += 1; errors += 1; }
        else if (priorFingerprintRowId) { duplicateStatus = "exact_duplicate"; validationStatus = "error"; issueCodes.push("BANK_ROW_DUPLICATE_FINGERPRINT_IN_BATCH"); duplicateEvidence = { duplicateSource: "same_batch_row", duplicateOfRowId: priorFingerprintRowId }; exact += 1; errors += 1; }
        else {
          const start = new Date(row.normalizedTransactionDate); start.setUTCDate(start.getUTCDate() - 3); const end = new Date(row.normalizedTransactionDate); end.setUTCDate(end.getUTCDate() + 3);
          const near = await tx.bankStatementLine.findFirst({ where: { tenantId: actor.tenantId, cashbookAccountId: batch.cashbookAccountId, status: "active", direction: row.normalizedDirection, amount: row.normalizedAmount, transactionDate: { gte: start, lte: end } } });
          if (near) { duplicateStatus = "possible_duplicate"; validationStatus = "warning"; issueCodes.push("BANK_STATEMENT_POSSIBLE_DUPLICATE"); possible += 1; }
        }
        if (row.normalizedTransactionId && !seenTransactionIds.has(row.normalizedTransactionId)) seenTransactionIds.set(row.normalizedTransactionId, row.id);
        if (!seenCanonicalFingerprints.has(fingerprint)) seenCanonicalFingerprints.set(fingerprint, row.id);
        if (validationStatus !== "error") { accepted += 1; const amount = bankAmountUnits(row.normalizedAmount); if (row.normalizedDirection === "credit") credits += amount; else debits += amount; }
        await tx.bankStatementImportRow.update({ where: { id: row.id }, data: { duplicateStatus, validationStatus, issueCodes: [...new Set(issueCodes)], overrideData: { ...(row.overrideData || {}), canonicalFingerprint: fingerprint, ...duplicateEvidence } } });
      }
      let balanceMismatch = false;
      if (batch.coverageType === "full_statement" && batch.openingBalance != null && batch.closingBalance != null) {
        const calculated = bankAmountUnits(batch.openingBalance) + credits - debits; const recorded = bankAmountUnits(batch.closingBalance); balanceMismatch = calculated !== recorded;
      }
      const validationStatus = errors ? "invalid" : possible || balanceMismatch ? "valid_with_warnings" : "valid";
      await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { workflowStatus: validationStatus === "invalid" ? "draft" : "validated", validationStatus, acceptedRowCount: accepted, errorRowCount: errors, exactDuplicateRowCount: exact, possibleDuplicateRowCount: possible, validatedById: actor.user.id, validatedAt: now(), version: { increment: 1 }, metadata: { ...(batch.metadata || {}), credits: bankAmountString(credits), debits: bankAmountString(debits), balanceDifference: batch.openingBalance != null && batch.closingBalance != null ? bankAmountString(bankAmountUnits(batch.openingBalance) + credits - debits - bankAmountUnits(batch.closingBalance)) : null, balanceOverrideRequired: balanceMismatch, transactionExportLimitation: batch.coverageType === "transaction_export" } } });
      await audit(tx, actor, "bank_statement_batch_validated", "BankStatementImportBatch", batch.id, `Validated bank statement batch ${batch.batchNumber}.`, { validationStatus, accepted, errors, exact, possible, balanceMismatch });
    }, { isolationLevel: "Serializable" });
    return batchProjection(await prisma.bankStatementImportBatch.findUnique({ where: { id: batch.id } }), actor);
  }

  async function updateRow(batchId, rowId, input, context) {
    const actor = await actorFor(context, "finance.bank_statement.validate"); const batch = await owned(prisma.bankStatementImportBatch, batchId, actor); if (batch.workflowStatus === "committed") fail("BANK_STATEMENT_BATCH_IMMUTABLE", "Committed rows cannot be modified.", 409);
    const row = await prisma.bankStatementImportRow.findFirst({ where: { id: text(rowId), tenantId: actor.tenantId, batchId: batch.id } }); if (!row) fail("BANK_STATEMENT_ROW_NOT_FOUND", "Statement row was not found.", 404);
    if (row.version !== version(input.expectedVersion)) fail("BANK_STATEMENT_ROW_VERSION_CONFLICT", "Statement row changed concurrently.", 409); if (!text(input.overrideReason)) fail("BANK_STATEMENT_OVERRIDE_REASON_REQUIRED", "Row override requires a reason.", 422);
    const changes = input.changes || {}; const data = { overrideData: { before: { transactionId: row.normalizedTransactionId, transactionDate: row.normalizedTransactionDate, direction: row.normalizedDirection, amount: row.normalizedAmount?.toString?.(), currency: row.normalizedCurrency, counterpartyName: row.normalizedCounterpartyName, description: row.normalizedDescription, bankReference: row.normalizedBankReference, customerReference: row.normalizedCustomerReference }, after: changes }, overrideReason: text(input.overrideReason), overriddenById: actor.user.id, validationStatus: "pending", duplicateStatus: "none", issueCodes: [], version: { increment: 1 } };
    if (changes.amount != null) data.normalizedAmount = bankAmountString(bankAmountUnits(changes.amount)); if (changes.direction != null) { if (!new Set(["credit", "debit"]).has(text(changes.direction))) fail("BANK_STATEMENT_DIRECTION_INVALID", "Direction must be credit or debit.", 422); data.normalizedDirection = text(changes.direction); }
    if (changes.transactionDate != null) data.normalizedTransactionDate = date(changes.transactionDate); if (changes.currency != null) data.normalizedCurrency = text(changes.currency).toUpperCase();
    for (const [source, target] of [["transactionId", "normalizedTransactionId"], ["counterpartyName", "normalizedCounterpartyName"], ["description", "normalizedDescription"], ["bankReference", "normalizedBankReference"], ["customerReference", "normalizedCustomerReference"]]) if (changes[source] !== undefined) data[target] = text(changes[source]) || null;
    const updated = await prisma.$transaction(async (tx) => { const result = await tx.bankStatementImportRow.update({ where: { id: row.id }, data }); await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { workflowStatus: "draft", validationStatus: "not_validated", version: { increment: 1 } } }); await audit(tx, actor, "bank_statement_row_overridden", "BankStatementImportRow", row.id, `Overrode statement row ${row.sourceRowNumber}.`, { beforeHash: jsonHash(rowProjection(row, actor)), afterHash: jsonHash(changes), reason: text(input.overrideReason) }); return result; }); return rowProjection(updated, actor);
  }
  async function decideRow(batchId, rowId, action, input, context) {
    const actor = await actorFor(context, "finance.bank_statement.validate"); const batch = await owned(prisma.bankStatementImportBatch, batchId, actor); if (batch.workflowStatus === "committed") fail("BANK_STATEMENT_BATCH_IMMUTABLE", "Committed rows cannot be modified.", 409);
    const row = await prisma.bankStatementImportRow.findFirst({ where: { id: text(rowId), tenantId: actor.tenantId, batchId: batch.id } }); if (!row) fail("BANK_STATEMENT_ROW_NOT_FOUND", "Statement row was not found.", 404); if (!text(input.reason)) fail("BANK_STATEMENT_DECISION_REASON_REQUIRED", "A duplicate/exclusion decision requires a reason.", 422);
    const updated = await prisma.$transaction(async (tx) => { const result = await tx.bankStatementImportRow.update({ where: { id: row.id }, data: { validationStatus: "excluded", overrideReason: text(input.reason), overriddenById: actor.user.id, overrideData: { ...(row.overrideData || {}), decision: action, duplicateEvidenceLinked: action === "accept_duplicate" }, version: { increment: 1 } } }); await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { workflowStatus: "draft", validationStatus: "not_validated", version: { increment: 1 } } }); await audit(tx, actor, action === "accept_duplicate" ? "bank_statement_duplicate_linked" : "bank_statement_row_excluded", "BankStatementImportRow", row.id, `Recorded ${action} for statement row ${row.sourceRowNumber}.`, { reason: text(input.reason), duplicateStatus: row.duplicateStatus }); return result; }); return rowProjection(updated, actor);
  }

  async function commitBatch(id, input, context) {
    const actor = await actorFor(context, "finance.bank_statement.commit"); const idempotencyKey = text(input.idempotencyKey); if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.", 422); const requestHash = digest(Buffer.from(JSON.stringify({ id: text(id), expectedVersion: input.expectedVersion, overrideReason: text(input.overrideReason) })));
    const where = { tenantId_commandType_idempotencyKey: { tenantId: actor.tenantId, commandType: "commit_bank_statement", idempotencyKey } }; const previous = await prisma.businessCommandExecution.findUnique({ where }); if (previous) { if (previous.requestHash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", "Idempotency key was used with a different payload.", 409); if (previous.status === "completed") return { ...previous.resultPayload, idempotentReplay: true }; }
    return prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "BankStatementImportBatch" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id));
      const batch = await tx.bankStatementImportBatch.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { rows: true } }); if (!batch) fail("BANK_STATEMENT_BATCH_NOT_FOUND", "Statement batch was not found.", 404); if (batch.version !== version(input.expectedVersion)) fail("BANK_STATEMENT_BATCH_VERSION_CONFLICT", "Statement batch changed concurrently.", 409);
      if (!new Set(["valid", "valid_with_warnings"]).has(batch.validationStatus) || batch.workflowStatus !== "validated") fail("BANK_STATEMENT_BATCH_NOT_COMMITTABLE", "Only a validated batch can be committed.", 409);
      if (batch.metadata?.balanceOverrideRequired && (!text(input.overrideReason) || !input.supportingEvidence)) fail("BANK_STATEMENT_BALANCE_MISMATCH", "Full-statement balances do not reconcile; override requires a reason and supporting evidence.", 422, { differenceAmount: batch.metadata?.balanceDifference, overrideRequired: true });
      const duplicateFile = await tx.bankStatementImportBatch.findFirst({ where: { tenantId: actor.tenantId, cashbookAccountId: batch.cashbookAccountId, fileSha256: batch.fileSha256, workflowStatus: "committed", id: { not: batch.id } } }); if (duplicateFile) fail("BANK_STATEMENT_FILE_ALREADY_IMPORTED", "This statement file is already committed for the account.", 409);
      const rows = batch.rows.filter((row) => ["valid", "warning", "accepted"].includes(row.validationStatus) && row.duplicateStatus !== "exact_duplicate").sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
      const transactionIds = new Set(), fingerprints = new Set();
      for (const row of rows) {
        const fingerprint = row.overrideData?.canonicalFingerprint || canonicalBankStatementFingerprint({ cashbookAccountId: batch.cashbookAccountId, currency: row.normalizedCurrency, direction: row.normalizedDirection, amount: row.normalizedAmount, transactionDate: row.normalizedTransactionDate, valueDate: row.normalizedValueDate, bankReference: row.normalizedBankReference, counterpartyAccountHash: row.normalizedCounterpartyAccountHash, description: row.normalizedDescription });
        if (row.normalizedTransactionId && transactionIds.has(row.normalizedTransactionId)) fail("BANK_ROW_DUPLICATE_TRANSACTION_ID_IN_BATCH", "A transaction identifier is duplicated within this batch.", 409, { rowId: row.id });
        if (fingerprints.has(fingerprint)) fail("BANK_ROW_DUPLICATE_FINGERPRINT_IN_BATCH", "A canonical transaction fingerprint is duplicated within this batch.", 409, { rowId: row.id });
        const committedDuplicate = await tx.bankStatementLine.findFirst({ where: { tenantId: actor.tenantId, cashbookAccountId: batch.cashbookAccountId, status: "active", OR: row.normalizedTransactionId ? [{ bankTransactionId: row.normalizedTransactionId }, { canonicalFingerprint: fingerprint }] : [{ canonicalFingerprint: fingerprint }] }, select: { id: true } });
        if (committedDuplicate) fail("BANK_STATEMENT_TRANSACTION_ALREADY_IMPORTED", "A statement transaction was committed concurrently.", 409, { duplicateOfLineId: committedDuplicate.id });
        if (row.normalizedTransactionId) transactionIds.add(row.normalizedTransactionId); fingerprints.add(fingerprint);
      }
      const execution = await tx.businessCommandExecution.create({ data: { id: idFactory(), tenantId: actor.tenantId, commandType: "commit_bank_statement", idempotencyKey, requestHash, status: "pending" } });
      for (let index = 0; index < rows.length; index += 1) { const row = rows[index], fingerprint = row.overrideData?.canonicalFingerprint || canonicalBankStatementFingerprint({ cashbookAccountId: batch.cashbookAccountId, currency: row.normalizedCurrency, direction: row.normalizedDirection, amount: row.normalizedAmount, transactionDate: row.normalizedTransactionDate, valueDate: row.normalizedValueDate, bankReference: row.normalizedBankReference, counterpartyAccountHash: row.normalizedCounterpartyAccountHash, description: row.normalizedDescription }); const createdLine = await tx.bankStatementLine.create({ data: { id: idFactory(), tenantId: actor.tenantId, batchId: batch.id, cashbookAccountId: batch.cashbookAccountId, lineNumber: index + 1, bankTransactionId: row.normalizedTransactionId, transactionDate: row.normalizedTransactionDate, postingDate: row.normalizedPostingDate, valueDate: row.normalizedValueDate, direction: row.normalizedDirection, amount: row.normalizedAmount, currency: row.normalizedCurrency, counterpartyName: row.normalizedCounterpartyName, counterpartyAccountMasked: row.normalizedCounterpartyAccountMasked, counterpartyAccountHash: row.normalizedCounterpartyAccountHash, description: row.normalizedDescription, bankReference: row.normalizedBankReference, customerReference: row.normalizedCustomerReference, runningBalance: row.normalizedRunningBalance, canonicalFingerprint: fingerprint, remainingAmount: row.normalizedAmount, sourceRowId: row.id, metadata: { sourceRowHash: row.rawRowHash, mappingTemplateId: batch.mappingTemplateId, mappingTemplateVersion: batch.mappingTemplateVersion } } }); await change(tx, actor, "BankStatementLine", createdLine.id, createdLine.version, "upsert", "finance.bank_statement.read", { requestId: idempotencyKey }); }
      const committed = await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { workflowStatus: "committed", importedLineCount: rows.length, committedById: actor.user.id, committedAt: now(), version: { increment: 1 }, metadata: { ...(batch.metadata || {}), balanceOverrideReason: text(input.overrideReason) || null, supportingEvidence: input.supportingEvidence || null } } }); await tx.stagedUpload.update({ where: { id: batch.uploadId }, data: { status: "bound", boundAt: now() } });
      await audit(tx, actor, "bank_statement_batch_committed", "BankStatementImportBatch", batch.id, `Committed ${rows.length} immutable bank statement lines.`, { fileSha256: batch.fileSha256, mappingTemplateId: batch.mappingTemplateId, mappingTemplateVersion: batch.mappingTemplateVersion, importedLineCount: rows.length, cashbookMutation: false }); await change(tx, actor, "BankStatementImportBatch", batch.id, committed.version, "upsert", "finance.bank_statement.read", { requestId: idempotencyKey });
      const result = { batchId: batch.id, batchNumber: batch.batchNumber, workflowStatus: "committed", importedLineCount: rows.length, fileSha256: batch.fileSha256, cashbookMutation: false, idempotentReplay: false }; await tx.businessCommandExecution.update({ where: { id: execution.id }, data: { status: "completed", entityType: "BankStatementImportBatch", entityId: batch.id, resultPayload: result, completedAt: now() } }); return result;
    }, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 30_000 });
  }

  async function voidBatch(id, input, context) {
    const actor = await actorFor(context, "finance.bank_statement.void"); if (!text(input.reason)) fail("BANK_STATEMENT_VOID_REASON_REQUIRED", "Void requires a reason.", 422);
    return prisma.$transaction(async (tx) => { await tx.$queryRawUnsafe('SELECT "id" FROM "BankStatementImportBatch" WHERE "tenantId" = $1 AND "id" = $2 FOR UPDATE', actor.tenantId, text(id)); const batch = await tx.bankStatementImportBatch.findFirst({ where: { id: text(id), tenantId: actor.tenantId }, include: { lines: { include: { allocations: { include: { group: true } } } } } }); if (!batch) fail("BANK_STATEMENT_BATCH_NOT_FOUND", "Statement batch was not found.", 404); if (batch.version !== version(input.expectedVersion)) fail("BANK_STATEMENT_BATCH_VERSION_CONFLICT", "Statement batch changed concurrently.", 409); if (batch.workflowStatus !== "committed") fail("BANK_STATEMENT_BATCH_NOT_VOIDABLE", "Only a committed batch may be voided.", 409); if (batch.lines.some((line) => line.allocations.some((allocation) => allocation.group.workflowStatus === "confirmed"))) fail("BANK_STATEMENT_BATCH_HAS_CONFIRMED_RECONCILIATION", "Reverse confirmed reconciliations before voiding the batch.", 409); await tx.bankStatementLine.updateMany({ where: { tenantId: actor.tenantId, batchId: batch.id }, data: { status: "voided", reconciliationStatus: "voided", matchedAmount: 0, version: { increment: 1 } } }); const voided = await tx.bankStatementImportBatch.update({ where: { id: batch.id }, data: { workflowStatus: "voided", voidReason: text(input.reason), voidedById: actor.user.id, voidedAt: now(), version: { increment: 1 } } }); await audit(tx, actor, "bank_statement_batch_voided", "BankStatementImportBatch", batch.id, `Voided bank statement batch ${batch.batchNumber}.`, { reason: text(input.reason), linesRetained: batch.lines.length }); await change(tx, actor, "BankStatementImportBatch", batch.id, voided.version, "upsert"); for (const line of batch.lines) await change(tx, actor, "BankStatementLine", line.id, line.version + 1, "upsert"); return { batchId: batch.id, workflowStatus: "voided", linesRetained: batch.lines.length }; }, { isolationLevel: "Serializable" });
  }

  async function listBatches(filters, context) { const actor = await actorFor(context, "finance.bank_statement.read"); const rows = await prisma.bankStatementImportBatch.findMany({ where: { tenantId: actor.tenantId, ...(filters?.workflowStatus ? { workflowStatus: text(filters.workflowStatus) } : {}) }, orderBy: { createdAt: "desc" } }); return { items: rows.map((row) => batchProjection(row, actor)) }; }
  async function getBatch(id, context) { const actor = await actorFor(context, "finance.bank_statement.read"); return batchProjection(await owned(prisma.bankStatementImportBatch, id, actor), actor); }
  async function listRows(id, context) { const actor = await actorFor(context, "finance.bank_statement.read"); const batch = await owned(prisma.bankStatementImportBatch, id, actor, { mappingTemplate: true }); return { items: (await prisma.bankStatementImportRow.findMany({ where: { tenantId: actor.tenantId, batchId: text(id) }, orderBy: { sourceRowNumber: "asc" } })).map((row) => rowProjection(row, actor, batch.mappingTemplate.columnMapping)) }; }
  async function listLines(filters, context) { const actor = await actorFor(context, "finance.bank_statement.read"); const rows = await prisma.bankStatementLine.findMany({ where: { tenantId: actor.tenantId, ...(filters?.status ? { status: text(filters.status) } : {}), ...(filters?.reconciliationStatus ? { reconciliationStatus: text(filters.reconciliationStatus) } : {}) }, orderBy: [{ transactionDate: "desc" }, { lineNumber: "asc" }] }); return { items: rows.map((row) => lineProjection(row, actor)) }; }
  async function getLine(id, context) { const actor = await actorFor(context, "finance.bank_statement.read"); return lineProjection(await owned(prisma.bankStatementLine, id, actor), actor); }

  return { listMappings, getMapping, createMapping, updateMapping, stageUpload, createBatch, parseBatch, validateBatch, updateRow, excludeRow: (batchId, rowId, input, context) => decideRow(batchId, rowId, "exclude", input, context), acceptDuplicate: (batchId, rowId, input, context) => decideRow(batchId, rowId, "accept_duplicate", input, context), commitBatch, voidBatch, listBatches, getBatch, listRows, listLines, getLine, storage };
}

export { ALGORITHM_VERSION as bankReconciliationAlgorithmVersion };
