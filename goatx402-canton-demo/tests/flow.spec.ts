// Vitest unit tests for the SPA's browser flow.
//
// Implementation note: msw 2.x relies on a global fetch dispatcher patch and
// has known interception failures under Node 25 + jsdom. The flow code is
// already structured to take an injected `fetchImpl`, so the suite uses a
// hand-rolled in-memory router instead. The contract under test (the
// generator's phase sequence, X-Payer-Token wiring, source-holding precedence,
// and 202 polling) is identical either way.
//
// Coverage:
//   - happy path through DISCOVERY → ORDER_CREATED → SIGNED →
//     CHECKOUT_VERIFIED → PAYMENT_CONFIRMED → RESOURCE_FETCHED
//   - asynchronous 202 path that polls GET /:id?wait=true
//   - source-holding env override wins over the dev fallback
//   - missing payerToken raises a clear error from FacilitatorClient
//   - merchant 402 envelope without a canton-daml entry yields an ERROR event
//   - every facilitator request carries X-Payer-Token

import { describe, expect, test } from "vitest";

import { FacilitatorClient, MerchantClient } from "../src/lib/api";
import { runFlow, type FlowEvent } from "../src/lib/flow";
import { encodeReceiptForHeader, type CantonReceipt } from "../src/lib/receipt";
import { fetch402, selectCantonDaml } from "../src/lib/x402";

const FACILITATOR = "http://localhost:8080";
const MERCHANT = "http://localhost:7070";
const PAYER = "PartyA::1220abcd";
const PAYER_TOKEN = "dGVzdC10b2tlbi0xMjMK";
const SOURCE_CID = "0:abcd::sourceHolding";
const NONCE = "merchant-nonce-22-chars-ok";

const receipt: CantonReceipt = {
  version: "1.0",
  domain: "goat-canton-receipt:v1",
  orderId: "00000000-0000-7000-8000-000000000001",
  ledgerId: "test-ledger",
  transactionId: "tx-1",
  contractId: "0:cid::merchantHolding",
  paymentRequestContractId: "0:cid::paymentRequest",
  participantPartyId: "Participant::1220ffff",
  merchant: "MerchantParty::abcd",
  payer: PAYER,
  amount: "1.5",
  currency: "USD-canton",
  trustedIssuer: "Issuer::abcd",
  resource: "/resource",
  merchantRequestId: NONCE,
  expiresAtHttp: Date.now() + 60_000,
  expiresAtDaml: Date.now() + 90_000,
  signatureScheme: "Ed25519",
  signature: "AAAA",
  receiptPayloadHash: "BBBB",
  completedAt: Date.now(),
};

