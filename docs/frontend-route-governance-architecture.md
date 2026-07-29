# Frontend Route Governance Architecture

FlowChain's near-term product surface is an AI-native procurement and inventory
operating system for SMEs. One typed route manifest owns route classification,
navigation visibility, canonical ownership, declared capability and permission
dependencies, and direct-access behavior. Filesystem discovery is intentionally
not used.

## Standalone SME Mode

FlowChain is directly usable without SAP, Odoo, Kingdee, or another ERP. For
each business object, PostgreSQL-backed FlowChain repositories are the single
authoritative system unless the route explicitly declares another provenance.
The always-available navigation focuses on Today, Procurement, Receiving,
Inventory, Suppliers, Items, and AI. Universal Intake and Review Queue join
the primary navigation only when their explicit preview capabilities are
enabled.

## Connected Enterprise Mode

Connected Enterprise Mode is a compatibility boundary, not an implementation
in this change. A future connector may read from or propose a mutation to an
external authoritative system, but it must declare provenance and must not
create a second silent authority for the same business object.

## Authority and mutation rules

- One authoritative system is selected per business object and operation.
- Capability metadata controls product availability; it does not grant
  permission.
- Permission metadata documents expected access; runtime API authorization
  remains mandatory.
- External mutations are review-first. AI and connector suggestions remain
  drafts until an authorized user confirms the formal business operation.
- Frozen and internal surfaces are excluded from normal SME navigation.
- Legacy entries have explicit canonical replacements and never redirect to an
  unrelated page.

## Future connector boundary

Future SAP, Odoo, Kingdee, accounting, messaging, or commerce connectors belong
behind explicit adapters with tenant scope, provenance, idempotency, review,
audit, and failure semantics. This route-governance change adds no connector,
schema, migration, or external mutation behavior.
