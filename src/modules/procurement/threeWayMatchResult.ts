import { statusToneOf } from "../../components/ui/statusTones.ts";

export type MatchResult = "matched" | "pending" | "variance";

// A three-way match read as one of three results, from its match status (a
// code, or the Chinese label older rows and the database read carry). The
// list's cards and its result filter both use this, so a card's count is the
// rows its link lists (design audit A6).
// - Matched: amounts agree, matched within the workspace's tolerance, or every
//   difference approved ("variance_approved", which the read model also says
//   of an invoice approved before that status was stored). Since design audit
//   B2 a match inside the tolerance keeps its small variance on record.
// - Variances: an exception not yet cleared.
// - Pending: anything else, waiting for a receipt or a review.
// The variance amount alone never decides it: the list shows the amount.
export function matchResultOf(row: { matchStatus?: string | null; status?: string | null }): MatchResult {
  if (row.matchStatus === "variance_approved" || row.status === "variance_approved") return "matched";
  const tone = statusToneOf(row.matchStatus || row.status);
  if (tone === "danger") return "variance";
  return tone === "success" ? "matched" : "pending";
}
