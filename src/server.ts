import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ClaudeIntakeModel } from "./ai/claude.ts";
import type { IntakeModel } from "./ai/llm.ts";
import { MockIntakeModel } from "./ai/mock.ts";
import { OutboxMailer } from "./mailer.ts";
import { MemoryIntakeStore } from "./store.ts";

const model: IntakeModel = process.env.ANTHROPIC_API_KEY ? new ClaudeIntakeModel() : new MockIntakeModel();

// Generate throwaway secrets for local runs so nobody is tempted to commit real ones.
const webhookSecret = process.env.WEBHOOK_SECRET ?? randomBytes(24).toString("hex");
const staffToken = process.env.STAFF_TOKEN ?? randomBytes(24).toString("hex");

const app = createApp({ model, store: new MemoryIntakeStore(), mailer: new OutboxMailer(), webhookSecret, staffToken });
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  console.log(`law-intake-agent listening on http://localhost:${port} (model: ${model.model})`);
  if (!process.env.WEBHOOK_SECRET) console.log(`WEBHOOK_SECRET not set, using this one for this run: ${webhookSecret}`);
  if (!process.env.STAFF_TOKEN) console.log(`STAFF_TOKEN not set, using this one for this run: ${staffToken}`);
  if (model.name === "mock") console.log("No ANTHROPIC_API_KEY set: using the offline keyword mock.");
});