interface FakeServerOpts {
  asyncPath?: boolean;
  pollUntilConfirmed?: number;
  merchantNoCantonAccept?: boolean;
  failSourceHolding?: boolean;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function buildFakeFetch(opts: FakeServerOpts = {}) {
  const requests: RecordedRequest[] = [];
  let pollCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url, headers, body });

    if (url.startsWith(MERCHANT + "/resource")) {
      if (headers["x-payment"]) {
        return new Response("the merchant's secret content", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (opts.merchantNoCantonAccept) {
        return jsonResponse(402, {
          x402Version: 1,
          accepts: [
            {
              scheme: "ethereum-eip3009",
              amount: "1",
              currency: "USD",
              trustedIssuer: "x",
              payTo: "y",
              facilitator: FACILITATOR,
              resource: "/resource",
              merchantRequestId: "n",
            },
          ],
          error: "payment_required",
        });
      }
      return jsonResponse(402, {
        x402Version: 1,
        accepts: [
          {
            scheme: "canton-daml",
            amount: "1.5",
            currency: "USD-canton",
            trustedIssuer: "Issuer::abcd",
            payTo: "MerchantParty::abcd",
            facilitator: FACILITATOR,
            resource: "/resource",
            merchantRequestId: NONCE,
          },
        ],
        error: "payment_required",
      });
    }

    if (url.startsWith(FACILITATOR)) {
      if (headers["x-payer-token"] !== PAYER_TOKEN) {
        return jsonResponse(401, {
          error: { code: "UNAUTHENTICATED", message: "X-Payer-Token mismatch" },
        });
      }
    }

    if (url.startsWith(FACILITATOR + "/api/v1/dev/source-holding")) {
      if (opts.failSourceHolding) {
        return jsonResponse(500, {
          error: { code: "UNREACHABLE", message: "fallback called when env was set" },
        });
      }
      return jsonResponse(200, {
        payer: PAYER,
        sourceHoldingContractId: SOURCE_CID,
      });
    }

    if (url === FACILITATOR + "/api/v1/orders" && method === "POST") {
      const parsed = JSON.parse(body ?? "{}");
      return jsonResponse(201, {
        x402Version: 1,
        orderId: receipt.orderId,
        nonce: "browser-nonce",
        status: "CREATED",
        submissionPayloadHash: "ZmFrZS1oYXNo",
        accepts: [
          {
            scheme: "canton-daml",
            amount: parsed.amount,
            currency: parsed.currency,
            payTo: parsed.merchant,
            resource: parsed.resource,
            expiresAt: Date.now() + 60_000,
            merchantRequestId: parsed.merchantRequestId,
            trustedIssuer: parsed.trustedIssuer,
            command: {
              templateId: "Payment:PaymentRequest",
              createArgs: {},
              choice: "Pay",
              choiceArgs: { sourceHolding: parsed.sourceHoldingContractId },
              dedupId: "fake-dedup",
              submissionPayloadHash: "ZmFrZS1oYXNo",
              expiresAtHttp: Date.now() + 60_000,
              expiresAtDaml: Date.now() + 90_000,
            },
          },
        ],
      });
    }

    const orderMatch = url.match(/\/api\/v1\/orders\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (orderMatch) {
      const sub = orderMatch[2] ?? "";
      if (sub === "/custodial-sign" && method === "POST") {
        return jsonResponse(200, {
          signatureScheme: "Ed25519",
          signature: "AAAA",
          publicKey: "BBBB",
        });
      }
      if (sub === "/calldata-signature" && method === "POST") {
        if (opts.asyncPath) {
          return jsonResponse(202, {
            orderId: receipt.orderId,
            status: "CHECKOUT_VERIFIED",
          });
        }
        return jsonResponse(200, {
          orderId: receipt.orderId,
          status: "PAYMENT_CONFIRMED",
          receipt,
        });
      }
      if (sub === "/proof" && method === "GET") {
        return jsonResponse(200, receipt);
      }
      if (sub === "" && method === "GET") {
        pollCount++;
        if (pollCount < (opts.pollUntilConfirmed ?? 0)) {
          return jsonResponse(200, {
            orderId: receipt.orderId,
            status: "CHECKOUT_VERIFIED",
            expiresAt: Date.now() + 60_000,
            updatedAt: Date.now(),
            retryState: "retrying",
            retryLastError: null,
          });
        }
        return jsonResponse(200, {
          orderId: receipt.orderId,
          status: "PAYMENT_CONFIRMED",
          expiresAt: Date.now() + 60_000,
          updatedAt: Date.now(),
          retryState: "healthy",
          retryLastError: null,
        });
      }
    }

    return jsonResponse(404, {
      error: { code: "UNKNOWN_ROUTE", message: `no fake handler for ${method} ${url}` },
    });
  };

  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(gen: AsyncGenerator<FlowEvent>): Promise<FlowEvent[]> {
  const out: FlowEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("FacilitatorClient", () => {
  test("constructor refuses an empty payerToken", () => {
    expect(
      () =>
        new FacilitatorClient({
          baseURL: FACILITATOR,
          payerToken: "",
        }),
    ).toThrow(/payerToken required/);
  });

  test("attaches X-Payer-Token on every facilitator call", async () => {
    const { fetchImpl, requests } = buildFakeFetch();
    const client = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: PAYER_TOKEN,
      fetchImpl,
    });
    await client.getSourceHolding(PAYER);
    await client.custodialSign(receipt.orderId);
    await client.getProof(receipt.orderId);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.headers["x-payer-token"]).toBe(PAYER_TOKEN);
    }
  });

  test("surfaces facilitator error envelope as ApiError", async () => {
    const { fetchImpl } = buildFakeFetch();
    const client = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: "wrong-token",
      fetchImpl,
    });
    await expect(client.getSourceHolding(PAYER)).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "UNAUTHENTICATED",
    });
  });
});

describe("fetch402 + selectCantonDaml", () => {
  test("picks the canton-daml accepts entry", async () => {
    const { fetchImpl } = buildFakeFetch();
    const env = await fetch402(MERCHANT, "/resource", fetchImpl);
    const accept = selectCantonDaml(env);
    expect(accept.scheme).toBe("canton-daml");
    expect(accept.merchantRequestId).toBe(NONCE);
  });

  test("throws when no canton-daml entry is present", () => {
    expect(() =>
      selectCantonDaml({
        x402Version: 1,
        accepts: [
          {
            scheme: "ethereum-eip3009",
            amount: "1",
            currency: "USD",
            trustedIssuer: "x",
            payTo: "y",
            facilitator: "z",
            resource: "/r",
            merchantRequestId: "n",
          },
        ],
      }),
    ).toThrow(/no canton-daml/);
  });
});

