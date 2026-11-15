/**
 * Offline eval harness. Runs every fixture email through the real pipeline and
 * reports category accuracy, route accuracy, handoff-reason recall and a
 * confusion matrix. Exits 1 (failing CI) if:
 *   - any email that must go to a person gets an AI draft, or
 *   - a guardrail case is not handled exactly as expected.
 *
 * Uses Claude when ANTHROPIC_API_KEY is set, otherwise the keyword mock.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ClaudeIntakeModel } from "../src/ai/claude.ts";
import type { IntakeModel } from "../src/ai/llm.ts";
import { MockIntakeModel } from "../src/ai/mock.ts";
import { PROMPT_HASH } from "../src/ai/prompts.ts";
import { checkDraft } from "../src/domain/guardrails.ts";
import { CATEGORIES, InboundEmailSchema } from "../src/domain/schema.ts";
import { OutboxMailer } from "../src/mailer.ts";
import { processEmail } from "../src/pipeline.ts";
import { MemoryIntakeStore } from "../src/store.ts";

interface Fixture {
  id: string;
  from: { email: string; name?: string };
  subject: string;
  text: string;
  headers?: Record<string, string>;
  expected: { category: string | null; route: string; reasons?: string[] };
}

const dir = new URL(".", import.meta.url);
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("fixtures.json", dir), "utf8"));
const guardrailCases: { mustBlock: Array<{ text: string; rule: string }>; mustPass: string[] } = JSON.parse(
  readFileSync(new URL("guardrail-cases.json", dir), "utf8"),
);

const useMock = process.argv.includes("--mock") || !process.env.ANTHROPIC_API_KEY;
const model: IntakeModel = useMock ? new MockIntakeModel() : new ClaudeIntakeModel();
const store = new MemoryIntakeStore(undefined);
const deps = { model, store, mailer: new OutboxMailer() };

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);

let categoryHits = 0;
let categoryTotal = 0;
let routeHits = 0;
let reasonHits = 0;
let reasonTotal = 0;
let draftsAttempted = 0;
let draftsBlocked = 0;
const unsafeDrafts: string[] = [];
const misses: string[] = [];
const labels = [...CATEGORIES, "(none)"];
const confusion = new Map<string, Map<string, number>>(labels.map((l) => [l, new Map(labels.map((m) => [m, 0]))]));

for (const [i, f] of fixtures.entries()) {
  const email = InboundEmailSchema.parse({
    messageId: `eval-${i}-${f.id}`,
    threadId: `thread-${f.id}`,
    from: f.from,
    subject: f.subject,
    text: f.text,
    receivedAt: "2026-11-02T14:00:00.000Z",
    headers: f.headers ?? {},
  });
  const r = await processEmail(email, deps);

  const gotCategory = r.classification?.category ?? null;
  if (f.expected.category !== null) {
    categoryTotal++;
    if (gotCategory === f.expected.category) categoryHits++;
    const row = confusion.get(f.expected.category)!;
    const col = gotCategory ?? "(none)";
    row.set(col, (row.get(col) ?? 0) + 1);
  }

  if (r.route.action === "draft" || (r.route.action === "handoff" && r.route.reasons.includes("draft_failed_guardrails"))) draftsAttempted++;
  if (r.route.action === "handoff" && r.route.reasons.includes("draft_failed_guardrails")) draftsBlocked++;

  const routeOk = r.route.action === f.expected.route;
  if (routeOk) routeHits++;
  if (r.draftId && f.expected.route !== "draft") unsafeDrafts.push(f.id);

  const gotReasons = r.route.action === "handoff" ? r.route.reasons : [];
  for (const reason of f.expected.reasons ?? []) {
    reasonTotal++;
    if ((gotReasons as string[]).includes(reason)) reasonHits++;
  }

  if (!routeOk || (f.expected.category !== null && gotCategory !== f.expected.category)) {
    misses.push(`| ${f.id} | ${f.expected.category ?? "-"} / ${f.expected.route} | ${gotCategory ?? "-"} / ${r.route.action}${gotReasons.length ? ` (${gotReasons.join(", ")})` : ""} |`);
  }
}

// Guardrail cases are deterministic: every bad draft must be caught by the rule it targets, every good one must pass.
const guardrailFailures: string[] = [];
for (const c of guardrailCases.mustBlock) {
  const res = checkDraft(c.text);
  if (!res.violations.includes(c.rule)) guardrailFailures.push(`not blocked by ${c.rule}: ${JSON.stringify(c.text)}`);
}
for (const text of guardrailCases.mustPass) {
  const res = checkDraft(text);
  if (!res.ok) guardrailFailures.push(`false positive (${res.violations.join(", ")}): ${JSON.stringify(text.slice(0, 60))}`);
}

const usedLabels = labels.filter((l) => [...confusion.get(l)!.values()].some((v) => v > 0) || [...confusion.values()].some((row) => (row.get(l) ?? 0) > 0));
const matrix = [
  `| expected \\ got | ${usedLabels.join(" | ")} |`,
  `|---|${usedLabels.map(() => "---").join("|")}|`,
  ...usedLabels
    .filter((l) => l !== "(none)")
    .filter((l) => [...confusion.get(l)!.values()].some((v) => v > 0))
    .map((l) => `| ${l} | ${usedLabels.map((m) => confusion.get(l)!.get(m) || "").join(" | ")} |`),
].join("\n");

const report = `# Intake eval report

Model: \`${model.model}\` · prompt hash: \`${PROMPT_HASH}\` · fixtures: ${fixtures.length}
${useMock ? "\n> Mock model. These numbers only show that the harness runs; the mock is tuned to these fixtures. Set ANTHROPIC_API_KEY to measure Claude.\n" : ""}
| Metric | Result |
|---|---|
| Category accuracy | ${pct(categoryHits, categoryTotal)} |
| Route accuracy | ${pct(routeHits, fixtures.length)} |
| Handoff reason recall | ${pct(reasonHits, reasonTotal)} |
| AI drafts blocked by guardrails | ${pct(draftsBlocked, draftsAttempted)} |
| **Must-handoff emails that got an AI draft** | **${unsafeDrafts.length}** ${unsafeDrafts.length ? `(${unsafeDrafts.join(", ")})` : ""} |
| Guardrail cases handled correctly | ${pct(guardrailCases.mustBlock.length + guardrailCases.mustPass.length - guardrailFailures.length, guardrailCases.mustBlock.length + guardrailCases.mustPass.length)} |

## Category confusion matrix

${matrix}

## Misses

${misses.length ? `| Fixture | Expected (category / route) | Got |\n|---|---|---|\n${misses.join("\n")}` : "None."}
${guardrailFailures.length ? `\n## Guardrail failures\n\n${guardrailFailures.map((g) => `- ${g}`).join("\n")}\n` : ""}`;

const out = new URL(`report.${model.name}.md`, dir);
writeFileSync(out, report);
console.log(report);
console.log(`Report written to evals/report.${model.name}.md`);

if (unsafeDrafts.length > 0 || guardrailFailures.length > 0) {
  console.error("EVAL FAILED: an email that must go to a person got an AI draft, or a guardrail case failed.");
  process.exit(1);
}
