// Receipt verification — the security boundary between an untrusted
// caller and a merchant's protected resource. Performs the 4+1 checks
// from MPP_PLAN Task S.3:
//
//   1. Signature (ed25519 OR HMAC-SHA256)
//   2. Audience binding (receipt.merchant_id matches middleware config)
//   3. Request canonical match (route binding — receipt's request_canonical
//      starts with the configured routeCanonical, optionally followed by
//      ":<extra>" suffix)
//   4. Receipt expiry (now < receipt_expires_at)
//   5. (Optional) Receipt-ID double-spend store check, when one is provided
//
// Rejection paths return a discriminated union with HTTP status + reason
// code rather than throwing — keeping middleware code straightforward.

import { createHmac, timingSafeEqual } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2";
import {
  type Algorithm,
  type Receipt,
  decodeHeader,
  ReceiptDecodeError,
  signingBytes,
} from "./receipt.js";

// noble-ed25519 v2 ships without a built-in hash; consumers must wire
// one in via etc.sha512Sync. Doing it once at module-load is fine —
// sha512 is pure and has no side effects. We use the sync variant so
// verifyReceipt does not have to be async on the hot path; the package
// also exposes verifyAsync that uses WebCrypto if you want — but the
// sync verify keeps the hot path simple.
ed25519.etc.sha512Sync = (...m: Uint8Array[]) =>
  sha512(ed25519.etc.concatBytes(...m));

/**
 * Reason codes for rejected receipts. The string values are part of the
 * public contract — log analytics may key off them.
 */
export type RejectReason =
  | "payment_required"
  | "invalid_payment_receipt"
  | "invalid_signature"
  | "audience_mismatch"
  | "route_mismatch"
  | "receipt_expired"
  | "receipt_already_consumed"
  | "receipt_store_unavailable";

/**
 * Discriminated-union result of verifyReceipt. On success, the parsed
 * Receipt is returned so the middleware can attach it to the request.
 * On failure, the HTTP status (401, 402, or 503) and a stable reason
 * code are returned.
 *
 * The 503 status is reserved for the double-spend store being
 * unavailable (e.g. Redis outage). The signature / audience / route /
 * expiry checks have already succeeded by the time the store is
 * consulted, so the receipt is otherwise valid — surfacing 503 (rather
 * than 401 or 500) tells the caller this is a transient
 * infrastructure failure that they may safely retry, matching the Go
 * middleware's contract for the same condition.
 *
 * `detail` is operator-only diagnostic text (e.g. the underlying
 * exception message from a backend, or attacker-supplied bytes echoed
 * back through a parser error). The framework adapters deliver it via
 * `onReject` but DO NOT include it in HTTP response bodies — the wire
 * contract is just `{ "error": <reason> }`. Treat `detail` as
 * untrusted: log it server-side, but never reflect it to clients.
 */
export type VerifyResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; status: 401 | 402 | 503; reason: RejectReason; detail?: string };

/**
 * Optional store for receipt_id consumption tracking. Allows merchants
 * to enforce single-use receipts on top of the cryptographic checks.
 *
 * `tryConsume` should atomically:
 *   - return `{ consumed: true }` if the caller successfully recorded
 *     `receiptID` for the first time,
 *   - return `{ consumed: false }` if it was already present (replay
 *     attempt).
 *
 * Errors must surface (throw / reject) so the middleware can map them
 * to a 503 — silently failing open would defeat the double-spend
 * defense entirely.
 *
 * `ttlMs` is derived from `(receipt.receipt_expires_at - now)` at the
 * call site. Backends MUST honour it so the consumed-set is bounded —
 * the receipt's signature already ensures it can never be honoured
 * past `receipt_expires_at`, so a tighter TTL leaks zero correctness
 * and bounds the memory / index footprint. Implementations may use it
 * as a hint and periodic janitor (in-memory) or as a Redis `PX`
 * argument.
 *
 * A simple in-memory implementation is provided as InMemoryReceiptIDStore
 * for tests / single-process deployments. Production deployments should
 * use a shared store (Redis, Postgres, etc.) to avoid replay across
 * replicas.
 *
 * Signature note: this is the v0.1.0 shape, mirroring the Go
 * `ReceiptIDStore.MarkConsumed(ctx, receiptID, ttl)` contract. The
 * earlier `tryConsume(receiptID): Promise<boolean>` shape was dropped
 * before the package stabilised.
 */
