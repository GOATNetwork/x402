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

// QuickPayManifestProduct is one merchant fixed-price item on the x402 rail. It is
// TOKEN-AGNOSTIC: it carries a decimal `price` (e.g. "9.99") plus display metadata
// under a merchant-chosen `product_key`. The buyer picks the chain + token from
// rails.x402.tokens at checkout; the on-chain amount = price * 10^token_decimals is
// computed (server-authoritative, and re-derived client-side for verification).
export interface QuickPayManifestProduct {
  product_key: string
  name: string
  description?: string
  image_url?: string
  price: string
}

export interface QuickPayManifest {
  schema: string
  merchant: { merchant_id: string; display_name?: string; logo_url?: string }
  links?: Record<string, string>
  rails: {
    x402: { enabled: boolean; custom_amount?: boolean; memo_required?: boolean; session_endpoint?: string; tokens: QuickPayManifestToken[]; products?: QuickPayManifestProduct[] }
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
