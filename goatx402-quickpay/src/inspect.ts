import { loadManifest } from './manifest.js'

export interface InspectResult {
  merchant_id: string
  origin: string
  display_name: string
  x402_enabled: boolean
  x402_tokens: Array<{
    chain_id: number
    token_symbol: string
    token_contract: string
    decimals: number
    min_amount_wei: string
    max_amount_wei?: string
  }>
  x402_products: Array<{
    product_key: string
    name: string
    price: string
    description?: string
    image_url?: string
  }>
  mpp_enabled: boolean
  mpp_routes: Array<{
    route_canonical: string
    token_symbol: string
    chain_id: number
    amount_wei: string
  }>
}

/** inspect resolves a QuickPay link to a structured capability summary. */
export async function inspect(input: string, fetchImpl: typeof fetch = fetch): Promise<InspectResult> {
  const { manifest, origin, merchantId } = await loadManifest(input, fetchImpl)
  const x402 = manifest.rails.x402
  const mpp = manifest.rails.mpp
  return {
    merchant_id: merchantId,
    origin,
    display_name: manifest.merchant.display_name ?? '',
    x402_enabled: x402.enabled,
    x402_tokens: x402.tokens.map((t) => ({
      chain_id: t.chain_id,
      token_symbol: t.token_symbol,
      token_contract: t.token_contract,
      decimals: t.decimals,
      min_amount_wei: t.min_amount_wei,
      max_amount_wei: t.max_amount_wei,
    })),
    x402_products: (x402.products ?? []).map((p) => ({
      product_key: p.product_key,
      name: p.name,
      price: p.price,
      description: p.description,
      image_url: p.image_url,
    })),
    mpp_enabled: mpp.enabled,
    mpp_routes: mpp.routes.map((r) => ({
      route_canonical: r.route_canonical,
      token_symbol: r.token_symbol,
      chain_id: r.chain_id,
      amount_wei: r.amount_wei,
    })),
  }
}
