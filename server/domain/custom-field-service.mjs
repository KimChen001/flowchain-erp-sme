import { randomUUID } from "node:crypto";
import { assertCustomFieldIdentity, normalizeCustomFieldRevision } from "./custom-field-contracts.mjs";
import { failIntake } from "./intake-contracts.mjs";

const dtoRevision = revision => ({
  id: revision.id,
  version: revision.version,
  label: revision.label,
  description: revision.description,
  dataType: revision.dataType,
  required: revision.required,
  defaultValue: revision.defaultValue,
  validationRules: revision.validationRules,
  searchable: revision.searchable,
  filterable: revision.filterable,
  reportable: revision.reportable,
  sensitive: revision.sensitive,
  createdAt: revision.createdAt,
  options: (revision.options || []).map(option => ({
    value: option.value, label: option.label, position: option.position, active: option.active,
  })),
});

const dtoDefinition = row => ({
  id: row.id,
  entityType: row.entityType,
  fieldKey: row.fieldKey,
  fieldPath: `${row.entityType}.custom.${row.fieldKey}`,
  status: row.status,
  currentRevisionId: row.currentRevisionId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  revisions: (row.revisions || []).map(dtoRevision),
});

function actorOf(context) {
  const actor = context?.actor;
  if (!actor?.tenantId || !actor?.user?.id) failIntake("TENANT_CONTEXT_REQUIRED", "A tenant-scoped actor is required.", 403);
  return actor;
}

const audit = ({ idFactory, actor, action, entityId, requestId, after }) => ({
  id: idFactory(),
  tenantId: actor.tenantId,
  source: "custom_fields",
  module: "universal-intake",
  action,
  entityType: "CustomFieldDefinition",
  entityId,
  actorId: actor.user.id,
  summary: `${action} CustomFieldDefinition ${entityId}.`,
  metadata: { requestId: String(requestId || "").slice(0, 128) || null, after },
});

export function createCustomFieldService({ repository, idFactory = randomUUID } = {}) {
  if (!repository) throw new Error("Custom field repository is required.");

  async function requireDefinition(actor, id) {
    const row = await repository.getCustomField(actor.tenantId, id);
    if (!row) failIntake("CUSTOM_FIELD_NOT_FOUND", "Custom field was not found.", 404);
    return row;
  }

  async function createRevision(tx, actor, definition, input, requestId) {
    if (definition.status === "retired") failIntake("CUSTOM_FIELD_RETIRED", "Retired custom fields cannot receive new revisions.", 409);
    const published = definition.currentRevisionId
      ? definition.revisions.find(revision => revision.id === definition.currentRevisionId)
      : null;
    const normalized = normalizeCustomFieldRevision(input, { existingType: published?.dataType });
    const version = Math.max(0, ...definition.revisions.map(revision => revision.version)) + 1;
    const id = idFactory();
    await tx.createCustomFieldRevision({
      id,
      tenantId: actor.tenantId,
      definitionId: definition.id,
      version,
      label: normalized.label,
      description: normalized.description,
      dataType: normalized.dataType,
      required: normalized.required,
      defaultValue: normalized.defaultValue,
      validationRules: normalized.validationRules,
      searchable: normalized.searchable,
      filterable: normalized.filterable,
      reportable: normalized.reportable,
      sensitive: normalized.sensitive,
      createdByUserId: actor.user.id,
    });
    if (normalized.options.length) {
      await tx.createCustomFieldOptions(normalized.options.map(option => ({
        id: idFactory(), tenantId: actor.tenantId, revisionId: id, ...option,
      })));
    }
    await tx.createAudit(audit({
      idFactory, actor, action: "custom_field_revision_created", entityId: definition.id, requestId,
      after: { revisionId: id, version, dataType: normalized.dataType, optionCount: normalized.options.length },
    }));
    return id;
  }

  return {
    list: async (query, context) => {
      const actor = actorOf(context);
      const entityType = query?.entityType ? assertCustomFieldIdentity(query.entityType, "placeholder_key").entityType : undefined;
      return { customFields: (await repository.listCustomFields(actor.tenantId, entityType)).map(dtoDefinition) };
    },
    get: async (id, context) => dtoDefinition(await requireDefinition(actorOf(context), id)),
    create: async (input, context) => {
      const actor = actorOf(context);
      const identity = assertCustomFieldIdentity(input?.entityType, input?.fieldKey);
      const definitionId = idFactory();
      await repository.transaction(async tx => {
        const definition = await tx.createCustomField({
          id: definitionId,
          tenantId: actor.tenantId,
          entityType: identity.entityType,
          fieldKey: identity.fieldKey,
          status: "draft",
          createdByUserId: actor.user.id,
        });
        await tx.createAudit(audit({
          idFactory, actor, action: "custom_field_created", entityId: definitionId, requestId: context.requestId,
          after: { entityType: identity.entityType, fieldKey: identity.fieldKey, status: "draft" },
        }));
        await createRevision(tx, actor, { ...definition, revisions: [] }, input?.revision || input, context.requestId);
      });
      return dtoDefinition(await requireDefinition(actor, definitionId));
    },
    revise: async (id, input, context) => {
      const actor = actorOf(context);
      const definition = await requireDefinition(actor, id);
      await repository.transaction(tx => createRevision(tx, actor, definition, input, context.requestId));
      return dtoDefinition(await requireDefinition(actor, id));
    },
    publish: async (id, input, context) => {
      const actor = actorOf(context);
      const definition = await requireDefinition(actor, id);
      if (definition.status === "retired") failIntake("CUSTOM_FIELD_RETIRED", "Retired custom fields cannot be published.", 409);
      const revision = input?.revisionId
        ? definition.revisions.find(value => value.id === String(input.revisionId))
        : definition.revisions[0];
      if (!revision) failIntake("CUSTOM_FIELD_REVISION_NOT_FOUND", "Custom field revision was not found.", 404);
      const current = definition.currentRevisionId && definition.revisions.find(value => value.id === definition.currentRevisionId);
      if (current && current.dataType !== revision.dataType) failIntake("CUSTOM_FIELD_TYPE_IMMUTABLE", "Published custom field data type cannot change.", 409);
      await repository.transaction(async tx => {
        await tx.updateCustomField(actor.tenantId, id, { status: "published", currentRevisionId: revision.id });
        await tx.createAudit(audit({
          idFactory, actor, action: "custom_field_published", entityId: id, requestId: context.requestId,
          after: { revisionId: revision.id, version: revision.version },
        }));
      });
      return dtoDefinition(await requireDefinition(actor, id));
    },
    retire: async (id, context) => {
      const actor = actorOf(context);
      await requireDefinition(actor, id);
      await repository.transaction(async tx => {
        await tx.updateCustomField(actor.tenantId, id, { status: "retired" });
        await tx.createAudit(audit({
          idFactory, actor, action: "custom_field_retired", entityId: id, requestId: context.requestId, after: { status: "retired" },
        }));
      });
      return dtoDefinition(await requireDefinition(actor, id));
    },
  };
}
