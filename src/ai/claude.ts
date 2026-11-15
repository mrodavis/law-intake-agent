import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ClassificationSchema, DraftSchema, type Classification, type InboundEmail } from "../domain/schema.ts";
import { renderEmail, type IntakeModel } from "./llm.ts";
import { CLASSIFY_SYSTEM, DRAFT_SYSTEM } from "./prompts.ts";

export class ClaudeIntakeModel implements IntakeModel {
  readonly name = "claude";
  private client: Anthropic;

  constructor(
    readonly model = process.env.INTAKE_MODEL ?? "claude-sonnet-5-5",
    apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  classify(email: InboundEmail): Promise<Classification> {
    return this.callTool({
      system: CLASSIFY_SYSTEM,
      toolName: "record_classification",
      description: "Record the classification of this email.",
      schema: ClassificationSchema,
      content: renderEmail(email),
    });
  }

  async draftReply(email: InboundEmail, c: Classification): Promise<string> {
    const draft = await this.callTool({
      system: DRAFT_SYSTEM,
      toolName: "record_draft",
      description: "Record the reply body.",
      schema: DraftSchema,
      content: `Triage summary (written by our classifier): ${c.summary}\nPractice area: ${c.practiceArea}\n\n${renderEmail(email)}`,
    });
    return draft.body;
  }

  /**
   * Structured output through a forced tool call. The tool's JSON Schema is
   * generated from the zod schema used to validate the result, so they cannot
   * drift, and the model gets one chance to fix invalid output.
   */
  private async callTool<T extends z.ZodType>(args: {
    system: string;
    toolName: string;
    description: string;
    schema: T;
    content: string;
  }): Promise<z.infer<T>> {
    const tool: Anthropic.Tool = {
      name: args.toolName,
      description: args.description,
      input_schema: z.toJSONSchema(args.schema) as Anthropic.Tool.InputSchema,
    };
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: args.content }];

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: args.system,
        tools: [tool],
        tool_choice: { type: "tool", name: args.toolName },
        messages,
      });
      const toolUse = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!toolUse) throw new Error(`Model did not call ${args.toolName}`);
      const parsed = args.schema.safeParse(toolUse.input);
      if (parsed.success) return parsed.data;

      messages.push(
        { role: "assistant", content: res.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              is_error: true,
              content: `Invalid input: ${z.prettifyError(parsed.error)}. Call ${args.toolName} again with corrected values.`,
            },
          ],
        },
      );
    }
    throw new Error(`Model returned invalid ${args.toolName} input twice`);
  }
}
