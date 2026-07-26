import { assertSafePayload, failIntake } from "./intake-contracts.mjs";
import { canonicalSchemaFor, standardFieldKeys } from "./canonical-master-data-schemas.mjs";

export const CUSTOM_FIELD_TYPES = Object.freeze(["text", "long_text", "integer", "decimal", "date", "boolean", "single_select"]);
const FIELD_KEY = /^[a-z][a-z0-9_]{1,62}$/;
const OPTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor", "password", "secret", "token", "access_token", "refresh_token", "private_key"]);

export function assertCustomFieldIdentity(entityType, fieldKey) {
  canonicalSchemaFor(entityType);
  const key = String(fieldKey || "").trim();
  if (!FIELD_KEY.test(key)) failIntake("CUSTOM_FIELD_KEY_INVALID", "fieldKey must use stable lower_snake_case.", 422);
  if (forbiddenKeys.has(key) || standardFieldKeys(entityType).has(key)) {
    failIntake("CUSTOM_FIELD_KEY_RESERVED", "fieldKey conflicts with a standard or security-classified field.", 422);
  }
  return { entityType: String(entityType), fieldKey: key, fieldPath: `${entityType}.custom.${key}` };
}

export function normalizeCustomFieldRevision(input, { existingType } = {}) {
  const dataType = String(input?.dataType || "").trim();
  if (!CUSTOM_FIELD_TYPES.includes(dataType)) failIntake("CUSTOM_FIELD_TYPE_UNSUPPORTED", "Custom field data type is not supported.", 422);
  if (existingType && existingType !== dataType) failIntake("CUSTOM_FIELD_TYPE_IMMUTABLE", "Published custom field data type cannot change.", 409);
  const label = String(input?.label || "").trim();
  if (!label || label.length > 120) failIntake("CUSTOM_FIELD_LABEL_INVALID", "Custom field label is required and limited to 120 characters.", 422);
  const validationRules = input?.validationRules == null ? {} : assertSafePayload(input.validationRules, { maximumBytes: 8 * 1024 });
  const defaultValue = input?.defaultValue === undefined ? null : assertSafePayload({ value: input.defaultValue }, { maximumBytes: 4 * 1024 }).value;
  const options = Array.isArray(input?.options) ? input.options.map((option, index) => {
    const value = String(option?.value || "").trim();
    const optionLabel = String(option?.label || "").trim();
    if (!OPTION_VALUE.test(value) || !optionLabel || optionLabel.length > 120) failIntake("CUSTOM_FIELD_OPTION_INVALID", "Dropdown options require a stable value and bounded label.", 422);
    return { value, label: optionLabel, position: Number.isInteger(option?.position) ? option.position : index, active: option?.active !== false };
  }) : [];
  if (new Set(options.map(option => option.value)).size !== options.length) failIntake("CUSTOM_FIELD_OPTION_DUPLICATE", "Dropdown option values must be unique.", 422);
  if (dataType === "single_select" && !options.length) failIntake("CUSTOM_FIELD_OPTIONS_REQUIRED", "single_select requires allowlisted options.", 422);
  if (dataType !== "single_select" && options.length) failIntake("CUSTOM_FIELD_OPTIONS_NOT_ALLOWED", "Only single_select fields can define options.", 422);
  return {
    label,
    description: String(input?.description || "").trim().slice(0, 1000) || null,
    dataType,
    required: Boolean(input?.required),
    defaultValue,
    validationRules,
    searchable: Boolean(input?.searchable),
    filterable: Boolean(input?.filterable),
    reportable: Boolean(input?.reportable),
    sensitive: Boolean(input?.sensitive),
    options,
  };
}
