# Canonical Master Data Schemas v1

The code-owned registry is the single source for mapping targets, validation,
normalized preview payloads, review labels, alias suggestions, and future
master-data command contracts.

Every field defines a stable `fieldPath`, label, data type, required flag,
maximum length, allowed values, default, natural-key flag, sensitivity,
searchability, description, and English/Chinese aliases.

## `supplier.v1`

`supplier.code`, `supplier.name`, `supplier.status`, `supplier.currency`,
`supplier.paymentTermCode`, `supplier.contactName`, `supplier.email`,
`supplier.phone`, and `supplier.countryCode`.

`supplier.code` is the natural key. Status defaults to `active`, currency to
`CNY`, and country to `CN`.

## `item.v1`

`item.sku`, `item.name`, `item.unit`, `item.status`,
`item.preferredSupplierCode`, and `item.category`.

`item.sku` is the natural key. Status defaults to `active`.

## `customer.v1`

`customer.code`, `customer.name`, `customer.status`, `customer.currency`,
`customer.paymentTermCode`, and `customer.countryCode`.

`customer.code` is the natural key. Status defaults to `active`, currency to
`CNY`, and country to `CN`.

## Compatibility

Schema identifiers and versions are persisted in every batch snapshot and
mapping profile. Stable paths must not be renamed in place. A breaking schema
change requires a new version and an explicit migration/compatibility policy.
Tenant custom fields extend these schemas; they do not modify the registry or
create tenant-specific core fields.
