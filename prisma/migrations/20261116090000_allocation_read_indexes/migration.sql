-- Indexes for reads that grow with a workspace's history (design audit
-- 2026-11-15, L12-21).
--
-- A workspace's stock movements in the order they happened.
CREATE INDEX "InventoryMovement_tenantId_occurredAt_idx" ON "InventoryMovement"("tenantId", "occurredAt");

-- Posted shipments in a date window: the reorder list's demand history reads
-- up to two years of them. The new index starts with the columns of the one it
-- replaces, so reads by status alone still use it.
DROP INDEX "ShipmentDocument_tenantId_postingStatus_idx";
CREATE INDEX "ShipmentDocument_tenantId_postingStatus_postedAt_idx" ON "ShipmentDocument"("tenantId", "postingStatus", "postedAt");

-- Purchase order lines of an item. A line has no tenant column of its own:
-- its workspace is its order's. With the order id beside the item id, the
-- index alone gives an item's orders, which are then checked against the
-- workspace on PurchaseOrder's primary key without reading the lines. It
-- replaces the item id index, which it starts with.
DROP INDEX "PurchaseOrderLine_itemId_idx";
CREATE INDEX "PurchaseOrderLine_itemId_purchaseOrderId_idx" ON "PurchaseOrderLine"("itemId", "purchaseOrderId");
