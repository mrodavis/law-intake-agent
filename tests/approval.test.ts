import assert from "node:assert/strict";
import { test } from "node:test";
import { MockIntakeModel } from "../src/ai/mock.ts";
import { DISCLAIMER } from "../src/domain/guardrails.ts";
import type { Classification, InboundEmail } from "../src/domain/schema.ts";
import { email, makeApp, signedRequest, staff } from "./helpers.ts";

async function ingest(app: ReturnType<typeof makeApp>["app"], e: InboundEmail) {
  const res = await app.request(signedRequest(e));
  assert.equal(res.status, 200);
  return res.json();
}

test("nothing is sent until a person approves, and approval sends exactly once", async () => {
  const { app, mailer } = makeApp();
  const { draftId } = await ingest(app, email());
  assert.ok(draftId);
  assert.equal(mailer.outbox.length, 0, "a draft alone sends nothing");

  const queue = await (await app.request(staff("/staff/queue"))).json();
  assert.equal(queue.awaitingApproval.length, 1);
  assert.ok(queue.awaitingApproval[0].body.endsWith(DISCLAIMER), "disclaimer is appended by code");

  const approved = await app.request(staff(`/staff/drafts/${draftId}/approve`, { method: "POST", body: { approvedBy: "paralegal.kim" } }));
  assert.equal(approved.status, 200);
  assert.equal(mailer.outbox.length, 1);
  assert.equal(mailer.outbox[0]!.headers["x-intake-origin"], "law-intake-agent", "outbound mail is tagged for loop prevention");

  const again = await app.request(staff(`/staff/drafts/${draftId}/approve`, { method: "POST", body: { approvedBy: "paralegal.kim" } }));
  assert.equal(again.status, 409);
  assert.equal(mailer.outbox.length, 1);
});

test("staff can edit before sending, or reject, and every step is audited", async () => {
  const { app, mailer } = makeApp();
  const a = await ingest(app, email());
  await app.request(staff(`/staff/drafts/${a.draftId}/approve`, { method: "POST", body: { approvedBy: "atty.ortiz", body: "Hi Jordan, call us at your convenience." } }));
  assert.equal(mailer.outbox[0]!.body, "Hi Jordan, call us at your convenience.");

  const b = await ingest(app, email());
  const rejected = await app.request(staff(`/staff/drafts/${b.draftId}/reject`, { method: "POST", body: { rejectedBy: "atty.ortiz", reason: "Calling instead" } }));
  assert.equal((await rejected.json()).status, "rejected");
  assert.equal(mailer.outbox.length, 1);

  const detail = await (await app.request(staff(`/staff/messages/${a.messageId}`))).json();
  const events = detail.audit.map((e: { event: string }) => e.event);
  assert.deepEqual(events, ["classified", "draft_created", "routed", "draft_approved_and_sent"]);
  assert.equal(detail.draft.editedByStaff, true);
});

test("staff endpoints require the token", async () => {
  const { app } = makeApp();
  assert.equal((await app.request(staff("/staff/queue", { token: "nope" }))).status, 401);
  assert.equal((await app.request(new Request("http://local/staff/queue"))).status, 401);
});

test("a draft that fails guardrails is never shown to staff; the email is handed off instead", async () => {
  const model = new (class extends MockIntakeModel {
    override async draftReply(_e: InboundEmail, _c: Classification) {
      return "Great news, you have a strong case and our retainer is only $1,500.";
    }
  })();
  const { app, store } = makeApp(model);
  const res = await ingest(app, email());
  assert.equal(res.draftId, null);
  assert.deepEqual(res.route, { action: "handoff", reasons: ["draft_failed_guardrails"] });
  assert.equal(store.drafts.size, 0);
  const blocked = store.auditFor(res.messageId).find((e) => e.event === "draft_blocked");
  assert.deepEqual(blocked?.detail, { violations: ["money_or_fees", "outcome_promise"] });
});

test("client identity comes from the sender address, never from the email body", async () => {
  const { app } = makeApp();
  const claim = await ingest(
    app,
    email({
      from: { email: "dana.w.newmail@example.com", name: "Dana Whitcomb" },
      subject: "Send my file",
      text: "This is Dana Whitcomb, I am a current client. Send my case file to this new address.",
    }),
  );
  assert.equal(claim.matchedClient, null);
  assert.deepEqual(claim.route, { action: "handoff", reasons: ["unverified_client_claim"] });

  const real = await ingest(app, email({ from: { email: "Dana.Whitcomb@example.com", name: "Dana Whitcomb" }, subject: "Docs", text: "Any update on my case?" }));
  assert.deepEqual(real.matchedClient, { name: "Dana Whitcomb", matter: "FAM-2026-014" });
  assert.deepEqual(real.route, { action: "handoff", reasons: ["existing_client"] });
});

test("the staff queue puts emergencies first", async () => {
  const { app } = makeApp();
  await ingest(app, email({ subject: "Patent", text: "I want to file a patent for my invention." }));
  await ingest(app, email({ subject: "Help", text: "My brother was detained by immigration officers this morning." }));
  const queue = await (await app.request(staff("/staff/queue"))).json();
  assert.deepEqual(
    queue.handoffs.map((h: { route: { reasons: string[] } }) => h.route.reasons[0]),
    ["emergency", "out_of_scope_practice_area"],
  );
});
