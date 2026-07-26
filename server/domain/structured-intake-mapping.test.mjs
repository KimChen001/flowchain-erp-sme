import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSchemaFor } from "./canonical-master-data-schemas.mjs";
import {
  normalizeStructuredRecord,
  suggestFieldMappings,
  validateConfirmedMappings,
  validateNormalizedRecord,
} from "./structured-intake-mapping.mjs";

const schema = {
  ...canonicalSchemaFor("supplier"),
  coreSchemaId: "supplier.v1",
  coreSchemaVersion: 1,
  tenantSchemaHash: "a".repeat(64),
  fields: canonicalSchemaFor("supplier").fields,
};

test("mapping suggestions use deterministic exact, normalized, and Chinese alias tiers", () => {
  const suggestions = suggestFieldMappings({ sourceFields: ["supplier.code", "Supplier Name", "供应商名称", "mystery"], schema });
  assert.deepEqual(suggestions.map(value => value.confidenceTier), ["exact", "strong", "possible", "none"]);
  assert.deepEqual(suggestions.map(value => value.suggestionSource), ["exact_field_path", "normalized_name", "chinese_alias", "none"]);
});

test("confirmed mappings require all canonical required fields and unique targets", () => {
  assert.throws(() => validateConfirmedMappings({ mappings: [{ sourceField: "code", targetField: "supplier.code" }], schema }), error => error.code === "INTAKE_MAPPING_REQUIRED_TARGET_MISSING");
  const mappings = validateConfirmedMappings({
    mappings: [
      { sourceField: "code", targetField: "supplier.code", transformType: "trim" },
      { sourceField: "name", targetField: "supplier.name", transformType: "trim" },
    ],
    schema,
  });
  assert.equal(mappings.length, 2);
});

test("normalization separates standard and custom fields and records evidence", () => {
  const extended = {
    ...schema,
    fields: [...schema.fields, {
      fieldPath: "supplier.custom.is_related_party", fieldKey: "is_related_party", label: "Related", dataType: "boolean",
      required: false, maximumLength: null, allowedValues: [], defaultValue: null, custom: true,
    }],
  };
  const result = normalizeStructuredRecord({
    source: { code: " SUP-1 ", name: "Suzhou Components", related: "yes" },
    recordType: "supplier",
    schema: extended,
    mappingProfile: {
      id: "mapping-1", version: 1,
      fieldMappings: [
        { sourceField: "code", targetField: "supplier.code", transformType: "trim", defaultValue: null },
        { sourceField: "name", targetField: "supplier.name", transformType: "trim", defaultValue: null },
        { sourceField: "related", targetField: "supplier.custom.is_related_party", transformType: "boolean", defaultValue: null },
      ],
    },
  });
  assert.equal(result.normalizedPayload.fields.code, "SUP-1");
  assert.equal(result.normalizedPayload.customFields.is_related_party, true);
  assert.equal(result.evidence[0].mappingProfileId, "mapping-1");
  assert.deepEqual(validateNormalizedRecord({ normalizedPayload: result.normalizedPayload, schema: extended }), []);
});
