# Reporting demo

Run `npm run pilot:setup:reports` with the controlled local development environment after the base demo and scenario setup. It requires the ten `LDS-*` suppliers, six base items, three customers, and the demo warehouse. It refuses remote or production databases.

The additive dataset includes 28 purchase orders, 18 sales orders, 12 linked receipts and draft invoices, six additional items, and opening inventory snapshots for missing demo balances. It spans the current month and five preceding months, using USD and fictional English business names. Two logistics suppliers remain in master data without artificial goods purchases.

Existing records are preserved. Repeating the command does not duplicate records or reset edited records or historical dates. The new batch runs in one transaction. Fixed demo identifiers must not collide with another workspace or non-demo records.

Receipts are recorded but unposted; invoices await review and are not paid or approved. Some invoice prices differ from PO prices for demonstrating review. Opening stock snapshots do not claim to originate from these receipts. Sales include draft, confirmed, and cancelled demand without fabricated shipment or reservation evidence. Monthly charts show recorded order activity, not revenue or growth forecasts.

The database procurement snapshot now supplies actual receipts and invoices to report readers. Open-order metrics exclude fully received, rejected and cancelled orders. Draft and cancelled sales are excluded from open demand and inventory demand calculations.

Stock quantities with different recorded units are not combined into a single on-hand total. SKU-level quantities remain visible. The overview uses readable status labels and expands supplier chart spacing for eight suppliers.
