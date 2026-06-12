// Unit tests for verifyReceipt covering all 4+1 checks and the 7
// rejection paths. We generate a fresh ed25519 keypair in-test and
// produce header values from the TS signingBytes layout so these tests
// can run before the Go side ships fixtures.

import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2";
import { type Receipt, signingBytes } from "../receipt.js";
import {
  InMemoryReceiptIDStore,
  type VerifyConfig,
  verifyReceipt,
} from "../verify.js";

ed25519.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...m));

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

/** Builds a valid receipt-header value using the provided receipt and ed25519 keypair. */
function buildEd25519Header(receipt: Receipt, secretKey: Uint8Array): string {
  const sb = signingBytes(receipt);
  const msgHash = sha256(sb);
  const sig = ed25519.sign(msgHash, secretKey);
  const body = JSON.stringify(receipt);
  return `${b64u(new TextEncoder().encode(body))}.${b64u(sig)}.ed25519`;
}

/** Builds a valid receipt-header value using HMAC-SHA256. */
function buildHmacHeader(receipt: Receipt, secret: Uint8Array): string {
  const sb = signingBytes(receipt);
  const mac = createHmac("sha256", secret).update(sb).digest();
  const body = JSON.stringify(receipt);
  return `${b64u(new TextEncoder().encode(body))}.${b64u(new Uint8Array(mac))}.hmac-sha256`;
}

function validReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rid-abc",
    challenge_id: "ch1",
    order_id: "ord1",
    merchant_id: "m1",
    payer_addr: "0x1111111111111111111111111111111111111111",
    chain_id: 4217,
    token_contract: "0x2222222222222222222222222222222222222222",
    recipient: "0x3333333333333333333333333333333333333333",
    amount_wei: "1000000",
    request_canonical: "GET /widget",
    tx_hash: "0xabc",
    log_index: 5,
    block_number: 100,
    block_timestamp: "2023-11-14T22:13:20Z",
    receipt_issued_at: "2023-11-14T22:13:20Z",
    receipt_expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

// Frozen "now" before all receipt expiries.
const FROZEN_NOW_MS = Date.parse("2024-01-01T00:00:00Z");
const frozenNow = () => FROZEN_NOW_MS;

