import type { Classification, HandoffReason, Route } from "./schema.ts";

export const MIN_CONFIDENCE_FOR_DRAFT = 0.6;

export interface RoutingInput {
  classification: Classification;
  /** True only when the sender ADDRESS belongs to a current client. The email body never proves this. */
  senderIsClient: boolean;
  conflicts: string[];
  injectionHeuristic: boolean;
}

/**
 * Pure routing. The model labels the email; this function decides what happens.
 * Anything risky goes to a person. The AI only drafts a reply for a clean,
 * routine, in-scope new matter, and even then a person approves before it sends.
 */
export function route({ classification: c, senderIsClient, conflicts, injectionHeuristic }: RoutingInput): Route {
  const injection = c.injectionSuspected || injectionHeuristic;
  // Every handoff carries the injection flag, so staff know an email may be an attack even when
  // the classifier was fooled into a different category.
  const handoff = (...reasons: HandoffReason[]): Route => ({ action: "handoff", reasons: injection ? [...reasons, "injection_suspected"] : reasons });

  // A known client address always goes to their legal team, whatever the email looks like.
  if (senderIsClient) return handoff("existing_client");

  switch (c.category) {
    case "spam_or_scam":
      return { action: "discard", reason: "spam_or_scam" };
    case "vendor_or_marketing":
    case "not_legal":
      return { action: "no_action", reason: c.category };
    case "existing_client":
      // Says it is a client but comes from an unknown address: a person must verify.
      return handoff("unverified_client_claim");
    case "court_or_opposing_counsel":
      return handoff("court_or_opposing_counsel");
    case "new_matter":
      break;
  }

  const reasons: HandoffReason[] = [];
  if (conflicts.length > 0) reasons.push("conflict_of_interest");
  if (c.urgency === "emergency") reasons.push("emergency");
  if (c.urgency === "deadline_soon") reasons.push("urgent_deadline");
  if (c.involvesMinor) reasons.push("involves_minor");
  if (c.practiceArea === "other") reasons.push("out_of_scope_practice_area");
  if (c.practiceArea === "none" || c.confidence < MIN_CONFIDENCE_FOR_DRAFT) reasons.push("low_confidence");

  return reasons.length > 0 || injection ? handoff(...reasons) : { action: "draft" };
}
