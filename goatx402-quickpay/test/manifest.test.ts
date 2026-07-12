import { describe, it, expect } from 'vitest'
import { deriveTarget, validateManifest, endpoints, loadManifest } from '../src/manifest.js'
import { jsonResponse, recordingFetch } from './helpers.js'

const MAN = {
  schema: 'goatx402.quickpay.v1',
  merchant: { merchant_id: 'acme', display_name: 'ACME' },
  links: { api_base: 'https://evil.example/quickpay/v1' },
  rails: {
    x402: {
      enabled: true,
      session_endpoint: 'https://evil.example/x402/sessions',
      tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xabc', decimals: 6, min_amount_wei: '1000000' }],
    },
    mpp: { enabled: false, routes: [] },
  },
}

describe('deriveTarget', () => {
  it('web URL -> manifest.json + origin + merchant_id', () => {
    expect(deriveTarget('https://pay.goat.network/quickpay/acme')).toEqual({
      origin: 'https://pay.goat.network',
      merchantId: 'acme',
      manifestUrl: 'https://pay.goat.network/quickpay/acme/manifest.json',
    })
  })
  it('agent.md URL -> manifest.json', () => {
    expect(deriveTarget('https://pay.goat.network/quickpay/acme/agent.md').manifestUrl).toBe(
      'https://pay.goat.network/quickpay/acme/manifest.json',
    )
  })
  it('manifest.json URL passes through', () => {
    expect(deriveTarget('https://pay.goat.network/quickpay/acme/manifest.json').manifestUrl).toBe(
      'https://pay.goat.network/quickpay/acme/manifest.json',
    )
  })
  it('rejects non-http(s)', () => {
    expect(() => deriveTarget('ftp://x/quickpay/a')).toThrow()
  })
  it('rejects plaintext http for a remote host (MITM could redirect funds)', () => {
    expect(() => deriveTarget('http://pay.goat.network/quickpay/acme')).toThrow(/https/)
  })
  it('allows plaintext http only for loopback (local dev)', () => {
    expect(deriveTarget('http://localhost:8080/quickpay/acme').origin).toBe('http://localhost:8080')
    expect(deriveTarget('http://127.0.0.1:8080/quickpay/acme').merchantId).toBe('acme')
  })
  it('rejects non-/quickpay path', () => {
    expect(() => deriveTarget('https://x/foo/bar')).toThrow(/quickpay/)
  })
  it('rejects quickpay not as the first path segment', () => {
    expect(() => deriveTarget('https://x/foo/quickpay/acme')).toThrow()
  })
  it('rejects extra path segments', () => {
    expect(() => deriveTarget('https://x/quickpay/acme/extra')).toThrow()
  })
  it('rejects an encoded-slash merchant id', () => {
    expect(() => deriveTarget('https://x/quickpay/a%2Fb')).toThrow()
  })
  it('rejects a userinfo component', () => {
    expect(() => deriveTarget('https://user@evil.example/quickpay/acme')).toThrow(/userinfo/)
  })
})

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(validateManifest(MAN).merchant.merchant_id).toBe('acme')
  })
  it('rejects an unknown schema', () => {
    expect(() => validateManifest({ ...MAN, schema: 'other' })).toThrow(/schema/)
  })
  it('rejects a missing merchant_id', () => {
    expect(() => validateManifest({ schema: 'goatx402.quickpay.v1', rails: {} })).toThrow(/merchant/)
  })
  it('normalizes missing rails arrays', () => {
    const m = validateManifest({ schema: 'goatx402.quickpay.v1', merchant: { merchant_id: 'a' }, rails: {} })
    expect(m.rails.x402.tokens).toEqual([])
    expect(m.rails.mpp.routes).toEqual([])
  })
  it('rejects a malformed x402 token (bad decimals) when the rail is enabled', () => {
    const bad = {
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { x402: { enabled: true, tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xT', decimals: -1, min_amount_wei: '1' }] } },
    }
    expect(() => validateManifest(bad)).toThrow(/decimals/)
  })
  it('rejects an x402 token with a non-integer min_amount_wei', () => {
    const bad = {
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { x402: { enabled: true, tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xT', decimals: 6, min_amount_wei: '1.5' }] } },
    }
    expect(() => validateManifest(bad)).toThrow(/min_amount_wei/)
  })
  it('does not validate tokens when the x402 rail is disabled', () => {
    const m = validateManifest({
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { x402: { enabled: false, tokens: [{ decimals: 'nope' }] } },
    })
    expect(m.rails.x402.enabled).toBe(false)
  })
  it('rejects an x402 token whose max_amount_wei is below min_amount_wei', () => {
    const bad = {
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { x402: { enabled: true, tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xT', decimals: 6, min_amount_wei: '1000000', max_amount_wei: '999999' }] } },
    }
    expect(() => validateManifest(bad)).toThrow(/max_amount_wei must be >= min_amount_wei/)
  })
  it('rejects a malformed MPP route (bad chain_id) when the rail is enabled', () => {
    const bad = {
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { mpp: { enabled: true, routes: [{ route_canonical: 'GET:api:data', chain_id: 0, token_symbol: 'USDC', amount_wei: '1000000' }] } },
    }
    expect(() => validateManifest(bad)).toThrow(/chain_id/)
  })
  it('accepts a valid MPP route and preserves it', () => {
    const m = validateManifest({
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { mpp: { enabled: true, routes: [{ route_canonical: 'GET:api:data', chain_id: 4217, token_symbol: 'USDC', amount_wei: '1000000' }] } },
    })
    expect(m.rails.mpp.routes).toHaveLength(1)
    expect(m.rails.mpp.routes[0].route_canonical).toBe('GET:api:data')
  })
  it('does not validate MPP routes when the rail is disabled', () => {
    const m = validateManifest({
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { mpp: { enabled: false, routes: [{ chain_id: 'nope' }] } },
    })
    expect(m.rails.mpp.enabled).toBe(false)
  })

  const withProducts = (products: unknown[]) => ({
    schema: 'goatx402.quickpay.v1',
    merchant: { merchant_id: 'acme' },
    rails: {
      x402: {
        enabled: true,
        tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xabc', decimals: 6, min_amount_wei: '1000000' }],
        products,
      },
    },
  })

  it('accepts valid products and preserves them', () => {
    const m = validateManifest(withProducts([{ product_key: 'mug', name: 'Coffee Mug', price: '9.99', image_url: 'https://x/m.png' }]))
    expect(m.rails.x402.products).toHaveLength(1)
    expect(m.rails.x402.products?.[0].product_key).toBe('mug')
  })
  it('normalizes a missing products array to []', () => {
    const m = validateManifest({ schema: 'goatx402.quickpay.v1', merchant: { merchant_id: 'a' }, rails: {} })
    expect(m.rails.x402.products).toEqual([])
  })
  it('rejects a present-but-non-array products (malformed manifest, not "no products")', () => {
    expect(() => validateManifest({ schema: 'goatx402.quickpay.v1', merchant: { merchant_id: 'a' }, rails: { x402: { enabled: true, tokens: [], products: 'bad' } } })).toThrow(/products must be an array/)
    expect(() => validateManifest({ schema: 'goatx402.quickpay.v1', merchant: { merchant_id: 'a' }, rails: { x402: { enabled: false, tokens: [], products: { product_key: 'x' } } } })).toThrow(/products must be an array/)
    expect(() => validateManifest({ schema: 'goatx402.quickpay.v1', merchant: { merchant_id: 'a' }, rails: { x402: { enabled: true, tokens: [], products: null } } })).toThrow(/products must be an array/)
  })
  it('rejects a product with a malformed product_key', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'bad key', name: 'X', price: '1' }]))).toThrow(/product_key/)
  })
  it("rejects a product_key of '.'", () => {
    expect(() => validateManifest(withProducts([{ product_key: '.', name: 'X', price: '1' }]))).toThrow(/product_key/)
  })
  it('rejects a product with an empty name', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: '  ', price: '1' }]))).toThrow(/name/)
  })
  it('rejects a product with a non-positive / malformed price', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '0' }]))).toThrow(/price/)
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '0.00' }]))).toThrow(/price/)
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1.2.3' }]))).toThrow(/price/)
  })
  it("rejects a price exceeding core's integer/fractional digit bounds", () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1'.repeat(41) }]))).toThrow(/price/)
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1.' + '0'.repeat(18) + '1' }]))).toThrow(/price/)
  })
  it('rejects a product with a non-string description', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', description: {} }]))).toThrow(/description/)
  })
  it('rejects a product with an over-long description', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', description: 'a'.repeat(2001) }]))).toThrow(/description/)
  })
  it('rejects a product with a non-https image_url', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', image_url: 'http://x/m.png' }]))).toThrow(/image_url/)
  })
  it('rejects a product whose image_url is a bare scheme / hostless / unparseable https value', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', image_url: 'https://' }]))).toThrow(/image_url/)
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', image_url: 'https://not a url' }]))).toThrow(/image_url/)
  })
  it('rejects a product whose image_url embeds credentials', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', image_url: 'https://user:pass@x/m.png' }]))).toThrow(/image_url/)
  })
  it('rejects a product whose image_url exceeds the length bound', () => {
    expect(() => validateManifest(withProducts([{ product_key: 'k', name: 'X', price: '1', image_url: 'https://x/' + 'a'.repeat(2050) }]))).toThrow(/image_url/)
  })
  it('validates products even when the x402 rail is disabled (fail closed on a malformed product)', () => {
    // Products are surfaced by inspect and read by payProduct's recovery path regardless of
    // enabled, so a malformed product must be rejected on ingest, not passed through.
    expect(() =>
      validateManifest({
        schema: 'goatx402.quickpay.v1',
        merchant: { merchant_id: 'acme' },
        rails: { x402: { enabled: false, tokens: [], products: [{ product_key: 'bad key', name: '', price: 'x' }] } },
      }),
    ).toThrow(/product_key|name|price/)
  })
  it('accepts a well-formed product on a disabled rail (only malformed ones fail)', () => {
    const m = validateManifest({
      schema: 'goatx402.quickpay.v1',
      merchant: { merchant_id: 'acme' },
      rails: { x402: { enabled: false, tokens: [], products: [{ product_key: 'mug', name: 'Mug', price: '9.99' }] } },
    })
    expect(m.rails.x402.enabled).toBe(false)
    expect(m.rails.x402.products?.[0].product_key).toBe('mug')
  })
})

