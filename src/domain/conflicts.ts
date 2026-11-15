import type { Classification } from "./schema.ts";

const SUFFIXES = /\b(inc|llc|pllc|corp|co|ltd|company|the)\b/g;

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[.,'&]/g, " ").replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic conflict check: the prospective client must not be someone the
 * firm is adverse to, and the opposing party must not be a current client.
 * The model only extracts names; code decides whether there is a conflict.
 */
export function checkConflicts(
  parties: Classification["partiesMentioned"],
  firm: { clients: Array<{ name: string }>; adverse: string[] },
): string[] {
  const clientNames = new Set(firm.clients.map((c) => normalizeName(c.name)));
  const adverseNames = new Set(firm.adverse.map(normalizeName));
  const hits: string[] = [];
  for (const p of parties) {
    const n = normalizeName(p.name);
    if (!n) continue;
    if (p.role === "prospective_client" && adverseNames.has(n)) hits.push(`${p.name} is an adverse party`);
    if (p.role === "opposing_party" && clientNames.has(n)) hits.push(`${p.name} is a current client`);
  }
  return hits;
}
