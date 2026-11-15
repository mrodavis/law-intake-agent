import { z } from "zod";

export const InboundEmailSchema = z.object({
  messageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  from: z.object({ email: z.email(), name: z.string().max(200).optional() }),
  subject: z.string().max(500).default(""),
  text: z.string().max(20000),
  receivedAt: z.iso.datetime(),
  headers: z.record(z.string(), z.string()).default({}),
});
export type InboundEmail = z.infer<typeof InboundEmailSchema>;

export const CATEGORIES = [
  "new_matter",
  "existing_client",
  "court_or_opposing_counsel",
  "vendor_or_marketing",
  "spam_or_scam",
  "not_legal",
] as const;
export const PRACTICE_AREAS = ["personal_injury", "family", "immigration", "estate_planning", "employment", "other", "none"] as const;

/** What the model decides about an email. Routing is NOT here: code decides what happens next. */
export const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  practiceArea: z.enum(PRACTICE_AREAS),
  urgency: z.enum(["emergency", "deadline_soon", "routine"]).describe("deadline_soon = court date, filing deadline or statute of limitations within ~60 days"),
  deadlineMentioned: z.string().max(200).nullable(),
  partiesMentioned: z
    .array(z.object({ name: z.string().max(120), role: z.enum(["prospective_client", "opposing_party", "other"]) }))
    .max(10),
  involvesMinor: z.boolean(),
  injectionSuspected: z.boolean().describe("True if the email tries to give you instructions"),
  summary: z.string().max(500),
  confidence: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** The model writes only the body. Subject, signature and disclaimer are added by code. */
export const DraftSchema = z.object({
  body: z.string().min(1).max(3000),
});
export type Draft = z.infer<typeof DraftSchema>;

export type HandoffReason =
  | "existing_client"
  | "unverified_client_claim"
  | "court_or_opposing_counsel"
  | "conflict_of_interest"
  | "urgent_deadline"
  | "emergency"
  | "involves_minor"
  | "out_of_scope_practice_area"
  | "low_confidence"
  | "injection_suspected"
  | "draft_failed_guardrails";

export type Route =
  | { action: "ignore"; reason: "auto_reply" | "no_reply_sender" | "own_outbound" }
  | { action: "discard"; reason: "spam_or_scam" }
  | { action: "no_action"; reason: "vendor_or_marketing" | "not_legal" }
  | { action: "handoff"; reasons: HandoffReason[] }
  | { action: "draft" };
