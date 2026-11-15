import { FIRM } from "./firm.ts";

/**
 * Deterministic checks on AI-written reply text. Staff never see a draft that
 * fails these: the email is handed off to a person instead. These rules are
 * deliberately blunt. A false positive costs a staff member a minute; a false
 * negative could quote a fee, promise an outcome or give legal advice.
 */
const RULES: Array<{ id: string; re: RegExp }> = [
  { id: "money_or_fees", re: /\$\s?\d|\b\d[\d,]*\s?(dollars|usd)\b|\b\d{1,2}\s?%|\b(retainer|contingency|flat fee|hourly rate|free consultation|no fee|fees?)\b/i },
  { id: "outcome_promise", re: /\b(guarantee[ds]?|promise[ds]?|you will (win|receive|get|recover)|win your case|strong case|you have a (good |great |strong )?case|definitely|certainly)\b/i },
  { id: "legal_advice", re: /\b(you should (sue|file|sign|not sign|plead|settle|accept|reject)|(i|we) (advise|recommend that you)|you are entitled|you have (a|the) right to|statute of limitations (is|has|will)|do not (talk|speak) to (the )?(police|insurance))\b/i },
  { id: "attorney_relationship", re: /\b(we (will|can) represent you|we are your (lawyers?|attorneys?)|you are now (a|our) client)\b/i },
  { id: "dashes", re: /[\u2013\u2014]/ },
];

export interface GuardrailResult {
  ok: boolean;
  violations: string[];
}

export function checkDraft(body: string): GuardrailResult {
  const violations = RULES.filter((r) => r.re.test(body)).map((r) => r.id);
  return { ok: violations.length === 0, violations };
}

export const SIGNATURE = `Intake Team\n${FIRM.name}\n${FIRM.phone}`;

export const DISCLAIMER =
  `This message was prepared by the intake team at ${FIRM.name}. It is general information, not legal advice, ` +
  "and no attorney-client relationship exists until a signed engagement letter is in place. " +
  "Please do not send confidential details by email until we have spoken.";

/** Signature and disclaimer are added by code, never written by the model. */
export function finalizeDraft(modelBody: string): string {
  return `${modelBody.trim()}\n\n${SIGNATURE}\n\n${DISCLAIMER}`;
}