export interface ReceiptIDStore {
  tryConsume(
    receiptID: string,
    ttlMs: number,
  ): Promise<{ consumed: boolean }> | { consumed: boolean };
}

/**
 * Best-effort in-memory ReceiptIDStore. NOT suitable for multi-replica
 * production deployments — receipts consumed on one replica are unknown
 * to another. Provided for tests and local development.
 *
 * Honours `ttlMs` so the consumed-set is bounded. Entries are lazily
 * expired by a `gc()` sweep on each call (we do not run a timer so the
 * store can be cheap to construct and require no shutdown hook).
 */
export class InMemoryReceiptIDStore implements ReceiptIDStore {
  // receipt_id -> absolute expiry in epoch milliseconds.
  private readonly entries = new Map<string, number>();

  tryConsume(receiptID: string, ttlMs: number): { consumed: boolean } {
    this.gc();
    const now = Date.now();
    const existing = this.entries.get(receiptID);
    if (existing !== undefined && existing > now) {
      return { consumed: false };
    }
    // ttlMs may be 0 / negative if the caller passes an already-expired
    // receipt. Round-22 codex P2: a 1ms floor is too aggressive —
    // Date.now() granularity is millisecond, and the gc() at the start
    // of the NEXT call would have already advanced past `now+1`,
    // erasing the entry and admitting a replay. Match the Go in-memory
    // store's 1-second floor so the defensive clamp behaves as
    // intended (entry survives long enough to catch back-to-back
    // replays from a buggy caller).
    const ttl = ttlMs > 0 ? ttlMs : 1000;
    this.entries.set(receiptID, now + ttl);
    return { consumed: true };
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, expiry] of this.entries) {
      if (expiry <= now) {
        this.entries.delete(id);
      }
    }
  }
}

/**
 * Configuration for verifyReceipt and the framework middleware adapters.
 */
export interface VerifyConfig {
  /**
   * The merchant identifier this middleware accepts receipts for. Used
   * for audience binding (rejection reason "audience_mismatch").
   */
  merchantId: string;

  /**
   * Canonical route binding string. The middleware accepts a receipt
   * iff:
   *   receipt.request_canonical === routeCanonical
   * OR
   *   receipt.request_canonical.startsWith(routeCanonical + ":")
   *
   * This is the round-11 defense: prevents a receipt minted for route A
   * from being replayed at route B.
   */
  routeCanonical: string;

  /**
   * Selects the signature scheme to enforce. Receipts encoded with a
   * different algorithm are rejected (the algorithm field is part of
   * the on-wire envelope so we read it for parse purposes but require
   * a match to this config).
   */
  algorithm: Algorithm;

  /**
   * Required when algorithm === "ed25519". 32-byte ed25519 public key.
   */
  ed25519Public?: Uint8Array;

  /**
   * Required when algorithm === "hmac-sha256". HMAC secret bytes. Use
   * at least 32 random bytes.
   */
  hmacSecret?: Uint8Array;

  /**
   * Optional clock override for tests. Returns the current time in
   * milliseconds (matching Date.now()).
   */
  now?: () => number;

  /**
   * Optional double-spend store. When provided, verifyReceipt rejects
   * any receipt whose receipt_id has already been consumed.
   */
  store?: ReceiptIDStore;
}

/**
 * Validates a config object at module-load / middleware-construction
 * time. We do this eagerly so misconfiguration surfaces immediately,
 * not on the first request.
 */
