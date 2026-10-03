# Phase 5.1 — Authorization, Visibility & Evidence Integrity

FlowChain authorization is now based on system-defined Permission Codes and tenant-owned roles. Display names are never authorization inputs. `User.role` remains only for signed-session compatibility, legacy diagnostics, and deterministic backfill into the six default templates.

## Security boundary

- The code-owned catalog in `server/auth/permission-catalog.mjs` is authoritative. Tenants cannot create or rename Permission Codes.
- Grants, roles, and multi-role assignments are PostgreSQL facts. Effective permissions are the union of active grants from active role assignments and are resolved on every request without a long-lived cache.
- Every decision is tenant-scoped and defaults to deny. Physical commands additionally require explicit `UserWarehouseScope` operate access; read models require read access.
- Capability enablement, workspace module preference, and read permission are intersected. Menu hiding is only presentation; route and API authorization remain independent.
- Sensitive finance amounts, partner snapshots, procurement prices, and audit metadata are redacted by the server. Missing permission produces `null` plus `fieldVisibility`; it never substitutes zero or an empty string.
- AI, exports, and audit summaries must consume the same governed read models. New integrations may not bypass field visibility.

## Default templates and legacy mapping

| Legacy value | Default template |
| --- | --- |
| `admin` | Workspace Administrator |
| `manager` | Operations Manager |
| `business-specialist`, `business_specialist` | Operations Specialist |
| `buyer` | Procurement Specialist |
| `finance-specialist`, `finance_specialist` | Finance Specialist |
| `viewer` or unknown | Read-only Viewer |

Backfill is idempotent, preserves legacy administrator warehouse reach by materializing explicit operate scopes, records an audit event, and fails closed for unknown legacy values.

Backfill runs again whenever a user who never had a role makes a request, for example a colleague who has just accepted an invitation. Template grants are filled into a default role only until an administrator first saves that role, so a code removed from a saved role stays removed. New catalog codes reach existing default roles through a data migration, as `20261002030000_master_data_permissions` does for the master data codes.

Item, supplier and customer writes follow the `master_data.*` codes of a user's role assignments, not `User.role`. Change who maintains master data in Roles & permissions.

## Return reconciliation

Reconciliation is isolated per posting line. It independently verifies movement tenant/source/line/type/item/SKU/unit/warehouse/location/batch/balance identity; quantity direction; balance before/after mathematics; authorization consumption against authorized quantity and workflow status; and one-to-one reversal linkage with exact inverse quantities. Incomplete warehouse scope returns `unavailable` with `PARTIAL_WAREHOUSE_SCOPE`; cross-line netting is never allowed.

## Explicit limitations

Phase 5.1 supports tenant isolation, warehouse read/operate scopes, and creator-only draft visibility where the business object already records `createdBy`. It does not add SSO, SCIM, LDAP, organization trees, arbitrary ABAC expressions, tenant scripts, a generic BPM engine, QuickBooks, payment/collection/refund execution, general ledger, tax, FX, valuation, COGS, lot/serial, barcode, mobile warehouse, or AI-initiated approval/post/reversal.