describe("verifyReceipt", () => {
  describe("ed25519 happy path", () => {
    it("accepts a well-formed receipt", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.receipt.receipt_id).toBe("rid-abc");
      }
    });

    it("accepts a route-prefix match with colon-delimited suffix", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt({ request_canonical: "GET /widget:price=100" });
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(true);
    });
  });

  describe("hmac happy path", () => {
    it("accepts a well-formed HMAC receipt", async () => {
      const secret = randomBytes(32);
      const r = validReceipt();
      const header = buildHmacHeader(r, secret);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "hmac-sha256",
        hmacSecret: secret,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(true);
    });
  });

  describe("rejection paths", () => {
    it("rejects an empty header as payment_required (round 56 codex P3)", async () => {
      // Framework adapters distinguish "no credential" (payment_required)
      // from "credential malformed" (invalid_payment_receipt); the
      // framework-agnostic verifyReceipt must surface the same reason
      // for the same condition so non-Express/Fastify consumers can
      // route the user back to /challenge cleanly.
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: ed25519.getPublicKey(randomBytes(32)),
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, "");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.reason).toBe("payment_required");
      }
    });

    it("rejects an unparseable header (401 invalid_payment_receipt)", async () => {
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: ed25519.getPublicKey(randomBytes(32)),
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, "not-a-header");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.reason).toBe("invalid_payment_receipt");
      }
    });

    it("rejects an unknown algorithm (401 invalid_payment_receipt)", async () => {
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: ed25519.getPublicKey(randomBytes(32)),
        now: frozenNow,
      };
      // Body/sig parts are valid base64url; alg is unknown.
      const header = `${b64u(new TextEncoder().encode("{}"))}.${b64u(new Uint8Array(64))}.rot13`;
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_payment_receipt");
      }
    });

    it("rejects a header signed with the wrong key (401 invalid_signature)", async () => {
      const sk = randomBytes(32);
      const otherPk = ed25519.getPublicKey(randomBytes(32));
      const r = validReceipt();
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: otherPk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.reason).toBe("invalid_signature");
      }
    });

    it("rejects an algorithm-confusion attack (header alg !== config alg)", async () => {
      const secret = randomBytes(32);
      const r = validReceipt();
      const header = buildHmacHeader(r, secret);
      // We configured ed25519 but the header is hmac-sha256.
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: ed25519.getPublicKey(randomBytes(32)),
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_signature");
      }
    });

    it("rejects a receipt bound to a different merchant (401 audience_mismatch)", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt({ merchant_id: "different-merchant" });
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.reason).toBe("audience_mismatch");
      }
    });

    it("rejects a receipt for the wrong route (402 route_mismatch)", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt({ request_canonical: "GET /other-route" });
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(402);
        expect(result.reason).toBe("route_mismatch");
      }
    });

    it("rejects a route-prefix-without-colon match (defends against bare prefix attack)", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      // Without the ":" delimiter, "GET /widgetz" should NOT satisfy "GET /widget".
      const r = validReceipt({ request_canonical: "GET /widgetz" });
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("route_mismatch");
      }
    });

    it("rejects an expired receipt (402 receipt_expired)", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt({
        // Issued and expired well before frozen now.
        receipt_issued_at: "2023-01-01T00:00:00Z",
        receipt_expires_at: "2023-01-02T00:00:00Z",
      });
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(402);
        expect(result.reason).toBe("receipt_expired");
      }
    });

    it("rejects a replayed receipt when a store is configured (401 receipt_already_consumed)", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const header = buildEd25519Header(r, sk);
      const store = new InMemoryReceiptIDStore();
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
        store,
      };
      const first = await verifyReceipt(cfg, header);
      expect(first.ok).toBe(true);
      const second = await verifyReceipt(cfg, header);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.status).toBe(401);
        expect(second.reason).toBe("receipt_already_consumed");
      }
    });

    it("rejects a header whose body has an unknown field", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const sb = signingBytes(r);
      const msgHash = sha256(sb);
      const sig = ed25519.sign(msgHash, sk);
      // Splice in an extra field.
      const bodyWithExtra = JSON.stringify({ ...r, extra_unknown_field: "x" });
      const header = `${b64u(new TextEncoder().encode(bodyWithExtra))}.${b64u(sig)}.ed25519`;
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_payment_receipt");
      }
    });

    it("rejects a receipt whose body bytes were tampered with after signing", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const sb = signingBytes(r);
      const msgHash = sha256(sb);
      const sig = ed25519.sign(msgHash, sk);
      // Modify amount_wei but keep the original signature.
      const tampered = { ...r, amount_wei: "9999" };
      const header = `${b64u(new TextEncoder().encode(JSON.stringify(tampered)))}.${b64u(sig)}.ed25519`;
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_signature");
      }
    });
  });

  describe("config validation", () => {
    it("throws on missing merchantId", async () => {
      const bad = {
        merchantId: "",
        routeCanonical: "x",
        algorithm: "ed25519" as const,
        ed25519Public: new Uint8Array(32),
      };
      await expect(verifyReceipt(bad, "x.y.ed25519")).rejects.toThrow();
    });

    it("throws on wrong-size ed25519 public key", async () => {
      const bad = {
        merchantId: "m",
        routeCanonical: "x",
        algorithm: "ed25519" as const,
        ed25519Public: new Uint8Array(31),
      };
      await expect(verifyReceipt(bad, "x.y.ed25519")).rejects.toThrow();
    });

    it("throws on missing HMAC secret", async () => {
      const bad = {
        merchantId: "m",
        routeCanonical: "x",
        algorithm: "hmac-sha256" as const,
      };
      await expect(verifyReceipt(bad as VerifyConfig, "x.y.hmac-sha256")).rejects.toThrow();
    });
  });

  describe("InMemoryReceiptIDStore", () => {
    // Pins the round-4 P2 fix: the in-memory store must honour the
    // ttlMs argument so the consumed-set is bounded. Without TTL,
    // long-lived processes would leak memory in direct proportion to
    // the number of receipts they observed.
    it("expires entries after TTL", async () => {
      const store = new InMemoryReceiptIDStore();
      expect(await store.tryConsume("r1", 100)).toEqual({ consumed: true });
      // Same id inside the TTL: second consume is rejected (replay).
      expect(await store.tryConsume("r1", 100)).toEqual({ consumed: false });
      // Wait past the TTL boundary so the entry expires.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // After TTL the entry has been gc'd and the id is acceptable
      // again. (In production a receipt past receipt_expires_at would
      // be rejected at the expiry check before the store is consulted;
      // this assertion is about the store's bound, not security.)
      expect(await store.tryConsume("r1", 100)).toEqual({ consumed: true });
    });

    it("clamps zero / negative ttlMs to record the entry", async () => {
      // A buggy caller could pass ttlMs<=0; the store must still
      // record the entry (immediately-expiring) rather than silently
      // dropping it, so a re-consume on the same tick observes the
      // collision.
      const store = new InMemoryReceiptIDStore();
      expect(await store.tryConsume("r2", 0)).toEqual({ consumed: true });
      // Same tick: still rejected because we clamped to 1ms.
      expect(await store.tryConsume("r2", 0)).toEqual({ consumed: false });
    });
  });

  // Pins the round-5 codex P2 fix: a store failure (e.g. Redis outage)
  // must surface as a 503 receipt_store_unavailable VerifyResult rather
  // than letting the underlying rejection escape verifyReceipt. Without
  // this, the Express middleware falls through to its default error
  // handler and the caller sees a generic 500, and the Fastify plugin
  // similarly propagates the rejection up its chain. Either way, the
  // contract (matching the Go middleware) requires 503 so callers can
  // distinguish a transient infrastructure failure from a programming
  // bug.
  describe("store failure handling (round-5 codex P2)", () => {
    it("returns 503 receipt_store_unavailable when store.tryConsume throws", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
        store: {
          // Synchronous throw — exercises the catch path for callers
          // that surface infrastructure errors via thrown Errors rather
          // than rejected Promises.
          tryConsume() {
            throw new Error("redis down");
          },
        },
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(503);
        expect(result.reason).toBe("receipt_store_unavailable");
        // detail surfaces the underlying error message — useful for
        // operator logs but the response body's stable identifier is
        // the reason code.
        expect(result.detail).toContain("redis down");
      }
    });

    it("returns 503 receipt_store_unavailable when store.tryConsume rejects", async () => {
      const sk = randomBytes(32);
      const pk = ed25519.getPublicKey(sk);
      const r = validReceipt();
      const header = buildEd25519Header(r, sk);
      const cfg: VerifyConfig = {
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: frozenNow,
        store: {
          // Async rejection — the common shape for a real Redis client
          // (e.g. ioredis) whose commands return rejected Promises on
          // connection failure.
          async tryConsume() {
            throw new Error("ECONNREFUSED");
          },
        },
      };
      const result = await verifyReceipt(cfg, header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(503);
        expect(result.reason).toBe("receipt_store_unavailable");
        expect(result.detail).toContain("ECONNREFUSED");
      }
    });
  });
});
