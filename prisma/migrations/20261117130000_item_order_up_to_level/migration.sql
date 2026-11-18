-- Design audit C3: an item's order-up-to level and lot size for the (s, S)
-- reorder rule (owner: go with the recommendations). Both optional; without
-- an order-up-to level the app assumes the reorder point plus seven days of
-- average demand, and says so.
ALTER TABLE "Item" ADD COLUMN "orderUpToLevel" DECIMAL(18,4);
ALTER TABLE "Item" ADD COLUMN "lotSize" DECIMAL(18,4);
