import {
  buildRuntimeInventoryAllocation,
  getRuntimeSkuAvailability,
} from "../domain/runtime-inventory-allocation-read-model.mjs";
import { readBusinessContext } from "../services/runtime-business-read-service.mjs";
import { authorizeMutation } from "../domain/mutation-authorization.mjs";
import { createInventoryAuthoritativeReadService } from "../domain/inventory-authoritative-read-service.mjs";
import { capabilityForEnvironment } from "../domain/capability-registry.mjs";
import { getPrismaClient } from "../persistence/prisma-client.mjs";

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
  const prisma =
    ctx.inventoryPrisma || ctx.outboundPrisma || (await getPrismaClient(env));
  return createInventoryAuthoritativeReadService({ prisma });
}

function inventoryReadRepository(ctx) {
  if (!ctx.repositories?.inventoryRead)
    throw new Error("PostgreSQL inventory repository is not configured.");
  return ctx.repositories.inventoryRead;
}

export async function handleInventoryRoute(ctx) {
  const { req, res, url, send } = ctx;
  let readRepository;
  const repository = () => (readRepository ||= inventoryReadRepository(ctx));
  let runtimeModel;
  const allocationModel = async () =>
    (runtimeModel ||= buildRuntimeInventoryAllocation(
      await readBusinessContext(ctx),
    ));

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
    const context = await readBusinessContext(ctx);
    const model = buildRuntimeInventoryAllocation(context);
    const id = url.searchParams.get("salesOrderId") || "";
    const order = context.salesOrders.find(
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
    const context = await readBusinessContext(ctx);
    const model = buildRuntimeInventoryAllocation(context);
    const id = url.searchParams.get("poId") || "";
    const po = context.purchaseOrders.find(
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

  if (req.method === "GET" && url.pathname === "/api/inventory/items") {
    send(res, 200, { items: await repository().listItems(query(url)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/inventory/items") {
    const authorization = authorizeMutation(ctx, {
      allowedRoles: ["admin", "manager", "business-specialist"],
      action: "inventory.item.upsert",
      resource: "inventory",
    });
    if (authorization.blocked) return true;
    try {
      const item = await repository().upsertItem(
        await ctx.readBody(req),
        authorization.identity.userId,
      );
      send(res, 201, { item });
    } catch (error) {
      send(res, error.status || 400, {
        error: error.message,
        code: error.code,
      });
    }
    return true;
  }

  const itemMatch = url.pathname.match(/^\/api\/inventory\/items\/([^/]+)$/);
  if (req.method === "GET" && itemMatch) {
    const item = await repository().getItem(itemMatch[1]);
    if (!item) {
      send(res, 404, { error: "Inventory item not found" });
      return true;
    }
    send(res, 200, { item });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/lots") {
    send(res, 200, { lots: await repository().listLots(query(url)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/serials") {
    send(res, 200, { serials: await repository().listSerials(query(url)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/movements") {
    const service = await authoritativeService(ctx);
    if (service) {
      send(res, 200, await service.listMovements(authoritativeQuery(url), ctx));
      return true;
    }
    send(res, 200, { movements: await repository().listMovements(query(url)) });
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
    send(res, 200, { exceptions: await repository().listExceptions(query(url)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/summary") {
    send(res, 200, { summary: await repository().getSummary() });
    return true;
  }

  return false;
}
