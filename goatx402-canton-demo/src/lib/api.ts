// api.ts — thin wrappers over the facilitator's HTTP endpoints (PLAN.md §5.1)
// and the merchant's /resource (PLAN.md §5.3). Every facilitator call attaches
// X-Payer-Token: <VITE_PAYER_TOKEN> per Task 13 (resolves round-3 Codex P0 on
// the browser client having no token config path).
//
// All errors surface as ApiError; the caller decides whether the diagnostic
// is shown to the user verbatim or mapped to a friendlier label.

import type { CantonReceipt } from "./receipt";

export interface CreateOrderRequest {
  x402Version: number;
  merchant: string;
  payer: string;
  amount: string;
  currency: string;
  trustedIssuer: string;
  resource: string;
  merchantRequestId: string;
  sourceHoldingContractId: string;
  memo?: string;
  expiresIn?: number;
  clientRequestId?: string;
}

export interface CreateOrderResponse {
  x402Version: number;
  orderId: string;
  nonce: string;
  status: string;
  submissionPayloadHash: string;
  accepts: Array<{
    scheme: string;
    amount: string;
    currency: string;
    payTo: string;
    resource: string;
    expiresAt: number;
    merchantRequestId: string;
    trustedIssuer: string;
    command: {
      templateId: string;
      createArgs: Record<string, unknown>;
      choice: string;
      choiceArgs: Record<string, unknown>;
      dedupId: string;
      submissionPayloadHash: string;
      expiresAtHttp: number;
      expiresAtDaml: number;
    };
  }>;
}

export interface CustodialSignResponse {
  signatureScheme: string;
  signature: string;
  publicKey: string;
}

export interface CalldataSignatureRequest {
  signatureScheme: string;
  signature: string;
  publicKey: string;
}

export interface CalldataSignatureAsync {
  orderId: string;
  status: "CHECKOUT_VERIFIED";
}

export interface CalldataSignatureSync {
  orderId: string;
  status: "PAYMENT_CONFIRMED";
  receipt: CantonReceipt;
}

export interface OrderStatusResponse {
  orderId: string;
  status: string;
  expiresAt: number;
  updatedAt: number;
  retryState?: string;
  retryLastError?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface FacilitatorClientOpts {
  baseURL: string;
  payerToken: string;
  fetchImpl?: typeof fetch;
}

export class FacilitatorClient {
  private readonly baseURL: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FacilitatorClientOpts) {
    if (!opts.baseURL) throw new Error("FacilitatorClient: baseURL required");
    if (!opts.payerToken) {
      // The "Pay with Canton" button refuses to mount the client at all if
      // VITE_PAYER_TOKEN is empty; this guard is the second line of defence
      // for any code path that constructs the client manually.
      throw new Error(
        "FacilitatorClient: payerToken required (set VITE_PAYER_TOKEN in .env.local)",
      );
    }
    this.baseURL = opts.baseURL;
    this.headers = {
      "Content-Type": "application/json",
      "X-Payer-Token": opts.payerToken,
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.json<CreateOrderResponse>("POST", "/api/v1/orders", req);
  }

  async custodialSign(orderID: string): Promise<CustodialSignResponse> {
    return this.json<CustodialSignResponse>(
      "POST",
      `/api/v1/orders/${encodeURIComponent(orderID)}/custodial-sign`,
      {},
    );
  }

  async submitSignature(
    orderID: string,
    req: CalldataSignatureRequest,
    opts: { waitMs?: number } = {},
  ): Promise<CalldataSignatureAsync | CalldataSignatureSync> {
    const wait = opts.waitMs && opts.waitMs > 0;
    const qs = wait ? `?wait=true&timeoutMs=${opts.waitMs}` : "";
    const path = `/api/v1/orders/${encodeURIComponent(orderID)}/calldata-signature${qs}`;
    return this.json<CalldataSignatureAsync | CalldataSignatureSync>(
      "POST",
      path,
      req,
    );
  }

  async getOrder(
    orderID: string,
    opts: { waitMs?: number } = {},
  ): Promise<OrderStatusResponse> {
    const wait = opts.waitMs && opts.waitMs > 0;
    const qs = wait ? `?wait=true&timeoutMs=${opts.waitMs}` : "";
    return this.json<OrderStatusResponse>(
      "GET",
      `/api/v1/orders/${encodeURIComponent(orderID)}${qs}`,
    );
  }

  async getProof(orderID: string): Promise<CantonReceipt> {
    return this.json<CantonReceipt>(
      "GET",
      `/api/v1/orders/${encodeURIComponent(orderID)}/proof`,
    );
  }

  async getSourceHolding(payer: string): Promise<string> {
    const path = `/api/v1/dev/source-holding?payer=${encodeURIComponent(payer)}`;
    const body = await this.json<{ payer: string; sourceHoldingContractId: string }>(
      "GET",
      path,
    );
    return body.sourceHoldingContractId;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers,
    };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    const resp = await this.fetchImpl(this.baseURL + path, init);
    if (!resp.ok) {
      // Facilitator emits canonical errors as
      //   { "error": { "code": "...", "message": "..." } }
      // — see internal/api/errors.go.
      let code = "UNKNOWN";
      let message = `${method} ${path} → ${resp.status}`;
      try {
        const err = (await resp.json()) as { error?: { code?: string; message?: string } };
        if (err && err.error) {
          code = err.error.code ?? code;
          message = err.error.message ?? message;
        }
      } catch {
        // Body wasn't JSON; keep the status-derived message.
      }
      throw new ApiError(resp.status, code, message);
    }
    return (await resp.json()) as T;
  }
}

// MerchantClient wraps the merchant's /resource: a single GET/POST handler
// that returns 402 without X-PAYMENT and the protected content with a valid
// receipt.
export interface MerchantClientOpts {
  baseURL: string;
  resourcePath: string;
  fetchImpl?: typeof fetch;
}

export class MerchantClient {
  private readonly url: string;
  readonly fetchImpl: typeof fetch;
  constructor(opts: MerchantClientOpts) {
    this.url = opts.baseURL + opts.resourcePath;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async replay(encodedReceipt: string): Promise<string> {
    const resp = await this.fetchImpl(this.url, {
      method: "GET",
      headers: { "X-PAYMENT": encodedReceipt },
    });
    if (!resp.ok) {
      let code = "UNKNOWN";
      let message = `GET resource → ${resp.status}`;
      try {
        const err = (await resp.json()) as { error?: { code?: string; message?: string } };
        if (err && err.error) {
          code = err.error.code ?? code;
          message = err.error.message ?? message;
        }
      } catch {
        // text body OK below
      }
      throw new ApiError(resp.status, code, message);
    }
    return resp.text();
  }
}
