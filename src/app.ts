import { Hono, type Context } from "hono";
import { z } from "zod";
import { InboundEmailSchema, type InboundEmail } from "./domain/schema.ts";
import { OutboxMailer } from "./mailer.ts";
import { approveDraft, DraftStateError, processEmail, rejectDraft, type PipelineDeps } from "./pipeline.ts";
import type { IntakeRecord } from "./store.ts";
import { DRY_RUN_HEADER, MAX_ATTEMPTS, safeEqual, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./webhook.ts";

export interface AppDeps extends PipelineDeps {
  webhookSecret: string;
  staffToken: string;
}

type Outcome = { status: 200 | 422 | 503; body: Record<string, unknown> };

const ApproveSchema = z.object({ approvedBy: z.string().min(1).max(100), body: z.string().max(5000).optional() });
const RejectSchema = z.object({ rejectedBy: z.string().min(1).max(100), reason: z.string().min(1).max(500) });

/** Lower number = closer to the top of the staff queue. */
function priority(r: IntakeRecord): number {
  if (r.route.action !== "handoff") return 9;
  const reasons = r.route.reasons;
  if (reasons.includes("emergency")) return 0;
  if (reasons.includes("urgent_deadline") || reasons.includes("court_or_opposing_counsel")) return 1;
  if (reasons.includes("existing_client")) return 2;
  return 3;
}

function summary(r: IntakeRecord) {
  return { messageId: r.messageId, route: r.route, draftId: r.draftId, matchedClient: r.matchedClient };
}

export function createApp(deps: AppDeps) {
  const { store } = deps;
  const app = new Hono();
  const inFlight = new Map<string, Promise<Outcome>>();

  /**
   * Status contract with the email provider:
   *   2xx  done (including duplicates), do not resend
   *   4xx  permanent, do not resend (bad signature, bad payload, dead-lettered)
   *   503  temporary, resend later with the same messageId
   */
  async function run(email: InboundEmail): Promise<Outcome> {
    const attempt = (store.attempts.get(email.messageId) ?? 0) + 1;
    store.attempts.set(email.messageId, attempt);
    try {
      const record = await processEmail(email, deps);
      return { status: 200, body: { status: "processed", ...summary(record) } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.audit(email.messageId, "processing_failed", { attempt, error: message });
      if (attempt >= MAX_ATTEMPTS) {
        store.deadLetters.set(email.messageId, { messageId: email.messageId, attempts: attempt, lastError: message, at: new Date().toISOString() });
        store.audit(email.messageId, "dead_lettered", { attempts: attempt });
        return { status: 422, body: { status: "dead_letter", messageId: email.messageId, attempts: attempt } };
      }
      return { status: 503, body: { status: "retry_later", messageId: email.messageId, attempt } };
    }
  }

  app.get("/health", (c) => c.json({ ok: true, model: deps.model.model }));

  app.post("/webhooks/email", async (c) => {
    const rawBody = await c.req.text();
    const verified = verifySignature({
      secret: deps.webhookSecret,
      rawBody,
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
    });
    if (!verified.ok) return c.json({ error: "unauthorized", reason: verified.reason }, 401);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = InboundEmailSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid_payload", issues: z.treeifyError(parsed.error) }, 400);
    const email = parsed.data;

    if (c.req.header(DRY_RUN_HEADER) === "1") {
      try {
        const record = await processEmail(email, deps, { dryRun: true });
        return c.json({ status: "dry_run", ...summary(record), classification: record.classification });
      } catch {
        return c.json({ status: "retry_later" }, 503);
      }
    }

    const dead = store.deadLetters.get(email.messageId);
    if (dead) return c.json({ status: "dead_letter", messageId: dead.messageId, attempts: dead.attempts }, 422);
    const existing = store.records.get(email.messageId);
    if (existing) return c.json({ status: "duplicate", ...summary(existing) });

    // Concurrent deliveries of the same message share one run.
    let pending = inFlight.get(email.messageId);
    if (!pending) {
      pending = run(email);
      inFlight.set(email.messageId, pending);
      void pending.finally(() => inFlight.delete(email.messageId));
    }
    const outcome = await pending;
    if (outcome.status === 503) c.header("Retry-After", "30");
    return c.json(outcome.body, outcome.status);
  });

  // Staff endpoints. In production this is SSO with per-person identity; a shared token keeps the demo small.
  app.use("/staff/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, deps.staffToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/staff/queue", (c) => {
    const awaitingApproval = [...store.drafts.values()].filter((d) => d.status === "awaiting_approval");
    const handoffs = [...store.records.values()]
      .filter((r) => r.route.action === "handoff")
      .sort((a, b) => priority(a) - priority(b) || a.receivedAt.localeCompare(b.receivedAt))
      .map((r) => ({ ...summary(r), from: r.from, subject: r.subject, receivedAt: r.receivedAt, summary: r.classification?.summary ?? null }));
    return c.json({ awaitingApproval, handoffs });
  });

  app.get("/staff/messages/:messageId", (c) => {
    const id = c.req.param("messageId");
    const record = store.records.get(id);
    if (!record) return c.json({ error: "not_found" }, 404);
    const draft = record.draftId ? store.drafts.get(record.draftId) : undefined;
    return c.json({ record, draft: draft ?? null, audit: store.auditFor(id) });
  });

  app.post("/staff/drafts/:id/approve", async (c) => {
    const body = ApproveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: z.treeifyError(body.error) }, 400);
    return handleDraftError(c, async () => c.json(await approveDraft(c.req.param("id"), body.data.approvedBy, body.data.body, deps)));
  });

  app.post("/staff/drafts/:id/reject", async (c) => {
    const body = RejectSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_body", issues: z.treeifyError(body.error) }, 400);
    return handleDraftError(c, async () => c.json(rejectDraft(c.req.param("id"), body.data.rejectedBy, body.data.reason, deps)));
  });

  app.get("/staff/dead-letters", (c) => c.json([...store.deadLetters.values()]));

  if (deps.mailer instanceof OutboxMailer) {
    const outbox = deps.mailer.outbox;
    app.get("/staff/outbox", (c) => c.json(outbox));
  }

  return app;
}

async function handleDraftError(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DraftStateError) {
      return err.message === "not_found" ? c.json({ error: "not_found" }, 404) : c.json({ error: err.message }, 409);
    }
    throw err;
  }
}
