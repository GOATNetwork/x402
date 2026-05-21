// x402 envelope discovery + accepts selection (PLAN.md §5.3 + §6.9).
//
// The merchant returns `402 Payment Required` with a JSON body of shape:
//   {
//     "x402Version": 1,
//     "accepts": [{ scheme, amount, currency, trustedIssuer, payTo,
//                   facilitator, resource, merchantRequestId }],
//     "error": "payment_required"
//   }
// The SPA picks the first `canton-daml` entry; we keep selection logic
// deliberately small so the browser flow mirrors client-cli.

export interface AcceptEntry {
  scheme: string;
  amount: string;
  currency: string;
  trustedIssuer: string;
  payTo: string;
  facilitator: string;
  resource: string;
  merchantRequestId: string;
}

export interface X402Envelope {
  x402Version: number;
  accepts: AcceptEntry[];
  error?: string;
}

export class X402DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402DiscoveryError";
  }
}

// fetch402 calls the merchant `/resource` without `X-PAYMENT`. Returns the
// parsed envelope if the status is 402, throws otherwise (the merchant must
// challenge before we can pay).
export async function fetch402(
  merchantURL: string,
  resourcePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<X402Envelope> {
  const url = merchantURL + resourcePath;
  const resp = await fetchImpl(url, { method: "GET" });
  if (resp.status !== 402) {
    throw new X402DiscoveryError(
      `expected 402 from ${url}, got ${resp.status}`,
    );
  }
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    throw new X402DiscoveryError(
      `402 response from ${url} is not JSON (content-type=${ct})`,
    );
  }
  const body = (await resp.json()) as X402Envelope;
  if (!body || !Array.isArray(body.accepts)) {
    throw new X402DiscoveryError("402 envelope missing accepts[]");
  }
  return body;
}

// selectCantonDaml returns the first accepts entry whose scheme is
// "canton-daml". Throws if none are present — the SPA only knows how to pay
// over Canton.
export function selectCantonDaml(env: X402Envelope): AcceptEntry {
  const entry = env.accepts.find((a) => a.scheme === "canton-daml");
  if (!entry) {
    throw new X402DiscoveryError(
      "402 envelope has no canton-daml accepts entry",
    );
  }
  if (!entry.merchantRequestId) {
    throw new X402DiscoveryError(
      "canton-daml accepts entry missing merchantRequestId",
    );
  }
  if (!entry.payTo || !entry.amount || !entry.currency || !entry.trustedIssuer) {
    throw new X402DiscoveryError(
      "canton-daml accepts entry missing required fields",
    );
  }
  return entry;
}
