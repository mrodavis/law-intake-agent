import { appendFileSync } from "node:fs";
import type { Classification, Route } from "./domain/schema.ts";

export interface IntakeRecord {
  messageId: string;
  threadId: string;
  receivedAt: string;
  processedAt: string;
  from: { email: string; name?: string };
  subject: string;
  model: string | null;
  promptHash: string | null;
  classification: Classification | null;
  /** Set only when the sender address matches a client on file. */
  matchedClient: { name: string; matter: string } | null;
  conflicts: string[];
  injection: { model: boolean; heuristic: boolean };
  route: Route;
  draftId: string | null;
}

export type DraftStatus = "awaiting_approval" | "sent" | "rejected";

export interface DraftRecord {
  id: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
  status: DraftStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  editedByStaff?: boolean;
  rejectReason?: string;
}

export interface DeadLetter {
  messageId: string;
  attempts: number;
  lastError: string;
  at: string;
}

export interface AuditEvent {
  at: string;
  messageId: string;
  event: string;
  detail?: Record<string, unknown>;
}

/** In-memory store with an optional append-only JSONL audit log. Swap for Postgres in production. */
export class MemoryIntakeStore {
  readonly records = new Map<string, IntakeRecord>();
  readonly drafts = new Map<string, DraftRecord>();
  readonly attempts = new Map<string, number>();
  readonly deadLetters = new Map<string, DeadLetter>();
  readonly auditLog: AuditEvent[] = [];

  constructor(private auditPath = process.env.AUDIT_LOG_PATH) {}

  audit(messageId: string, event: string, detail?: Record<string, unknown>): void {
    const e: AuditEvent = { at: new Date().toISOString(), messageId, event, ...(detail ? { detail } : {}) };
    this.auditLog.push(e);
    if (this.auditPath) appendFileSync(this.auditPath, JSON.stringify(e) + "\n");
  }

  auditFor(messageId: string): AuditEvent[] {
    return this.auditLog.filter((e) => e.messageId === messageId);
  }
}
