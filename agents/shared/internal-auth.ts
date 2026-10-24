import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const WINDOW_MS = 5 * 60 * 1000;
const seenNonces = new Map<string, number>();

export interface SignedHeaders {
  "x-internal-timestamp": string;
  "x-internal-nonce": string;
  "x-internal-signature": string;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function payloadOf(method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash(body)}`;
}

function sign(payload: string): string {
  return createHmac("sha256", env.INTERNAL_TOKEN).update(payload).digest("hex");
}

function pruneNonces(now: number) {
  for (const [nonce, seenAt] of seenNonces) {
    if (now - seenAt > WINDOW_MS) seenNonces.delete(nonce);
  }
}

export function signInternalRequest(method: string, path: string, body: string, now = Date.now()): SignedHeaders {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString("hex");
  const signature = sign(payloadOf(method, path, timestamp, nonce, body));
  return {
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature,
  };
}

export function verifyInternalRequest(input: {
  method: string;
  path: string;
  body: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? Date.now();
  if (!env.INTERNAL_TOKEN) return { ok: false, reason: "missing-secret" };
  if (!input.timestamp || !input.nonce || !input.signature) return { ok: false, reason: "missing-signature" };
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > WINDOW_MS) {
    return { ok: false, reason: "timestamp-window" };
  }
  pruneNonces(now);
  if (seenNonces.has(input.nonce)) return { ok: false, reason: "nonce-replay" };

  const expected = sign(payloadOf(input.method, input.path, input.timestamp, input.nonce, input.body));
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(input.signature, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: "bad-signature" };
  }
  seenNonces.set(input.nonce, now);
  return { ok: true };
}

/** 测试隔离 nonce 缓存 */
export function resetInternalNonces(): void {
  seenNonces.clear();
}
