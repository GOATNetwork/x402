// Integration tests for the Fastify adapter. Uses app.inject() (built
// into Fastify) so we don't need an actual HTTP server.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import * as ed25519 from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2";
import { type Receipt, signingBytes } from "../receipt.js";
import { fastifyPreHandler } from "../middleware-fastify.js";

ed25519.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...m));

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function validReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rid-fastify",
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

function signEd25519(r: Receipt, sk: Uint8Array): string {
  const sb = signingBytes(r);
  const msgHash = sha256(sb);
  const sig = ed25519.sign(msgHash, sk);
  const body = JSON.stringify(r);
  return `${b64u(new TextEncoder().encode(body))}.${b64u(sig)}.ed25519`;
}

describe("fastifyPreHandler", () => {
  let app: FastifyInstance;
  const sk = randomBytes(32);
  const pk = ed25519.getPublicKey(sk);

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const preHandler = fastifyPreHandler({
      merchantId: "m1",
      routeCanonical: "GET /widget",
      algorithm: "ed25519",
      ed25519Public: pk,
      now: () => Date.parse("2024-01-01T00:00:00Z"),
    });
    app.get("/widget", { preHandler }, async (req) => {
      return { ok: true, receiptId: req.mppReceipt?.receipt_id };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("passes the request to the handler on a valid receipt", async () => {
    const header = signEd25519(validReceipt(), sk);
    const res = await app.inject({
      method: "GET",
      url: "/widget",
      headers: { "payment-receipt": header },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { ok: boolean; receiptId: string };
    expect(body.ok).toBe(true);
    expect(body.receiptId).toBe("rid-fastify");
  });

  it("returns 401 payment_required when the Payment-Receipt header is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/widget" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    // Round-16 codex P2: absent header must surface as the
    // `payment_required` no-credential reason, matching the Go
    // middleware and the MPP wire contract.
    expect(body.error).toBe("payment_required");
    // Round-7 codex P2: response body must NOT include `reason` (the
    // free-form detail). It belongs in onReject for operator logging,
    // not on the public wire.
    expect(body.reason).toBeUndefined();
  });

  it("returns 401 audience_mismatch on wrong merchant_id", async () => {
    const r = validReceipt({ merchant_id: "other-merchant" });
    const header = signEd25519(r, sk);
    const res = await app.inject({
      method: "GET",
      url: "/widget",
      headers: { "payment-receipt": header },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload) as Record<string, unknown>;
    expect(body.error).toBe("audience_mismatch");
    // Round-7 codex P2: detail must not leak.
    expect(body.reason).toBeUndefined();
  });

  it("returns 402 receipt_expired on an expired receipt", async () => {
    const r = validReceipt({
      receipt_issued_at: "2023-01-01T00:00:00Z",
      receipt_expires_at: "2023-01-02T00:00:00Z",
    });
    const header = signEd25519(r, sk);
    const res = await app.inject({
      method: "GET",
      url: "/widget",
      headers: { "payment-receipt": header },
    });
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe("receipt_expired");
  });
});

// Round-5 codex P2: store failures must surface as 503 from the
// Fastify preHandler, not bubble through the Fastify error chain as a
// generic 500.
describe("fastifyPreHandler store failure handling", () => {
  let app: FastifyInstance;
  const sk = randomBytes(32);
  const pk = ed25519.getPublicKey(sk);

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const preHandler = fastifyPreHandler({
      merchantId: "m1",
      routeCanonical: "GET /widget-broken-store",
      algorithm: "ed25519",
      ed25519Public: pk,
      now: () => Date.parse("2024-01-01T00:00:00Z"),
      store: {
        async tryConsume() {
          throw new Error("redis down");
        },
      },
    });
    app.get("/widget-broken-store", { preHandler }, async () => {
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 503 receipt_store_unavailable when the store is unreachable", async () => {
    const r = validReceipt({ request_canonical: "GET /widget-broken-store" });
    const header = signEd25519(r, sk);
    const res = await app.inject({
      method: "GET",
      url: "/widget-broken-store",
      headers: { "payment-receipt": header },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload) as { error: string };
    expect(body.error).toBe("receipt_store_unavailable");
  });
});
