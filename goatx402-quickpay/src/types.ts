// Machine-readable QuickPay manifest (schema goatx402.quickpay.v1), as produced
// by goatx402-core's GET /quickpay/:merchant_id/manifest.json.

export interface QuickPayManifestToken {
  chain_id: number
  chain_name?: string
  token_symbol: string
  token_contract: string
  decimals: number
  min_amount_wei: string
  max_amount_wei?: string
}

export interface QuickPayManifestRoute {
  route_canonical: string
  route_pricing_version?: number
  chain_id: number
  token_symbol: string
  token_decimals?: number
  token_contract?: string
  amount_wei: string
}

export interface QuickPayManifest {
  schema: string
  merchant: { merchant_id: string; display_name?: string; logo_url?: string }
  links?: Record<string, string>
  rails: {
    x402: { enabled: boolean; custom_amount?: boolean; memo_required?: boolean; session_endpoint?: string; tokens: QuickPayManifestToken[] }
    mpp: { enabled: boolean; challenge_endpoint?: string; verify_endpoint?: string; routes: QuickPayManifestRoute[] }
  }
}

// A QuickPay link resolved into its trusted origin + the manifest URL + the
// merchant_id taken from the (trusted) URL path.
export interface Target {
  manifestUrl: string
  origin: string
  merchantId: string
}

// Result of fetching + validating a manifest against its trusted origin.
export interface LoadedManifest {
  manifest: QuickPayManifest
  origin: string
  merchantId: string
}
