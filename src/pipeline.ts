import { randomUUID } from "node:crypto";
import type { IntakeModel } from "./ai/llm.ts";
import { PROMPT_HASH } from "./ai/prompts.ts";
import { checkConflicts } from "./domain/conflicts.ts";
import { ADVERSE_PARTIES, CLIENTS } from "./domain/firm.ts";
import { checkDraft, finalizeDraft } from "./domain/guardrails.ts";
import { looksLikeInjection } from "./domain/injection.ts";
import { noiseRoute } from "./domain/noise.ts";
import { route as decideRoute } from "./domain/routing.ts";
import type { InboundEmail, Route } from "./domain/schema.ts";
import type { Mailer } from "./mailer.ts";
import type { DraftRecord, IntakeRecord, MemoryIntakeStore } from "./store.ts";

export interface FirmData {
  clients: Array<{ name: string; email: string; matter: string }>;
  adverse: string[];
}

export interface PipelineDeps {
  model: IntakeModel;
  store: MemoryIntakeStore;
  mailer: Mailer;
  firm?: FirmData;
}

const DEFAULT_FIRM: FirmData = { clients: CLIENTS, adverse: ADVERSE_PARTIES };

/**
 * One inbound email, start to finish. Throws if the model fails, so the
 * webhook can answer 503 and the sender retries. With dryRun the decision is
 * computed and returned, but nothing is stored, drafted or sent.
 */
export async function processEmail(email: InboundEmail, deps: PipelineDeps, opts: { dryRun?: boolean } = {}): Promise<IntakeRecord> {
  const { model, store } = deps;
  const firm = deps.firm ?? DEFAULT_FIRM;
  const audit = (event: string, detail?: Record<string, unknown>) => {
    if (!opts.dryRun) store.audit(email.messageId, event, detail);
  };

  const base = {
    messageId: email.messageId,
    threadId: email.threadId,
    receivedAt: email.receivedAt,
    from: email.from,
    subject: email.subject,
  };

  // 1. Cheap deterministic noise filter before spending a model call.
  const noise = noiseRoute(email);
  if (noise) {
    const record: IntakeRecord = {
      ...base,
      processedAt: new Date().toISOString(),
      model: null,
      promptHash: null,
      classification: null,
      matchedClient: null,
      conflicts: [],
      injection: { model: false, heuristic: false },
      route: noise,
      draftId: null,
    };
    audit("ignored", { reason: noise.reason });
    if (!opts.dryRun) store.records.set(email.messageId, record);
    return record;
  }

  // 2. The model labels the email.
  const classification = await model.classify(email);
  audit("classified", { category: classification.category, practiceArea: classification.practiceArea, urgency: classification.urgency, confidence: classification.confidence });

  // 3. Deterministic checks. Client identity comes from the sender address only.
  const client = firm.clients.find((c) => c.email.toLowerCase() === email.from.email.toLowerCase()) ?? null;
  const conflicts = checkConflicts(classification.partiesMentioned, firm);
  const injectionHeuristic = looksLikeInjection(`${email.subject}\n${email.text}`);
  if (conflicts.length) audit("conflict_detected", { conflicts });
  if (injectionHeuristic || classification.injectionSuspected) audit("injection_suspected", { model: classification.injectionSuspected, heuristic: injectionHeuristic });

  // 4. Pure routing.
  let route: Route = decideRoute({ classification, senderIsClient: client !== null, conflicts, injectionHeuristic });
  let draftId: string | null = null;

  // 5. Draft only when routing allows it, and only after the draft passes guardrails.
  if (route.action === "draft" && !opts.dryRun) {
    const body = await model.draftReply(email, classification);
    const guard = checkDraft(body);
    if (!guard.ok) {
      audit("draft_blocked", { violations: guard.violations });
      route = { action: "handoff", reasons: ["draft_failed_guardrails"] };
    } else {
      const draft: DraftRecord = {
        id: randomUUID(),
        messageId: email.messageId,
        to: email.from.email,
        subject: email.subject.toLowerCase().startsWith("re:") ? email.subject : `Re: ${email.subject}`,
        body: finalizeDraft(body),
        status: "awaiting_approval",
        createdAt: new Date().toISOString(),
      };
      store.drafts.set(draft.id, draft);
      draftId = draft.id;
      audit("draft_created", { draftId });
    }
  }

  const record: IntakeRecord = {
    ...base,
    processedAt: new Date().toISOString(),
    model: model.model,
    promptHash: PROMPT_HASH,
    classification,
    matchedClient: client ? { name: client.name, matter: client.matter } : null,
    conflicts,
    injection: { model: classification.injectionSuspected, heuristic: injectionHeuristic },
    route,
    draftId,
  };
  audit("routed", { route });
  if (!opts.dryRun) store.records.set(email.messageId, record);
  return record;
}

export class DraftStateError extends Error {}

/** A person approves (optionally edits) a draft. This is the only path to sending. */
export async function approveDraft(draftId: string, by: string, editedBody: string | undefined, deps: PipelineDeps): Promise<DraftRecord> {
  const draft = deps.store.drafts.get(draftId);
  if (!draft) throw new DraftStateError("not_found");
  if (draft.status !== "awaiting_approval") throw new DraftStateError(`already_${draft.status}`);

  // Staff edits are sent as written: the person approving is the final check on their own words.
  const body = editedBody?.trim() ? editedBody.trim() : draft.body;
  await deps.mailer.send({ to: draft.to, subject: draft.subject, body, inReplyTo: draft.messageId });

  Object.assign(draft, { body, status: "sent", decidedAt: new Date().toISOString(), decidedBy: by, editedByStaff: body !== draft.body });
  deps.store.audit(draft.messageId, "draft_approved_and_sent", { draftId, by, editedByStaff: draft.editedByStaff });
  return draft;
}

export function rejectDraft(draftId: string, by: string, reason: string, deps: PipelineDeps): DraftRecord {
  const draft = deps.store.drafts.get(draftId);
  if (!draft) throw new DraftStateError("not_found");
  if (draft.status !== "awaiting_approval") throw new DraftStateError(`already_${draft.status}`);
  Object.assign(draft, { status: "rejected", decidedAt: new Date().toISOString(), decidedBy: by, rejectReason: reason });
  deps.store.audit(draft.messageId, "draft_rejected", { draftId, by, reason });
  return draft;
}
