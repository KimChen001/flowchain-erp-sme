import {
  buildRuntimeInventoryAllocation,
  getRuntimeSkuAvailability,
} from "../domain/runtime-inventory-allocation-read-model.mjs";
import { readBusinessContext } from "../services/runtime-business-read-service.mjs";
import { authorizeMutation } from "../domain/mutation-authorization.mjs";
import { createInventoryAuthoritativeReadService } from "../domain/inventory-authoritative-read-service.mjs";
import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";
import { reportReadAccess, scopeBusinessContext, sendReadAccessError } from "../domain/report-read-access.mjs";
import { createReorderListReadService } from "../domain/reorder-list-read-service.mjs";
import { readTenantTimezone } from "../domain/tenant-timezone.mjs";
import { tenantCalendarDay } from "../domain/tenant-calendar-day.mjs";

function query(url) {
  return {
    q: url.searchParams.get("q") || "",
    status: url.searchParams.get("status") || "",
    warehouse: url.searchParams.get("warehouse") || "",
    risk: url.searchParams.get("risk") || "",
    limit: url.searchParams.get("limit") || "",
  };
}

function authoritativeQuery(url) {
  return Object.fromEntries(url.searchParams.entries());
}

async function authoritativeService(ctx) {
  const env = ctx.env || process.env;
  if (!ctx.identity?.authenticated) return null;
  const injected = ctx.inventoryPrisma || ctx.outboundPrisma;
  if (!injected && !env.DATABASE_URL) return null;
  const prisma = injected || (await getPrismaClient(env));
  return createInventoryAuthoritativeReadService({ prisma });
}

function inventoryReadRepository(ctx) {
  if (!ctx.repositories?.inventoryRead)
    throw new Error("PostgreSQL inventory repository is not configured.");
  return ctx.repositories.inventoryRead;
}

// The balances, movements and quarantine routes read through the
// authoritative inventory service, which checks permissions and warehouse
// scope itself. Every other inventory read needs inventory.balance.read and
// sees only the reader's warehouses.
const AUTHORITATIVE_READS = new Set(["/api/inventory/balances", "/api/inventory/balances/select", "/api/inventory/movements", "/api/inventory/quarantine-balances", "/api/inventory/quarantine-balances/select"]);

