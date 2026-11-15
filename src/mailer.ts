import { OWN_OUTBOUND_HEADER } from "./domain/noise.ts";

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  headers: Record<string, string>;
}

export interface Mailer {
  send(msg: Omit<OutboundEmail, "headers">): Promise<void>;
}

/** Collects mail instead of sending it. A real mailer would call your email provider here. */
export class OutboxMailer implements Mailer {
  readonly outbox: OutboundEmail[] = [];

  async send(msg: Omit<OutboundEmail, "headers">): Promise<void> {
    // Tag every outbound message so it can never loop back in as a new lead.
    this.outbox.push({ ...msg, headers: { [OWN_OUTBOUND_HEADER]: "law-intake-agent" } });
  }
}
