export type ForecastProcurementFacts = {
  sku: string;
  supplier?: string;
  unitPrice?: number;
  buyer?: string;
};

export function forecastProcurementProfileForSku(sku: string, facts: ForecastProcurementFacts[]) {
  const match = facts.find((entry) => entry.sku === sku);
  return {
    supplier: match?.supplier || "",
    unitPrice: Number(match?.unitPrice || 0),
    buyer: match?.buyer || "",
  };
}