export function validateConfig(cfg: VerifyConfig): void {
  if (!cfg.merchantId || typeof cfg.merchantId !== "string") {
    throw new Error("VerifyConfig.merchantId is required");
  }
  if (!cfg.routeCanonical || typeof cfg.routeCanonical !== "string") {
    throw new Error("VerifyConfig.routeCanonical is required");
  }
  if (cfg.algorithm === "ed25519") {
    if (!(cfg.ed25519Public instanceof Uint8Array) || cfg.ed25519Public.length !== 32) {
      throw new Error("VerifyConfig.ed25519Public must be a 32-byte Uint8Array when algorithm=ed25519");
    }
  } else if (cfg.algorithm === "hmac-sha256") {
    if (!(cfg.hmacSecret instanceof Uint8Array) || cfg.hmacSecret.length === 0) {
      throw new Error("VerifyConfig.hmacSecret must be a non-empty Uint8Array when algorithm=hmac-sha256");
    }
  } else {
    throw new Error(`VerifyConfig.algorithm must be 'ed25519' or 'hmac-sha256', got ${cfg.algorithm}`);
  }
}

/**
 * Constant-time byte equality. Uses Node's crypto.timingSafeEqual which
 * requires equal-length inputs — we pre-check lengths so we can return
 * a definite false without leaking lengths through a thrown error.
 */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Performs the full 4+1-check verification of a Payment-Receipt header
 * value. Returns a discriminated union — see the type for the contract.
 *
 * Order of checks matters for the security model:
 *   1. Parse-level checks first (cheap, do not require any key material).
 *   2. Signature next (so we know we are reasoning about a receipt the
 *      platform signed before we trust any fields in it).
 *   3. Audience / route / expiry bindings on the now-trusted fields.
 *   4. Double-spend store check last so we don't pollute the store with
 *      attacker-controlled receipt IDs that would have failed earlier.
 */