export async function handleInventoryRoute(ctx) {
  const { req, res, url, send } = ctx;
  if (url.pathname.startsWith("/api/inventory") && !ctx.identity?.authenticated) {
    send(res, 401, {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required.",
    });
    return true;
  }
  if (!url.pathname.startsWith("/api/inventory/")) return false;
  let access;
  if (req.method === "GET" && !AUTHORITATIVE_READS.has(url.pathname)) {
    try { access = await reportReadAccess(ctx); } catch (error) { sendReadAccessError(ctx, error); return true; }
    if (!access.collections.inventoryItems) {
      send(res, 403, { code: "PERMISSION_DENIED", message: "Your role cannot view inventory.", details: { permission: "inventory.balance.read" } });
      return true;
    }
  }
  const denied = (permission, message) => { send(res, 403, { code: "PERMISSION_DENIED", message, details: { permission } }); return true; };
  let readRepository;
  const repository = () => (readRepository ||= inventoryReadRepository(ctx));
  const warehouseScope = () => (access?.warehouseIds ? { warehouseIds: access.warehouseIds } : {});
  const scopedQuery = () => ({
    ...query(url),
    tenantId: ctx.identity.tenantId,
    ...warehouseScope(),
  });
  // Stock in the reader's warehouses against every open order's demand.
  const scopedContext = () => readBusinessContext(ctx, { warehouseIds: access?.warehouseIds ?? null });
  let runtimeModel;
  const allocationModel = async () =>
    (runtimeModel ||= buildRuntimeInventoryAllocation(await scopedContext()));

  const allocationPath =
    /^\/api\/inventory\/(?:availability|allocation|shortages|demand-supply-gap|available-to-promise|reservation-preview|sales-order-impact|po-supply-impact)(?:\/.*)?$/.test(
      url.pathname,
    );
  if (allocationPath && req.method !== "GET") {
    send(res, 405, { error: "Method not allowed" });
    return true;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/api/inventory/availability" ||
      url.pathname === "/api/inventory/allocation")
  ) {
    const model = await allocationModel();
    const filters = query(url);
    const availability = model.availability.filter(
      (row) =>
        (!filters.q ||
          JSON.stringify(row)
            .toLowerCase()
            .includes(filters.q.toLowerCase())) &&
        (!filters.risk || row.riskLevel === filters.risk),
    );
    send(res, 200, {
      availability,
      allocation: availability,
      summary: model.summary,
      risks: model.risks,
      evidenceLinks: model.evidenceLinks,
      dataLimitations: model.dataLimitations,
    });
    return true;
  }

  const availabilityMatch = url.pathname.match(
    /^\/api\/inventory\/(?:availability|allocation)\/([^/]+)$/,
  );
  if (req.method === "GET" && availabilityMatch) {
    const model = await allocationModel();
    const availability = getRuntimeSkuAvailability(model, availabilityMatch[1]);
    if (!availability) {
      send(res, 404, { error: "Inventory availability not found" });
      return true;
    }
    send(res, 200, {
      availability,
      allocation: availability,
      summary: {
        skuCount: 1,
        highRiskSkuCount: ["blocked", "high"].includes(availability.riskLevel)
          ? 1
          : 0,
        totalShortageQty: availability.shortage,
        reservedQty: availability.reserved,
        incomingPurchaseQty: availability.incomingApprovedPo,
        atpInsufficientSkuCount:
          availability.availableToPromise !== null &&
          availability.availableToPromise < 0
            ? 1
            : 0,
      },
      risks: ["blocked", "high", "medium"].includes(availability.riskLevel)
        ? [availability]
        : [],
      evidenceLinks: availability.evidence,
      dataLimitations: availability.dataLimitations,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/shortages") {
    const model = await allocationModel();
    const risks = model.risks;
    send(res, 200, {
      risks,
      availability: risks,
      allocation: risks,
      summary: model.summary,
      evidenceLinks: risks.flatMap((item) => item.evidence || []),
      dataLimitations: [
        ...new Set(risks.flatMap((item) => item.dataLimitations || [])),
      ],
    });
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/demand-supply-gap"
  ) {
    const model = await allocationModel();
    const gap = getRuntimeSkuAvailability(
      model,
      url.searchParams.get("sku") || "",
    );
    send(
      res,
      gap ? 200 : 404,
      gap
        ? {
            sku: gap.sku,
            gap,
            availability: gap,
            allocation: gap,
            risks: gap.shortage > 0 ? [gap] : [],
            summary: model.summary,
            dataLimitations: gap.dataLimitations,
          }
        : { error: "Inventory availability not found" },
    );
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/available-to-promise"
  ) {
    const model = await allocationModel();
    const atp = getRuntimeSkuAvailability(
      model,
      url.searchParams.get("sku") || "",
    );
    send(
      res,
      atp ? 200 : 404,
      atp
        ? {
            ...atp,
            availability: atp,
            allocation: atp,
            risks:
              atp.availableToPromise !== null && atp.availableToPromise < 0
                ? [atp]
                : [],
            summary: model.summary,
          }
        : { error: "Inventory availability not found" },
    );
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/reservation-preview"
  ) {
    const model = await allocationModel();
    const availability = getRuntimeSkuAvailability(
      model,
      url.searchParams.get("sku") || "",
    );
    const requestedQty = Number(url.searchParams.get("requestedQty") || 0);
    const reservationPreview = {
      sku: availability?.sku || "",
      salesOrderId: url.searchParams.get("salesOrderId") || "",
      requestedQty,
      reservableQty:
        availability?.available === null || !availability
          ? null
          : Math.min(Math.max(0, requestedQty), availability.available),
      dataLimitations: availability?.dataLimitations || [
        "inventory_balance_missing",
      ],
      evidenceLinks: availability?.evidence || [],
    };
    send(res, 200, {
      reservationPreview,
      availability,
      allocation: availability,
      summary: model.summary,
      risks: [],
      evidenceLinks: reservationPreview.evidenceLinks,
      dataLimitations: reservationPreview.dataLimitations,
    });
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/sales-order-impact"
  ) {
    if (!access.collections.salesOrders) return denied("sales_order.read", "Your role cannot view sales orders.");
    const context = await scopedContext();
    const model = buildRuntimeInventoryAllocation(context);
    const id = url.searchParams.get("salesOrderId") || "";
    const order = scopeBusinessContext(context, access).salesOrders.find(
      (row) => String(row.salesOrderId || row.id) === id,
    );
    const availability = order
      ? getRuntimeSkuAvailability(model, order.sku || order.itemId)
      : null;
    send(
      res,
      order ? 200 : 404,
      order
        ? {
            salesOrder: order,
            availability,
            allocation: availability,
            summary: model.summary,
            risks: availability?.shortage > 0 ? [availability] : [],
            dataLimitations: availability?.dataLimitations || [],
          }
        : { error: "Sales order not found" },
    );
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/po-supply-impact"
  ) {
    if (!access.collections.purchaseOrders) return denied("procurement.purchase_order.read", "Your role cannot view purchase orders.");
    const context = await scopedContext();
    const model = buildRuntimeInventoryAllocation(context);
    const id = url.searchParams.get("poId") || "";
    // Prices on the order follow procurement.prices.read.
    const po = scopeBusinessContext(context, access).purchaseOrders.find(
      (row) => String(row.id || row.po) === id,
    );
    const impactedSkus = po
      ? (po.lines || [])
          .map((line) =>
            getRuntimeSkuAvailability(model, line.sku || line.itemId),
          )
          .filter(Boolean)
      : [];
    send(
      res,
      po ? 200 : 404,
      po
        ? {
            purchaseOrder: po,
            impactedSkus,
            availability: impactedSkus,
            allocation: impactedSkus,
            summary: model.summary,
            risks: impactedSkus.filter((row) => row.shortage > 0),
            dataLimitations: [
              ...new Set(impactedSkus.flatMap((row) => row.dataLimitations)),
            ],
          }
        : { error: "Purchase order not found" },
    );
    return true;
  }

  // The items to reorder, ranked by the day each one's stock position reaches
  // its recorded reorder point (server/domain/reorder-list.mjs). Stock and
  // incoming are the allocation model's over every warehouse; a reader of only
  // some warehouses gets the items as not checked. Purchase order numbers in
  // the flags need procurement.purchase_order.read.
  if (req.method === "GET" && url.pathname === "/api/inventory/reorder-list") {
    const env = ctx.env || process.env;
    const injected = ctx.inventoryPrisma || ctx.outboundPrisma;
    if (!injected && !env.DATABASE_URL) {
      send(res, 409, {
        error: "The reorder list requires database persistence.",
        code: "REORDER_LIST_NOT_AVAILABLE",
      });
      return true;
    }
    const prisma = injected || (await getPrismaClient(env));
    const context = await scopedContext();
    const model = buildRuntimeInventoryAllocation(context);
    const timeZone = await readTenantTimezone(ctx);
    const now = ctx.reorderListNow instanceof Date ? ctx.reorderListNow : new Date();
    const list = await createReorderListReadService({ prisma }).read({
      tenantId: ctx.identity.tenantId,
      warehouseIds: access?.warehouseIds ?? null,
      today: tenantCalendarDay(now, timeZone),
      timeZone,
      allocationRows: model.availability,
      showPurchaseOrders: Boolean(access?.collections.purchaseOrders),
      // The context's subjects the list depends on: stock balances, sales
      // orders (reservations) and purchase orders (incoming). It reads the
      // items and shipments itself and adds its own.
      truncatedSubjects: (context.truncatedSubjects || []).filter((entry) => ["inventory_items", "sales_orders", "purchase_orders"].includes(entry?.subject)),
    });
    send(res, 200, { ...list, generatedAt: now.toISOString() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/items") {
    send(res, 200, { items: await repository().listItems(scopedQuery()) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/inventory/items") {
    const authorization = authorizeMutation(ctx, {
      allowedRoles: ["admin", "manager", "business-specialist"],
      action: "inventory.item.upsert",
      resource: "inventory",
    });
    if (authorization.blocked) return true;
    // No repository writes inventory items directly; balances change through
    // transfers, counts and adjustments in the inventory operations workbench.
    send(res, 501, {
      code: "FLOWCHAIN_CAPABILITY_NOT_IMPLEMENTED",
      message:
        "Legacy inventory item mutation is not available. Use inventory transfers, cycle counts, or adjustments.",
      capability: "inventory",
      limitations: ["legacy_inventory_item_mutation_removed"],
    });
    return true;
  }

  const itemMatch = url.pathname.match(/^\/api\/inventory\/items\/([^/]+)$/);
  if (req.method === "GET" && itemMatch) {
    const item = await repository().getItem(itemMatch[1], {
      tenantId: ctx.identity.tenantId,
      ...warehouseScope(),
    });
    if (!item) {
      send(res, 404, { error: "Inventory item not found" });
      return true;
    }
    send(res, 200, { item });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/lots") {
    send(res, 200, { lots: await repository().listLots(scopedQuery()) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/serials") {
    send(res, 200, { serials: await repository().listSerials(scopedQuery()) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/movements") {
    const service = await authoritativeService(ctx);
    if (service) {
      send(res, 200, await service.listMovements(authoritativeQuery(url), ctx));
      return true;
    }
    send(res, 200, { movements: await repository().listMovements(scopedQuery()) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/balances") {
    const service = await authoritativeService(ctx);
    if (!service) {
      send(res, 409, {
        error:
          "Authoritative inventory balances require database persistence and authentication.",
        code: "AUTHORITATIVE_INVENTORY_READ_NOT_AVAILABLE",
      });
      return true;
    }
    send(res, 200, await service.listBalances(authoritativeQuery(url), ctx));
    return true;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/inventory/balances/select"
  ) {
    const service = await authoritativeService(ctx);
    if (!service) {
      send(res, 409, {
        error:
          "Authoritative inventory balance selection requires database persistence and authentication.",
        code: "AUTHORITATIVE_INVENTORY_READ_NOT_AVAILABLE",
      });
      return true;
    }
    send(
      res,
      200,
      await service.listAvailableBalanceOptions(authoritativeQuery(url), ctx),
    );
    return true;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/api/inventory/quarantine-balances" ||
      url.pathname === "/api/inventory/quarantine-balances/select")
  ) {
    const service = await authoritativeService(ctx);
    if (!service) {
      send(res, 409, {
        error:
          "Authoritative quarantine inventory requires database persistence and authentication.",
        code: "AUTHORITATIVE_QUARANTINE_READ_NOT_AVAILABLE",
      });
      return true;
    }
    const result =
      url.pathname === "/api/inventory/quarantine-balances/select"
        ? await service.listQuarantineBalanceOptions(
            authoritativeQuery(url),
            ctx,
          )
        : await service.listQuarantineBalances(authoritativeQuery(url), ctx);
    send(res, 200, {
      ...result,
      capability: capabilityForEnvironment(
        "quarantine-inventory",
        ctx.env || process.env,
      ),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/exceptions") {
    send(res, 200, { exceptions: await repository().listExceptions(scopedQuery()) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/summary") {
    send(res, 200, { summary: await repository().getSummary({ tenantId: ctx.identity.tenantId, ...warehouseScope() }) });
    return true;
  }

  return false;
}
