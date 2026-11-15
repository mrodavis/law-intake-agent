/**
 * Synthetic data for a FICTIONAL firm, Hale & Ortiz Law PLLC. Every name and
 * address is invented. In production these come from the case management system.
 */
export const FIRM = {
  name: "Hale & Ortiz Law PLLC",
  phone: "(555) 010-4400",
  practiceAreas: ["personal_injury", "family", "immigration", "estate_planning", "employment"] as const,
};

/** Current clients, matched ONLY by the address an email came from. */
export const CLIENTS: Array<{ name: string; email: string; matter: string }> = [
  { name: "Dana Whitcomb", email: "dana.whitcomb@example.com", matter: "FAM-2026-014" },
  { name: "Marcus Bell", email: "mbell@example.net", matter: "PI-2025-221" },
  { name: "Priya Raman", email: "priya.r@example.org", matter: "IMM-2026-031" },
];

/** People and companies the firm is adverse to. Representing them would be a conflict. */
export const ADVERSE_PARTIES: string[] = ["Coastal Freight Logistics", "Greg Whitcomb", "Lakeside Property Management", "Tom Albers"];
