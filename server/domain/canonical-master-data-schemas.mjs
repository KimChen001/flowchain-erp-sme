const field = (fieldPath, label, dataType, options = {}) => Object.freeze({
  fieldPath,
  label,
  dataType,
  required: Boolean(options.required),
  maximumLength: options.maximumLength ?? null,
  allowedValues: Object.freeze([...(options.allowedValues || [])]),
  defaultValue: options.defaultValue ?? null,
  naturalKey: Boolean(options.naturalKey),
  sensitive: Boolean(options.sensitive),
  searchable: Boolean(options.searchable),
  description: options.description || "",
  aliases: Object.freeze([...(options.aliases || [])]),
  custom: false,
});

const commonStatus = ["active", "inactive"];
const currencyAliases = ["currency", "币种", "货币", "默认币种"];
const statusAliases = ["status", "状态", "启用状态"];

const schemas = {
  supplier: {
    schemaId: "supplier.v1",
    entityType: "supplier",
    version: 1,
    fields: [
      field("supplier.code", "Supplier Code", "text", { required: true, maximumLength: 64, naturalKey: true, searchable: true, aliases: ["supplier_code", "vendor_code", "供应商编码", "供应商代码"] }),
      field("supplier.name", "Supplier Name", "text", { required: true, maximumLength: 200, searchable: true, aliases: ["supplier_name", "vendor_name", "供应商名称", "供应商"] }),
      field("supplier.status", "Status", "single_select", { required: true, allowedValues: commonStatus, defaultValue: "active", aliases: statusAliases }),
      field("supplier.currency", "Currency", "currency_code", { required: true, defaultValue: "CNY", aliases: currencyAliases }),
      field("supplier.paymentTermCode", "Payment Term Code", "text", { maximumLength: 64, aliases: ["payment_terms", "payment_term", "付款条件", "账期"] }),
      field("supplier.contactName", "Contact Name", "text", { maximumLength: 120, aliases: ["contact", "联系人"] }),
      field("supplier.email", "Email", "email", { maximumLength: 254, sensitive: true, aliases: ["email_address", "邮箱", "电子邮箱"] }),
      field("supplier.phone", "Phone", "text", { maximumLength: 40, sensitive: true, aliases: ["telephone", "mobile", "电话", "手机号"] }),
      field("supplier.countryCode", "Country Code", "text", { maximumLength: 2, defaultValue: "CN", aliases: ["country", "country_code", "国家", "国家代码"] }),
    ],
  },
  item: {
    schemaId: "item.v1",
    entityType: "item",
    version: 1,
    fields: [
      field("item.sku", "SKU", "text", { required: true, maximumLength: 80, naturalKey: true, searchable: true, aliases: ["item_code", "material_code", "物料编码", "商品编码", "SKU"] }),
      field("item.name", "Item Name", "text", { required: true, maximumLength: 200, searchable: true, aliases: ["item_name", "material_name", "物料名称", "商品名称"] }),
      field("item.unit", "Base Unit", "text", { required: true, maximumLength: 24, aliases: ["base_unit", "uom", "单位", "基本单位"] }),
      field("item.status", "Status", "single_select", { required: true, allowedValues: commonStatus, defaultValue: "active", aliases: statusAliases }),
      field("item.preferredSupplierCode", "Preferred Supplier Code", "text", { maximumLength: 64, aliases: ["preferred_supplier", "preferred_vendor", "首选供应商", "首选供应商编码"] }),
      field("item.category", "Category", "text", { maximumLength: 120, searchable: true, aliases: ["commodity", "category_name", "品类", "分类"] }),
    ],
  },
  customer: {
    schemaId: "customer.v1",
    entityType: "customer",
    version: 1,
    fields: [
      field("customer.code", "Customer Code", "text", { required: true, maximumLength: 64, naturalKey: true, searchable: true, aliases: ["customer_code", "客户编码", "客户代码"] }),
      field("customer.name", "Customer Name", "text", { required: true, maximumLength: 200, searchable: true, aliases: ["customer_name", "客户名称", "客户"] }),
      field("customer.status", "Status", "single_select", { required: true, allowedValues: commonStatus, defaultValue: "active", aliases: statusAliases }),
      field("customer.currency", "Currency", "currency_code", { required: true, defaultValue: "CNY", aliases: currencyAliases }),
      field("customer.paymentTermCode", "Payment Term Code", "text", { maximumLength: 64, aliases: ["payment_terms", "payment_term", "付款条件", "账期"] }),
      field("customer.countryCode", "Country Code", "text", { maximumLength: 2, defaultValue: "CN", aliases: ["country", "country_code", "国家", "国家代码"] }),
    ],
  },
};

for (const schema of Object.values(schemas)) {
  schema.fields = Object.freeze(schema.fields);
  Object.freeze(schema);
}

export const SUPPORTED_INTAKE_RECORD_TYPES = Object.freeze(Object.keys(schemas));
export const canonicalMasterDataSchemas = Object.freeze(schemas);

export function canonicalSchemaFor(recordType) {
  const schema = schemas[String(recordType || "").trim().toLowerCase()];
  if (!schema) {
    const error = new Error("Structured Intake supports supplier, item, and customer records only.");
    error.name = "IntakeError";
    error.code = "INTAKE_RECORD_TYPE_UNSUPPORTED";
    error.status = 422;
    throw error;
  }
  return schema;
}

export function canonicalFieldByPath(recordType, fieldPath) {
  return canonicalSchemaFor(recordType).fields.find(candidate => candidate.fieldPath === fieldPath) || null;
}

export function standardFieldKeys(recordType) {
  return new Set(canonicalSchemaFor(recordType).fields.map(candidate => candidate.fieldPath.split(".").at(-1).toLowerCase()));
}
