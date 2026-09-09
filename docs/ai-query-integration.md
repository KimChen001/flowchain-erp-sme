# Conversational supplier query integration

The integration branch ports the three previously local AI commits onto the current main architecture and English interface changes. It retains canonical navigation and handler dispatch.

## First functional slice

Ask which suppliers need payment, inspect the returned supplier sections and evidence, then ask what else needs follow-up for those suppliers. Only suppliers present in the returned sections become follow-up references. PostgreSQL and server-resolved tenant/actor authorization remain authoritative.

The read model applies currency and supported payable-state filters before computing counts. Ranking uses a stable score/order and the requested limit. Unsupported status/grouping filters return clarification before reading, rather than silently broadening the query. Mixed currencies have no combined amount. Receiving queries require access to every referenced warehouse. Unattributed bank exceptions are not assigned to every supplier.

New result copy follows the interface language (English by default, Chinese available), and number formatting follows the existing locale independently. The surrounding older assistant UI still has untranslated strings.

## Validation and remaining release work

Validation covers deterministic planning, endpoint contracts and follow-up scope, real PostgreSQL tenant/warehouse isolation, the bounded provider request, and browser layouts at desktop, tablet, and phone widths. Provider transport tests use controlled servers; no live external model acceptance or customer data evaluation has been run.

Before production rollout, review cross-domain derived facts under combinations of permissions/capability flags, complete currency-grouped exact decimal totals, expand bilingual assistant coverage, and validate a real customer workflow. Query planning is a bounded read workflow, not an autonomous agent loop. Persistent conversation/run history, observability from actual runs, and RFQ reviewed action execution are later slices. PR 26 remains independent and is not implicitly merged by this integration.
