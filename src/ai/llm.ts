import type { Classification, InboundEmail } from "../domain/schema.ts";

/** Everything the pipeline needs from a model. Swappable for tests, evals and offline demos. */
export interface IntakeModel {
  readonly name: string;
  readonly model: string;
  classify(email: InboundEmail): Promise<Classification>;
  /** Body text only. Code adds the subject, signature and disclaimer. */
  draftReply(email: InboundEmail, classification: Classification): Promise<string>;
}

/** Wraps untrusted email so the prompt can refer to it unambiguously. */
export function renderEmail(email: InboundEmail): string {
  const strip = (s: string) => s.replace(/<\/?email>/gi, "");
  return [
    "<email>",
    `From: ${strip(email.from.name ?? "")} <${email.from.email}>`,
    `Subject: ${strip(email.subject)}`,
    "",
    strip(email.text),
    "</email>",
  ].join("\n");
}
