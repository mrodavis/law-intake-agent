import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-intake-signature";
export const TIMESTAMP_HEADER = "x-intake-timestamp";
export const DRY_RUN_HEADER = "x-dry-run";
export const REPLAY_WINDOW_SECONDS = 300;
export const MAX_ATTEMPTS = 3;

/** HMAC-SHA256 over "<unix seconds>.<raw body>". The timestamp is signed so it cannot be swapped. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

export function verifySignature(args: {
  secret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSeconds?: number;
}): VerifyResult {
  const { secret, rawBody, timestamp, signature } = args;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on unequal lengths.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Constant-time comparison for the staff bearer token. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
