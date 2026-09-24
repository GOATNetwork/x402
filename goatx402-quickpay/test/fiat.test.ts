import { describe, expect, it } from 'vitest'
import { createFiatCheckoutLink } from '../src/fiat.js'
import { jsonResponse, recordingFetch } from './helpers.js'

const MAN = {
  schema: 'goatx402.quickpay.v1',
  merchant: { merchant_id: 'acme', display_name: 'ACME' },
  rails: {
    x402: { enabled: false, tokens: [], products: [] },
    mpp: { enabled: false, routes: [] },
    fiat: {
      enabled: true,
      custom_amount: true,
      memo_required: true,
      human_action_required: true,
      // Deliberately malicious: callers must derive the endpoint from the input origin.
      session_endpoint: 'https://evil.example/steal',
      currency: 'USD',
      minor_unit_exponent: 2,
      products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }],
    },
  },
}

function successFetch() {
  return recordingFetch((url) => {
    if (url.endsWith('/manifest.json')) return jsonResponse(MAN)
    if (url.endsWith('/quickpay/v1/fiat/sessions')) {
      return jsonResponse({
        checkout_id: 'cs_card_1',
        url: 'https://pay.goat.network/checkout/direct?cs=cs_card_1',
        currency: 'USD',
        expires_at: 1893456000,
      })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
}

describe('createFiatCheckoutLink', () => {
  it('creates a product checkout on the trusted origin without card credentials', async () => {
    const { fetch, calls } = successFetch()
    const out = await createFiatCheckoutLink({
      input: 'https://pay.goat.network/quickpay/acme/agent.md',
      productKey: 'mug',
      fetchImpl: fetch,
    })

    expect(out).toEqual({
      ok: true,
      rail: 'fiat',
      merchant_id: 'acme',
      checkout_id: 'cs_card_1',
      url: 'https://pay.goat.network/checkout/direct?cs=cs_card_1',
      currency: 'USD',
      expires_at: 1893456000,
      product_key: 'mug',
      human_action_required: true,
    })
    expect(calls[1].url).toBe('https://pay.goat.network/quickpay/v1/fiat/sessions')
    expect(calls[1].url).not.toContain('evil.example')
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ merchant_id: 'acme', product_key: 'mug' })
  })

  it('creates a custom-amount link and forwards only amount plus memo', async () => {
    const { fetch, calls } = successFetch()
    const out = await createFiatCheckoutLink({
      input: 'https://pay.goat.network/quickpay/acme',
      amount: '12.50',
      memo: 'invoice-1001',
      fetchImpl: fetch,
    })
    expect(out.product_key).toBeUndefined()
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      merchant_id: 'acme',
      amount: '12.50',
      memo: 'invoice-1001',
    })
  })

  it('requires exactly one intent and never accepts a product memo', async () => {
    const { fetch } = successFetch()
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', fetchImpl: fetch })).rejects.toThrow(/exactly one/)
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', amount: '1', fetchImpl: fetch })).rejects.toThrow(/exactly one/)
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', memo: 'forged', fetchImpl: fetch })).rejects.toThrow(/does not accept memo/)
  })

  it('preflights memo and currency precision for custom amounts', async () => {
    const { fetch } = successFetch()
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', fetchImpl: fetch })).rejects.toThrow(/requires a memo/)
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', amount: '1.001', memo: 'x', fetchImpl: fetch })).rejects.toThrow(/at most 2 decimal/)
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', amount: '0.00', memo: 'x', fetchImpl: fetch })).rejects.toThrow(/positive/)
  })

  it('requires the product to be advertised on the card rail', async () => {
    const { fetch } = successFetch()
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'crypto-only', fetchImpl: fetch })).rejects.toThrow(/not available on the card rail/)
  })

  it('rejects an unavailable fiat rail', async () => {
    const disabled = { ...MAN, rails: { ...MAN.rails, fiat: { enabled: false, products: [] } } }
    const { fetch } = recordingFetch(() => jsonResponse(disabled))
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', fetchImpl: fetch })).rejects.toThrow(/not available/)
  })

  it('accepts the current PayKit hosted path and the legacy checkout paths', async () => {
    for (const url of [
      'https://pay.goat.network/paykit/direct?cs=cs_card_1',
      'https://pay.goat.network/paykit/direct/?cs=cs_card_1',
      'https://pay.goat.network/checkout?cs=cs_card_1',
      'https://pay.goat.network/checkout/direct?cs=cs_card_1',
    ]) {
      const { fetch } = recordingFetch((requestURL) =>
        requestURL.endsWith('/manifest.json')
          ? jsonResponse(MAN)
          : jsonResponse({ checkout_id: 'cs_card_1', url, currency: 'USD', expires_at: 1893456000 }),
      )
      const out = await createFiatCheckoutLink({
        input: 'https://pay.goat.network/quickpay/acme',
        productKey: 'mug',
        fetchImpl: fetch,
      })
      expect(out.url).toBe(url)
      expect(out.checkout_id).toBe('cs_card_1')
    }
  })

  it('rejects a checkout URL outside the trusted origin or without the matching handle', async () => {
    for (const url of [
      'https://evil.example/checkout/direct?cs=cs_card_1',
      'https://pay.goat.network/checkout/direct?cs=other',
      'https://pay.goat.network/not-checkout?cs=cs_card_1',
      'https://pay.goat.network/paykit/delegate?cs=cs_card_1',
    ]) {
      const { fetch } = recordingFetch((requestURL) =>
        requestURL.endsWith('/manifest.json')
          ? jsonResponse(MAN)
          : jsonResponse({ checkout_id: 'cs_card_1', url, currency: 'USD', expires_at: 1893456000 }),
      )
      await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', fetchImpl: fetch })).rejects.toThrow(/trusted|expected/)
    }
  })

  it('rejects a session response that a fetch implementation followed off-origin', async () => {
    const { fetch } = recordingFetch((url) => {
      if (url.endsWith('/manifest.json')) return jsonResponse(MAN)
      const response = jsonResponse({
        checkout_id: 'cs_card_1',
        url: 'https://pay.goat.network/checkout/direct?cs=cs_card_1',
        currency: 'USD',
        expires_at: 1893456000,
      })
      Object.defineProperty(response, 'url', { value: 'https://evil.example/redirected' })
      return response
    })

    await expect(createFiatCheckoutLink({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      fetchImpl: fetch,
    })).rejects.toThrow(/redirected off-origin/)
  })

  it('rejects response terms that disagree with the trusted manifest', async () => {
    const { fetch } = recordingFetch((url) =>
      url.endsWith('/manifest.json')
        ? jsonResponse(MAN)
        : jsonResponse({
            checkout_id: 'cs_card_1',
            url: 'https://pay.goat.network/checkout/direct?cs=cs_card_1',
            currency: 'HKD',
            expires_at: 1893456000,
          }),
    )

    await expect(createFiatCheckoutLink({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      fetchImpl: fetch,
    })).rejects.toThrow(/currency does not match/)
  })

  it('surfaces a controlled server error without mistaking it for a link', async () => {
    const { fetch } = recordingFetch((url) =>
      url.endsWith('/manifest.json') ? jsonResponse(MAN) : jsonResponse({ error: 'card payments unavailable' }, 409),
    )
    await expect(createFiatCheckoutLink({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', fetchImpl: fetch })).rejects.toThrow(/HTTP 409.*unavailable/)
  })
})
