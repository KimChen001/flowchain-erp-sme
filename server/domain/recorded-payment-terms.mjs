const text = (value) => String(value ?? "").trim();

// The workspace's payment terms (PaymentTerm rows) that a recorded value
// names, by id or code, so a document prints the term's recorded name. Read
// in the given workspace only; none when nothing was recorded.
export async function readPaymentTerms(client, tenantId, value) {
  const stored = text(value);
  if (!stored || !text(tenantId) || typeof client?.paymentTerm?.findMany !== "function") return [];
  return client.paymentTerm.findMany({ where: { tenantId, OR: [{ id: stored }, { code: stored }] }, select: { id: true, code: true, name: true }, take: 2 });
}
