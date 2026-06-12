// Integration tests for the Express adapter. We exercise the middleware
// against a real express() app via Node's HTTP server + fetch — avoids
// pulling supertest as a dev dep and works in vitest with no special
// setup.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import express from "express";
import type { Server } from "node:http";
import * as ed25519 from "@noble/ed25519";
import { sha512, sha256 } from "@noble/hashes/sha2";
import { type Receipt, signingBytes } from "../receipt.js";
import { expressMiddleware } from "../middleware-express.js";

ed25519.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed25519.etc.concatBytes(...m));

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function validReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: "rid-express",
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

function signHmac(r: Receipt, secret: Uint8Array): string {
  const sb = signingBytes(r);
  const mac = createHmac("sha256", secret).update(sb).digest();
  const body = JSON.stringify(r);
  return `${b64u(new TextEncoder().encode(body))}.${b64u(new Uint8Array(mac))}.hmac-sha256`;
}

describe("expressMiddleware", () => {
  let server: Server;
  let baseUrl: string;
  const sk = randomBytes(32);
  const pk = ed25519.getPublicKey(sk);
  const hmacSecret = randomBytes(32);

  beforeAll(async () => {
    const app = express();
    app.get(
      "/widget",
      expressMiddleware({
        merchantId: "m1",
        routeCanonical: "GET /widget",
        algorithm: "ed25519",
        ed25519Public: pk,
        now: () => Date.parse("2024-01-01T00:00:00Z"),
      }),
      (req, res) => {
        res.json({ ok: true, receiptId: req.mppReceipt?.receipt_id });
      },
    );
    app.get(
      "/widget-hmac",
      expressMiddleware({
        merchantId: "m1",
        routeCanonical: "GET /widget-hmac",
        algorithm: "hmac-sha256",
        hmacSecret,
        now: () => Date.parse("2024-01-01T00:00:00Z"),
      }),
      (req, res) => {
        res.json({ ok: true, receiptId: req.mppReceipt?.receipt_id });
      },
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes the request to the handler on a valid receipt", async () => {
    const header = signEd25519(validReceipt(), sk);
    const res = await fetch(`${baseUrl}/widget`, {
      headers: { "Payment-Receipt": header },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; receiptId: string };
    expect(body.ok).toBe(true);
    expect(body.receiptId).toBe("rid-express");
  });

  it("returns 401 payment_required when the Payment-Receipt header is missing", async () => {
    const res = await fetch(`${baseUrl}/widget`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    // Round-16 codex P2: absent header must surface as the
    // `payment_required` no-credential reason, distinct from the
    // `invalid_payment_receipt` malformed-credential reason. This
    // matches the Go middleware's wire contract.
    expect(body.error).toBe("payment_required");
    // Round-7 codex P2: response body must NOT include `reason` (the
    // free-form detail). It belongs in onReject for operator logging,
    // not on the public wire.
    expect(body.reason).toBeUndefined();
  });

  it("returns 401 invalid_signature on a tampered receipt", async () => {
    const r = validReceipt();
    const sb = signingBytes(r);
    const msgHash = sha256(sb);
    const sig = ed25519.sign(msgHash, sk);
    const tampered = { ...r, amount_wei: "9999" };
    const header = `${b64u(new TextEncoder().encode(JSON.stringify(tampered)))}.${b64u(sig)}.ed25519`;
    const res = await fetch(`${baseUrl}/widget`, {
      headers: { "Payment-Receipt": header },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_signature");
    // Round-7 codex P2: detail must not leak.
    expect(body.reason).toBeUndefined();
  });

  it("returns 402 route_mismatch when receipt is for another route", async () => {
    const r = validReceipt({ request_canonical: "GET /other" });
    const header = signEd25519(r, sk);
    const res = await fetch(`${baseUrl}/widget`, {
      headers: { "Payment-Receipt": header },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("route_mismatch");
  });

  it("accepts HMAC-signed receipts when configured", async () => {
    const r = validReceipt({ request_canonical: "GET /widget-hmac" });
    const header = signHmac(r, hmacSecret);
    const res = await fetch(`${baseUrl}/widget-hmac`, {
      headers: { "Payment-Receipt": header },
    });
    expect(res.status).toBe(200);
  });
});

// Round-5 codex P2: store failures must surface as 503 from the
// adapter, not bubble through Express's default error handler as a
// generic 500. We mount a separate route with a deliberately-broken
// store so the production routes above stay simple.
describe("expressMiddleware store failure handling", () => {
  let server: Server;
  let baseUrl: string;
  const sk = randomBytes(32);
  const pk = ed25519.getPublicKey(sk);

  beforeAll(async () => {
    const app = express();
    app.get(
      "/widget-broken-store",
      expressMiddleware({
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
      }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 503 receipt_store_unavailable when the store is unreachable", async () => {
    const r = validReceipt({ request_canonical: "GET /widget-broken-store" });
    const header = signEd25519(r, sk);
    const res = await fetch(`${baseUrl}/widget-broken-store`, {
      headers: { "Payment-Receipt": header },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("receipt_store_unavailable");
  });
});
