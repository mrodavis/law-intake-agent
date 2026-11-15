/**
 * Heuristic prompt-injection detector. It runs alongside the model's own
 * injectionSuspected flag (either one triggers a human handoff), because the
 * model reading the attack is not the best judge of whether it was attacked.
 */
const PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /\b(system|assistant)\s*:/i,
  /you are now\b/i,
  /disregard (your|the) (rules|instructions|guidelines)/i,
  /(reveal|print|show) (your|the) (system )?prompt/i,
  /<\/?(system|instructions?|email)>/i,
];

export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