export async function verifyReceipt(
  cfg: VerifyConfig,
  headerValue: string,
): Promise<VerifyResult> {
  validateConfig(cfg);

  // ----- Step 0a: missing-credential short-circuit.
  // Framework adapters (expressMiddleware / fastifyMiddleware) special-
  // case an absent Payment-Receipt header as `payment_required` rather
  // than `invalid_payment_receipt`, matching the Go middleware's
  // distinction between "fetch a receipt" (no credential) and
  // "credential malformed" (bytes present but unparseable). Round 56
  // codex P3: framework-agnostic callers of verifyReceipt — including
  // any non-Express/Fastify adapter and any test or tool calling the
  // core API directly — must see the same reason code for the same
  // condition. Treat an empty string the same way (some HTTP clients
  // surface a missing header as "" rather than throwing key-missing).
  if (headerValue === "") {
    return {
      ok: false,
      status: 401,
      reason: "payment_required",
      detail: "missing payment-receipt header",
    };
  }

  // ----- Step 0b: parse the header.
  let decoded;
  try {
    decoded = decodeHeader(headerValue);
  } catch (e) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_payment_receipt",
      detail: e instanceof ReceiptDecodeError ? e.message : String(e),
    };
  }
  const { receipt, signature, algorithm } = decoded;

  // ----- Step 1: signature check.
  // The on-wire algorithm must match the configured algorithm. We don't
  // permit the caller to "choose" the verification algorithm — that
  // would allow an algorithm-confusion attack.
  if (algorithm !== cfg.algorithm) {
    return { ok: false, status: 401, reason: "invalid_signature", detail: `algorithm mismatch: header=${algorithm} configured=${cfg.algorithm}` };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = signingBytes(receipt);
  } catch (e) {
    // signingBytes can throw on invalid ISO-8601 timestamps. Treat that
    // as a parse-level failure so callers see a deterministic reason.
    return {
      ok: false,
      status: 401,
      reason: "invalid_payment_receipt",
      detail: (e as Error).message,
    };
  }

  let sigOK = false;
  if (cfg.algorithm === "ed25519") {
    // Go pre-hashes with SHA-256 then ed25519.Sign over the 32-byte
    // digest. We must mirror that exactly.
    const msgHash = sha256(sigBytes);
    if (signature.length !== 64 || !cfg.ed25519Public) {
      sigOK = false;
    } else {
      try {
        sigOK = ed25519.verify(signature, msgHash, cfg.ed25519Public);
      } catch {
        // noble-ed25519 throws on malformed signatures / keys. Treat as
        // verification failure.
        sigOK = false;
      }
    }
  } else {
    // HMAC-SHA256. Recompute and compare in constant time.
    if (!cfg.hmacSecret) {
      // validateConfig already enforces this; defensive check.
      return { ok: false, status: 401, reason: "invalid_signature", detail: "hmac secret missing" };
    }
    const mac = createHmac("sha256", cfg.hmacSecret);
    mac.update(sigBytes);
    const expected = new Uint8Array(mac.digest());
    sigOK = constantTimeEqualBytes(expected, signature);
  }

  if (!sigOK) {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }

  // ----- Step 2: audience binding.
  if (receipt.merchant_id !== cfg.merchantId) {
    return { ok: false, status: 401, reason: "audience_mismatch" };
  }

  // ----- Step 3: route binding (canonical match).
  // Exact match OR routeCanonical-prefix followed by a single ":" delimiter.
  // The delimiter is required so a receipt for "/a" cannot satisfy a
  // route "/" — without the delimiter, "/" would prefix "/anything".
  if (
    receipt.request_canonical !== cfg.routeCanonical &&
    !receipt.request_canonical.startsWith(cfg.routeCanonical + ":")
  ) {
    return { ok: false, status: 402, reason: "route_mismatch" };
  }

  // ----- Step 4: expiry.
  const nowMs = (cfg.now ?? Date.now)();
  let expMs: number;
  try {
    expMs = Date.parse(receipt.receipt_expires_at);
    if (Number.isNaN(expMs)) {
      throw new Error("not a valid date");
    }
  } catch (e) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_payment_receipt",
      detail: `invalid receipt_expires_at: ${(e as Error).message}`,
    };
  }
  if (nowMs >= expMs) {
    return { ok: false, status: 402, reason: "receipt_expired" };
  }

  // ----- Step 5: double-spend store (optional).
  //
  // Derive ttlMs from the verified receipt expiry. The signature check
  // above already established receipt_expires_at is platform-issued and
  // not attacker-controlled, so it is safe to use as the bound for the
  // consumed-set entry. Clamp to a minimum of 1ms so the store is still
  // hit even on tiny remaining windows — passing zero / negative would
  // let some implementations treat the entry as "do not store" and
  // silently allow replay.
  if (cfg.store) {
    const ttlMs = Math.max(1, expMs - nowMs);
    // Round-5 codex P2: store failures (e.g. Redis outage) must surface
    // as 503, NOT a generic 500. Pre-fix the rejection escaped
    // verifyReceipt and bubbled through the Express default error
    // handler → 500 (Fastify likewise). The contract — matching the Go
    // middleware — is that an unavailable double-spend store is a
    // transient infrastructure failure: 503 lets callers retry without
    // ambiguity, while 500 would conflate it with a programming bug.
    //
    // Note: we still fail closed for replay attempts (returning a
    // 401 receipt_already_consumed on the !consumed path), so this
    // catch only affects the unavailable case — the security property
    // of the double-spend check is preserved.
    let consumed: boolean;
    try {
      const result = await cfg.store.tryConsume(receipt.receipt_id, ttlMs);
      consumed = result.consumed;
    } catch (e) {
      return {
        ok: false,
        status: 503,
        reason: "receipt_store_unavailable",
        detail: (e as Error).message,
      };
    }
    if (!consumed) {
      return { ok: false, status: 401, reason: "receipt_already_consumed" };
    }
  }

  return { ok: true, receipt };
}