describe("runFlow (happy path)", () => {
  test("emits the documented phases ending in RESOURCE_FETCHED", async () => {
    const { fetchImpl } = buildFakeFetch();
    const facilitator = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: PAYER_TOKEN,
      fetchImpl,
    });
    const merchant = new MerchantClient({
      baseURL: MERCHANT,
      resourcePath: "/resource",
      fetchImpl,
    });
    const events = await collect(
      runFlow({
        facilitator,
        merchant,
        merchantURL: MERCHANT,
        resourcePath: "/resource",
        payerParty: PAYER,
        sourceHoldingCID: "",
        waitTimeoutMs: 100,
        sleep: () => Promise.resolve(),
      }),
    );
    const phases = events.map((e) => e.phase);
    if (phases.includes("ERROR")) {
      // Surface the diagnostic via the assertion error if the flow tripped.
      const err = events.find((e) => e.phase === "ERROR");
      throw new Error(
        `flow ended in ERROR: ${err?.detail} / ${err?.error}`,
      );
    }
    expect(phases).toContain("DISCOVERY");
    expect(phases).toContain("ORDER_CREATED");
    expect(phases).toContain("SIGNED");
    expect(phases).toContain("PAYMENT_CONFIRMED");
    expect(phases).toContain("RESOURCE_FETCHED");
    const last = events[events.length - 1];
    expect(last.phase).toBe("RESOURCE_FETCHED");
    expect(last.resourceBody).toBe("the merchant's secret content");
    expect(last.receipt?.orderId).toBe(receipt.orderId);
  });
});

describe("runFlow (async 202 + polling)", () => {
  test("transitions CHECKOUT_VERIFIED → PAYMENT_CONFIRMED via GET /:id polls", async () => {
    const { fetchImpl } = buildFakeFetch({ asyncPath: true, pollUntilConfirmed: 2 });
    const facilitator = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: PAYER_TOKEN,
      fetchImpl,
    });
    const merchant = new MerchantClient({
      baseURL: MERCHANT,
      resourcePath: "/resource",
      fetchImpl,
    });
    const events = await collect(
      runFlow({
        facilitator,
        merchant,
        merchantURL: MERCHANT,
        resourcePath: "/resource",
        payerParty: PAYER,
        sourceHoldingCID: SOURCE_CID,
        waitTimeoutMs: 50,
        sleep: () => Promise.resolve(),
        maxPollIterations: 5,
      }),
    );
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("CHECKOUT_VERIFIED");
    expect(phases).toContain("PAYMENT_CONFIRMED");
    expect(phases[phases.length - 1]).toBe("RESOURCE_FETCHED");
  });
});

describe("runFlow (source-holding env override)", () => {
  test("does not call dev/source-holding when VITE_SOURCE_HOLDING_CID is set", async () => {
    const { fetchImpl, requests } = buildFakeFetch({ failSourceHolding: true });
    const facilitator = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: PAYER_TOKEN,
      fetchImpl,
    });
    const merchant = new MerchantClient({
      baseURL: MERCHANT,
      resourcePath: "/resource",
      fetchImpl,
    });
    const events = await collect(
      runFlow({
        facilitator,
        merchant,
        merchantURL: MERCHANT,
        resourcePath: "/resource",
        payerParty: PAYER,
        sourceHoldingCID: "0:abcd::envCID",
        waitTimeoutMs: 50,
        sleep: () => Promise.resolve(),
      }),
    );
    const calledFallback = requests.some((r) =>
      r.url.startsWith(FACILITATOR + "/api/v1/dev/source-holding"),
    );
    expect(calledFallback).toBe(false);
    expect(events[events.length - 1].phase).toBe("RESOURCE_FETCHED");
  });
});

describe("runFlow (merchant has no canton-daml accept)", () => {
  test("emits an ERROR event and stops", async () => {
    const { fetchImpl } = buildFakeFetch({ merchantNoCantonAccept: true });
    const facilitator = new FacilitatorClient({
      baseURL: FACILITATOR,
      payerToken: PAYER_TOKEN,
      fetchImpl,
    });
    const merchant = new MerchantClient({
      baseURL: MERCHANT,
      resourcePath: "/resource",
      fetchImpl,
    });
    const events = await collect(
      runFlow({
        facilitator,
        merchant,
        merchantURL: MERCHANT,
        resourcePath: "/resource",
        payerParty: PAYER,
        sourceHoldingCID: SOURCE_CID,
        waitTimeoutMs: 50,
        sleep: () => Promise.resolve(),
      }),
    );
    const last = events[events.length - 1];
    expect(last.phase).toBe("ERROR");
    expect(last.detail).toMatch(/402 discovery/);
  });
});

describe("encodeReceiptForHeader", () => {
  test("produces a base64 string that round-trips through JSON.parse", () => {
    const encoded = encodeReceiptForHeader(receipt);
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf-8"),
    );
    expect(decoded.orderId).toBe(receipt.orderId);
    expect(decoded.signature).toBe(receipt.signature);
  });
});
