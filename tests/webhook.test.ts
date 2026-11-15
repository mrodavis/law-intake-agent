import assert from "node:assert/strict";
import { test } from "node:test";
import { MockIntakeModel } from "../src/ai/mock.ts";
import { sign, verifySignature } from "../src/webhook.ts";
import { email, FailingModel, makeApp, SECRET, signedRequest } from "./helpers.ts";

const now = 1_800_000_000;

test("signature: valid passes, tampered and stale fail", () => {
  const raw = '{"hello":"world"}';
  const ts = String(now);
  const signature = sign(SECRET, ts, raw);
  assert.deepEqual(verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature, nowSeconds: now }), { ok: true });
  assert.deepEqual(verifySignature({ secret: SECRET, rawBody: raw + " ", timestamp: ts, signature, nowSeconds: now }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifySignature({ secret: "wrong", rawBody: raw, timestamp: ts, signature, nowSeconds: now }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifySignature({ secret: SECRET, rawBody: raw, timestamp: ts, signature, nowSeconds: now + 301 }), { ok: false, reason: "stale_timestamp" });
  assert.deepEqual(verifySignature({ secret: SECRET, rawBody: raw, timestamp: undefined, signature, nowSeconds: now }), { ok: false, reason: "missing_headers" });
});

test("webhook rejects a tampered body with 401 and a bad payload with 400", async () => {
  const { app, store } = makeApp();
  const tampered = await app.request(signedRequest(email(), { tamper: true }));
  assert.equal(tampered.status, 401);

  const bad = await app.request(signedRequest({ messageId: "x" }));
  assert.equal(bad.status, 400);
  assert.equal(store.records.size, 0);
});

test("duplicate delivery returns the stored result without reprocessing", async () => {
  let classifyCalls = 0;
  const model = new (class extends MockIntakeModel {
    override async classify(e: Parameters<MockIntakeModel["classify"]>[0]) {
      classifyCalls++;
      return super.classify(e);
    }
  })();
  const { app, store } = makeApp(model);
  const e = email();

  const first = await app.request(signedRequest(e));
  assert.equal(first.status, 200);
  const second = await app.request(signedRequest(e));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, "duplicate");
  assert.equal(classifyCalls, 1);
  assert.equal(store.drafts.size, 1, "only one draft for one message");
});

test("concurrent deliveries of the same message share one run", async () => {
  let classifyCalls = 0;
  const model = new (class extends MockIntakeModel {
    override async classify(e: Parameters<MockIntakeModel["classify"]>[0]) {
      classifyCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return super.classify(e);
    }
  })();
  const { app } = makeApp(model);
  const e = email();
  const [a, b] = await Promise.all([app.request(signedRequest(e)), app.request(signedRequest(e))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(classifyCalls, 1);
});

test("model failure answers 503 with Retry-After, then dead-letters on the third attempt", async () => {
  const model = new FailingModel();
  const { app, store } = makeApp(model);
  const e = email();

  const r1 = await app.request(signedRequest(e));
  assert.equal(r1.status, 503);
  assert.equal(r1.headers.get("retry-after"), "30");
  assert.equal((await app.request(signedRequest(e))).status, 503);

  const r3 = await app.request(signedRequest(e));
  assert.equal(r3.status, 422);
  assert.equal((await r3.json()).status, "dead_letter");
  assert.ok(store.deadLetters.has(e.messageId));

  // Later deliveries are answered 422 immediately, without calling the model again.
  const r4 = await app.request(signedRequest(e));
  assert.equal(r4.status, 422);
  assert.equal(model.calls, 3);
});

test("dry run classifies and routes but writes nothing", async () => {
  const { app, store, mailer } = makeApp();
  const res = await app.request(signedRequest(email(), { dryRun: true }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "dry_run");
  assert.equal(body.route.action, "draft");
  assert.equal(body.draftId, null, "no draft is generated in a dry run");
  assert.equal(store.records.size, 0);
  assert.equal(store.drafts.size, 0);
  assert.equal(store.auditLog.length, 0);
  assert.equal(mailer.outbox.length, 0);
});

test("auto-replies and our own outbound mail are ignored without a model call", async () => {
  const model = new FailingModel();
  const { app } = makeApp(model);
  const auto = await app.request(signedRequest(email({ subject: "Automatic reply: Out of office", headers: { "Auto-Submitted": "auto-replied" } })));
  const own = await app.request(signedRequest(email({ headers: { "X-Intake-Origin": "law-intake-agent" } })));
  assert.equal((await auto.json()).route.action, "ignore");
  assert.equal((await own.json()).route.action, "ignore");
  assert.equal(model.calls, 0);
});