describe('endpoints (trust anchor)', () => {
  it('derives all endpoints from the origin only', () => {
    const ep = endpoints('https://pay.goat.network')
    expect(ep.sessionCreate).toBe('https://pay.goat.network/quickpay/v1/x402/sessions')
    expect(ep.sessionStatus('s1')).toBe('https://pay.goat.network/quickpay/v1/x402/sessions/s1')
    expect(ep.mppCoreUrl).toBe('https://pay.goat.network')
  })
})

describe('loadManifest', () => {
  it('fetches the same-origin manifest.json and returns the trusted origin', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(MAN))
    const r = await loadManifest('https://pay.goat.network/quickpay/acme/agent.md', fetch)
    expect(r.origin).toBe('https://pay.goat.network')
    expect(r.merchantId).toBe('acme')
    expect(calls[0].url).toBe('https://pay.goat.network/quickpay/acme/manifest.json')
  })
  it('fails closed when manifest merchant_id != URL merchant_id', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ ...MAN, merchant: { merchant_id: 'attacker' } }))
    await expect(loadManifest('https://pay.goat.network/quickpay/acme', fetch)).rejects.toThrow(/trust anchor/)
  })
  it('throws on non-200', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({}, 404))
    await expect(loadManifest('https://pay.goat.network/quickpay/acme', fetch)).rejects.toThrow(/HTTP 404/)
  })
})
