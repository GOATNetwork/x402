// readEnv normalises the build-time bindings the SPA needs. Vite exposes them
// on `import.meta.env`; we collect them here so the rest of the SPA can treat
// the config as a single immutable record (PLAN.md §3.2.5 + Task 13).
//
// VITE_PAYER_TOKEN is the LOCALNET-ONLY X-Payer-Token binding (Task 13 — the
// build artefact is gitignored when produced from a .env.local containing the
// token; production browsers obtain tokens via an out-of-band flow).
export interface ClientEnv {
  readonly facilitatorURL: string;
  readonly merchantURL: string;
  readonly resourcePath: string;
  readonly payerParty: string;
  readonly payerToken: string;
  readonly sourceHoldingContractID: string;
  readonly waitTimeoutMs: number;
}

interface RawEnv {
  VITE_FACILITATOR_URL?: string;
  VITE_MERCHANT_URL?: string;
  VITE_RESOURCE_PATH?: string;
  VITE_PAYER_PARTY?: string;
  VITE_PAYER_TOKEN?: string;
  VITE_SOURCE_HOLDING_CID?: string;
  VITE_WAIT_TIMEOUT_MS?: string;
}

export function readEnv(raw: RawEnv | undefined): ClientEnv {
  const r = raw ?? {};
  return Object.freeze({
    facilitatorURL: trimTrailingSlash(r.VITE_FACILITATOR_URL ?? "http://localhost:8080"),
    merchantURL: trimTrailingSlash(r.VITE_MERCHANT_URL ?? "http://localhost:7070"),
    resourcePath: r.VITE_RESOURCE_PATH ?? "/resource",
    payerParty: r.VITE_PAYER_PARTY ?? "",
    payerToken: r.VITE_PAYER_TOKEN ?? "",
    sourceHoldingContractID: r.VITE_SOURCE_HOLDING_CID ?? "",
    waitTimeoutMs: parsePositiveInt(r.VITE_WAIT_TIMEOUT_MS, 5000),
  });
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
