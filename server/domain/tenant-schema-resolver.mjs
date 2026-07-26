import { createHash } from "node:crypto";
import { failIntake } from "./intake-contracts.mjs";
import { canonicalSchemaFor } from "./canonical-master-data-schemas.mjs";

const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;

export function customRevisionToSchemaField(definition) {
  const revision = definition.revisions?.find(value => value.id === definition.currentRevisionId);
  if (!revision || definition.status !== "published") return null;
  return {
    fieldPath: `${definition.entityType}.custom.${definition.fieldKey}`,
    fieldKey: definition.fieldKey,
    label: revision.label,
    dataType: revision.dataType,
    required: revision.required,
    maximumLength: revision.validationRules?.maximumLength ?? null,
    allowedValues: revision.dataType === "single_select" ? revision.options.filter(option => option.active).map(option => option.value) : [],
    defaultValue: revision.defaultValue,
    naturalKey: false,
    sensitive: revision.sensitive,
    searchable: revision.searchable,
    filterable: revision.filterable,
    reportable: revision.reportable,
    description: revision.description || "",
    aliases: [],
    custom: true,
    definitionId: definition.id,
    revisionId: revision.id,
    revisionVersion: revision.version,
  };
}

export async function resolveTenantEntitySchema({ repository, tenantId, recordType, clock = () => new Date() }) {
  const core = canonicalSchemaFor(recordType);
  const definitions = await repository.listPublishedCustomFields(tenantId, recordType);
  const customFields = definitions.map(customRevisionToSchemaField).filter(Boolean).sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
  const fields = [...core.fields.map(value => ({ ...value })), ...customFields];
  if (new Set(fields.map(value => value.fieldPath)).size !== fields.length) failIntake("INTAKE_SCHEMA_FIELD_DUPLICATE", "Resolved schema contains duplicate field paths.", 500);
  const hashInput = { coreSchemaId: core.schemaId, coreSchemaVersion: core.version, fields };
  const tenantSchemaHash = createHash("sha256").update(JSON.stringify(stable(hashInput))).digest("hex");
  const resolved = {
    entityType: core.entityType,
    coreSchemaId: core.schemaId,
    coreSchemaVersion: core.version,
    tenantSchemaHash,
    fields,
    customFieldRevisionIds: customFields.map(value => value.revisionId),
    generatedAt: clock().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(resolved), "utf8") > 256 * 1024) {
    failIntake("INTAKE_SCHEMA_SNAPSHOT_SIZE_LIMIT", "Resolved tenant schema exceeds the supported snapshot size.", 413);
  }
  return resolved;
}
