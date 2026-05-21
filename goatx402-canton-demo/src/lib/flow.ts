// flow.ts — browser-side state machine that mirrors client-cli/flow.
//
// Steps (matches §1.3 core flow + PLAN.md §5.1 endpoint sequence):
//   1. discover source-holding cid (env → /api/v1/dev/source-holding)
//   2. GET /resource → 402 envelope
//   3. POST /api/v1/orders
//   4. POST /api/v1/orders/:id/custodial-sign (v0 demo shortcut)
//   5. POST /api/v1/orders/:id/calldata-signature?wait=true
//      - if 202 (timeout/async) → poll GET /api/v1/orders/:id?wait=true
//   6. GET /api/v1/orders/:id/proof → CantonReceipt
//   7. GET /resource with X-PAYMENT: base64(receipt) → 200 body
//
// The flow is exposed as an async generator so the UI can render each
// transition without holding business logic.

import {
  FacilitatorClient,
  MerchantClient,
  type CalldataSignatureSync,
  type CreateOrderResponse,
} from "./api";
import { discoverSourceHolding } from "./holding";
import { encodeReceiptForHeader, type CantonReceipt } from "./receipt";
import { fetch402, selectCantonDaml, type AcceptEntry } from "./x402";

export type PhaseTag =
  | "READY"
  | "DISCOVERY"
  | "ORDER_CREATED"
  | "SIGNED"
  | "CHECKOUT_VERIFIED"
  | "PAYMENT_CONFIRMED"
  | "RESOURCE_FETCHED"
  | "ERROR";

export interface FlowEvent {
  phase: PhaseTag;
  detail: string;
  order?: CreateOrderResponse;
  status?: string;
  receipt?: CantonReceipt;
  resourceBody?: string;
  error?: string;
}

export interface FlowConfig {
  facilitator: FacilitatorClient;
  merchant: MerchantClient;
  merchantURL: string;
  resourcePath: string;
  payerParty: string;
  sourceHoldingCID: string;
  waitTimeoutMs: number;
  // For tests: a clock-injected delay used between status polls.
  sleep?: (ms: number) => Promise<void>;
  // For tests: limit polling iterations so a flaky backend cannot hang the
  // suite. Default 30 ≈ 30 s with the 1 s default sleep.
  maxPollIterations?: number;
}

const POLL_SLEEP_MS = 1000;
const DEFAULT_MAX_POLLS = 30;
const TERMINAL_FAILURE = new Set(["PAYMENT_FAILED", "EXPIRED", "CANCELLED"]);

export async function* runFlow(
  cfg: FlowConfig,
): AsyncGenerator<FlowEvent, void, void> {
  const sleep = cfg.sleep ?? defaultSleep;
  const maxPolls = cfg.maxPollIterations ?? DEFAULT_MAX_POLLS;

  yield { phase: "DISCOVERY", detail: "resolving source-holding contract id" };

  let sourceHolding: string;
  try {
    sourceHolding = await discoverSourceHolding({
      envCID: cfg.sourceHoldingCID,
      payerParty: cfg.payerParty,
      client: cfg.facilitator,
    });
  } catch (err) {
    yield errorEvent("source-holding discovery failed", err);
    return;
  }

  let envelope: AcceptEntry;
  try {
    const x402 = await fetch402(
      cfg.merchantURL,
      cfg.resourcePath,
      cfg.merchant.fetchImpl,
    );
    envelope = selectCantonDaml(x402);
  } catch (err) {
    yield errorEvent("merchant 402 discovery failed", err);
    return;
  }

  let order: CreateOrderResponse;
  try {
    order = await cfg.facilitator.createOrder({
      x402Version: 1,
      merchant: envelope.payTo,
      payer: cfg.payerParty,
      amount: envelope.amount,
      currency: envelope.currency,
      trustedIssuer: envelope.trustedIssuer,
      resource: envelope.resource,
      merchantRequestId: envelope.merchantRequestId,
      sourceHoldingContractId: sourceHolding,
    });
  } catch (err) {
    yield errorEvent("createOrder failed", err);
    return;
  }
  yield {
    phase: "ORDER_CREATED",
    detail: `order ${order.orderId} created (status=${order.status})`,
    order,
  };

  let signed;
  try {
    signed = await cfg.facilitator.custodialSign(order.orderId);
  } catch (err) {
    yield errorEvent("custodial-sign failed", err);
    return;
  }
  yield {
    phase: "SIGNED",
    detail: `payer signature obtained (scheme=${signed.signatureScheme})`,
    order,
  };

  let receipt: CantonReceipt | null = null;

  let sigResp;
  try {
    sigResp = await cfg.facilitator.submitSignature(
      order.orderId,
      {
        signatureScheme: signed.signatureScheme,
        signature: signed.signature,
        publicKey: signed.publicKey,
      },
      { waitMs: cfg.waitTimeoutMs },
    );
  } catch (err) {
    yield errorEvent("calldata-signature failed", err);
    return;
  }
  if (sigResp.status === "PAYMENT_CONFIRMED") {
    receipt = (sigResp as CalldataSignatureSync).receipt;
  } else {
    yield {
      phase: "CHECKOUT_VERIFIED",
      detail: `order ${order.orderId} status=CHECKOUT_VERIFIED; polling for confirmation`,
      order,
      status: "CHECKOUT_VERIFIED",
    };

    let confirmed = false;
    for (let i = 0; i < maxPolls && !confirmed; i++) {
      let status;
      try {
        status = await cfg.facilitator.getOrder(order.orderId, {
          waitMs: cfg.waitTimeoutMs,
        });
      } catch (err) {
        yield errorEvent("status poll failed", err);
        return;
      }
      if (status.status === "PAYMENT_CONFIRMED") {
        confirmed = true;
        break;
      }
      if (TERMINAL_FAILURE.has(status.status)) {
        yield errorEvent(
          `order entered terminal status ${status.status}`,
          new Error(status.retryLastError ?? status.status),
        );
        return;
      }
      yield {
        phase: "CHECKOUT_VERIFIED",
        detail: `order ${order.orderId} status=${status.status}` +
          (status.retryLastError ? ` (retry=${status.retryLastError})` : ""),
        order,
        status: status.status,
      };
      await sleep(POLL_SLEEP_MS);
    }
    if (!confirmed) {
      yield errorEvent(
        "confirmation timed out",
        new Error(`order ${order.orderId} did not confirm after ${maxPolls} polls`),
      );
      return;
    }
    try {
      receipt = await cfg.facilitator.getProof(order.orderId);
    } catch (err) {
      yield errorEvent("proof fetch failed", err);
      return;
    }
  }

  yield {
    phase: "PAYMENT_CONFIRMED",
    detail: `receipt ready (tx=${receipt.transactionId})`,
    order,
    status: "PAYMENT_CONFIRMED",
    receipt,
  };

  let body: string;
  try {
    body = await cfg.merchant.replay(encodeReceiptForHeader(receipt));
  } catch (err) {
    yield errorEvent("merchant replay failed", err);
    return;
  }

  yield {
    phase: "RESOURCE_FETCHED",
    detail: "merchant unlocked the resource",
    order,
    receipt,
    resourceBody: body,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorEvent(detail: string, err: unknown): FlowEvent {
  const message = err instanceof Error ? err.message : String(err);
  return {
    phase: "ERROR",
    detail,
    error: message,
  };
}
