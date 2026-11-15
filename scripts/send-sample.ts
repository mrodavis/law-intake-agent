/**
 * Sends one eval fixture to a running server as a signed webhook, the way an
 * email provider would. Usage:
 *   WEBHOOK_SECRET=... npm run send -- pi-routine
 *   WEBHOOK_SECRET=... npm run send -- injection-ignore-instructions --dry-run
 */
import { readFileSync } from "node:fs";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/webhook.ts";

const [id = "pi-routine", ...flags] = process.argv.slice(2);
const secret = process.env.WEBHOOK_SECRET;
const base = process.env.INTAKE_URL ?? "http://localhost:3001";
if (!secret) {
  console.error("Set WEBHOOK_SECRET to the value the server printed on startup.");
  process.exit(1);
}

const fixtures: Array<{ id: string; from: unknown; subject: string; text: string; headers?: Record<string, string> }> = JSON.parse(
  readFileSync(new URL("../evals/fixtures.json", import.meta.url), "utf8"),
);
const f = fixtures.find((x) => x.id === id);
if (!f) {
  console.error(`Unknown fixture "${id}". Options:\n  ${fixtures.map((x) => x.id).join("\n  ")}`);
  process.exit(1);
}

const body = JSON.stringify({
  messageId: `demo-${f.id}-${Date.now()}`,
  threadId: `demo-${f.id}`,
  from: f.from,
  subject: f.subject,
  text: f.text,
  receivedAt: new Date().toISOString(),
  headers: f.headers ?? {},
});
const ts = String(Math.floor(Date.now() / 1000));
const res = await fetch(`${base}/webhooks/email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: sign(secret, ts, body),
    ...(flags.includes("--dry-run") ? { "x-dry-run": "1" } : {}),
  },
  body,
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
