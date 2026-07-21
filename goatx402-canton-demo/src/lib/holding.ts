// holding.ts — source-holding contract-id discovery for the SPA
// (PLAN.md §3.2.5: env first, then GET /api/v1/dev/source-holding fallback).
//
// Precedence (resolves cross-review P1 on missing browser source-holding
// wiring):
//   1. VITE_SOURCE_HOLDING_CID (build-time env, already exposed via ClientEnv)
//   2. GET /api/v1/dev/source-holding?payer=<partyId> on the facilitator
// If both are absent the demo button is disabled with an inline error
// pointing at the operator handbook (Task 13 acceptance).

import { ApiError, type FacilitatorClient } from "./api";

export class MissingSourceHoldingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSourceHoldingError";
  }
}

export interface DiscoverSourceHoldingArgs {
  envCID: string;
  payerParty: string;
  client: FacilitatorClient;
}

// discoverSourceHolding resolves the source-holding contract id.
// Returns the cid string on success.
export async function discoverSourceHolding(
  args: DiscoverSourceHoldingArgs,
): Promise<string> {
  const fromEnv = args.envCID.trim();
  if (fromEnv) return fromEnv;
  if (!args.payerParty) {
    throw new MissingSourceHoldingError(
      "VITE_SOURCE_HOLDING_CID empty and VITE_PAYER_PARTY unset; cannot call dev fallback",
    );
  }
  try {
    const cid = await args.client.getSourceHolding(args.payerParty);
    if (!cid) {
      throw new MissingSourceHoldingError(
        `dev/source-holding returned empty cid for payer=${args.payerParty}`,
      );
    }
    return cid;
  } catch (err) {
    if (err instanceof ApiError) {
      // 410 → endpoint retired under CANTON_PROD=true; 404 → no fixture entry.
      throw new MissingSourceHoldingError(
        `dev/source-holding returned ${err.status} ${err.code}: ${err.message}`,
      );
    }
    if (err instanceof MissingSourceHoldingError) throw err;
    throw new MissingSourceHoldingError(
      `dev/source-holding fetch failed: ${(err as Error).message}`,
    );
  }
}
