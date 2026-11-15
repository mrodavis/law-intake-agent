import type { Classification, InboundEmail } from "../domain/schema.ts";
import type { IntakeModel } from "./llm.ts";

/**
 * Offline keyword stand-in for the model, so tests, CI and the eval harness run
 * without an API key. It is tuned to the eval fixtures, so its scores only show
 * that the harness works. Run the eval with ANTHROPIC_API_KEY set to measure Claude.
 */
const CATEGORY_RULES: Array<{ category: Classification["category"]; re: RegExp }> = [
  { category: "spam_or_scam", re: /\b(inherit(ed|ance)|wire transfer|bank details|verify your (password|account)|mailbox is full|crypto|gift cards?)\b/i },
  { category: "vendor_or_marketing", re: /\b(seo|rankings?|leads for (your|law) firm|marketing (agency|services)|webinar|software demo|unsubscribe)\b/i },
  { category: "court_or_opposing_counsel", re: /\b(case no\.?|index no\.?|docket|notice of (hearing|motion)|clerk of|we represent|counsel for|on behalf of our client)\b/i },
  { category: "existing_client", re: /\b(current client|existing client|my case file|update on my case|my attorney at your firm)\b/i },
  { category: "not_legal", re: /\b(parking|directions to your office|internship|job opening|validate)\b/i },
];

const PRACTICE_RULES: Array<{ area: Classification["practiceArea"]; re: RegExp }> = [
  { area: "other", re: /\b(patent|trademark|bankruptcy|tax audit|criminal charge|dui|securities)\b/i },
  { area: "immigration", re: /\b(green card|visa|uscis|asylum|ice|deport\w*|citizenship|naturali[sz]ation)\b/i },
  { area: "employment", re: /\b(fired|let go|terminat\w+|wrongful|harass\w*|eeoc|overtime|employer|hr)\b/i },
  { area: "family", re: /\b(divorce|custody|separat\w+|child support|alimony|prenup)\b/i },
  { area: "estate_planning", re: /\b(a will|my will|last will|living will|trust|probate|estate plan\w*|power of attorney|executor)\b/i },
  { area: "personal_injury", re: /\b(accident|rear-ended|injur\w+|hurt|slip(ped)?|fell|hit by|crash)\b/i },
];

const EMERGENCY = /\b(detained|arrested|being evicted today|picked up by ice|emergency)\b/i;
const DEADLINE = /\b(tomorrow|this week|next week|in (a|one|two|three|\d+) (days?|weeks?)|deadline|court date|expires)\b/i;
const MINOR = /\b(my|our|her|his) (son|daughter|kids?|children|child)\b|\bcustody\b|\b(1[0-7]|[1-9])[- ]year[- ]old\b/i;
const OPPOSING = /\b(?:against|sue|suing|versus|vs\.?)\s+((?:[A-Z][\w&'.]*\s?){1,4})/g;

export class MockIntakeModel implements IntakeModel {
  readonly name = "mock";
  readonly model = "mock-keywords-v1";

  async classify(email: InboundEmail): Promise<Classification> {
    const text = `${email.subject}\n${email.text}`;
    const category = CATEGORY_RULES.find((r) => r.re.test(text))?.category ?? "new_matter";
    const practice = PRACTICE_RULES.find((r) => r.re.test(text))?.area;
    const practiceArea = category === "new_matter" || category === "existing_client" ? (practice ?? "none") : "none";

    const parties: Classification["partiesMentioned"] = [];
    if (email.from.name) parties.push({ name: email.from.name, role: "prospective_client" });
    for (const m of text.matchAll(OPPOSING)) parties.push({ name: m[1]!.trim(), role: "opposing_party" });

    return {
      category,
      practiceArea,
      urgency: EMERGENCY.test(text) ? "emergency" : DEADLINE.test(text) ? "deadline_soon" : "routine",
      deadlineMentioned: text.match(DEADLINE)?.[0] ?? null,
      partiesMentioned: parties.slice(0, 10),
      involvesMinor: MINOR.test(text),
      // The mock never flags injection itself, which shows the regex heuristic working on its own.
      injectionSuspected: false,
      summary: `${category.replace(/_/g, " ")}${practice ? `, ${practice.replace(/_/g, " ")}` : ""}`,
      confidence: category !== "new_matter" ? 0.9 : practice ? 0.8 : 0.4,
    };
  }

  async draftReply(email: InboundEmail, c: Classification): Promise<string> {
    const first = email.from.name?.split(" ")[0] ?? "there";
    const area = c.practiceArea.replace(/_/g, " ");
    return [
      `Hi ${first},`,
      "",
      `Thank you for reaching out about your ${area} matter. Our team handles this kind of situation, and we would like to set up a consultation to hear more.`,
      "",
      "Could you reply with the best phone number to reach you and two or three times that work for you this week or next?",
    ].join("\n");
  }
}
