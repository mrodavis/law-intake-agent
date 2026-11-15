import { createApp } from "../src/app.ts";
import type { IntakeModel } from "../src/ai/llm.ts";
import { MockIntakeModel } from "../src/ai/mock.ts";
import type { InboundEmail } from "../src/domain/schema.ts";
import { OutboxMailer } from "../src/mailer.ts";
import { MemoryIntakeStore } from "../src/store.ts";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/webhook.ts";

export const SECRET = "test-webhook-secret";
export const STAFF = "test-staff-token";

export function makeApp(model: IntakeModel = new MockIntakeModel()) {
  const store = new MemoryIntakeStore(undefined);
  const mailer = new OutboxMailer();
  const app = createApp({ model, store, mailer, webhookSecret: SECRET, staffToken: STAFF });
  return { app, store, mailer };
}

let counter = 0;
export function email(overrides: Partial<InboundEmail> = {}): InboundEmail {
  counter++;
  return {
    messageId: `msg-${counter}`,
    threadId: `thread-${counter}`,
    from: { email: "jordan.lee@example.com", name: "Jordan Lee" },
    subject: "Car accident question",
    text: "I was rear-ended at a red light last month and my neck is sore. Can someone talk to me?",
    receivedAt: "2026-11-02T14:00:00.000Z",
    headers: {},
    ...overrides,
  };
}

export function signedRequest(body: unknown, opts: { secret?: string; timestamp?: number; dryRun?: boolean; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: sign(opts.secret ?? SECRET, ts, raw),
  };
  if (opts.dryRun) headers["x-dry-run"] = "1";
  return new Request("http://local/webhooks/email", { method: "POST", headers, body: opts.tamper ? raw.replace("neck", "back") : raw });
}

export function staff(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return new Request(`http://local${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.token ?? STAFF}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** A model that always fails, to exercise retries and dead-lettering. */
export class FailingModel extends MockIntakeModel {
  calls = 0;
  override async classify(): Promise<never> {
    this.calls++;
    throw new Error("upstream model unavailable");
  }
}
