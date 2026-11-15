import type { InboundEmail, Route } from "./schema.ts";

/** Header every email this service sends carries, so our own mail can never loop back in as a lead. */
export const OWN_OUTBOUND_HEADER = "x-intake-origin";

/** Cheap deterministic filter that runs before any model call. */
export function noiseRoute(email: InboundEmail): Extract<Route, { action: "ignore" }> | null {
  const headers = Object.fromEntries(Object.entries(email.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (headers[OWN_OUTBOUND_HEADER]) return { action: "ignore", reason: "own_outbound" };
  if (/^(no-?reply|do-?not-?reply|mailer-daemon)@/i.test(email.from.email)) return { action: "ignore", reason: "no_reply_sender" };
  if (headers["auto-submitted"] && headers["auto-submitted"] !== "no") return { action: "ignore", reason: "auto_reply" };
  if (/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(email.subject)) return { action: "ignore", reason: "auto_reply" };
  return null;
}
