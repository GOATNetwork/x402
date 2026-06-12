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
