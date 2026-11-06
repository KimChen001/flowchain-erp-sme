-- Opening stock and found stock lines may name an item, warehouse and location
-- that has no stock record yet. Posting creates the record and fills the id.
ALTER TABLE "InventoryAdjustmentLine" ALTER COLUMN "inventoryBalanceId" DROP NOT NULL;
