import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { GoatFlowClient } from '../src/client.js'

const API_KEY = 'test-key'
const API_SECRET = 'test-secret'
const BASE_URL = 'https://api.example.com'

/**
 * Mirror the core HMAC scheme (goatx402-core/internal/api/signature.go):
 * sort non-empty params by key, join as `k=v&...`, HMAC-SHA256 hex. The caller
 * passes already-stringified body params plus api_key/timestamp/nonce.
 */
function serverSign(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== '')
    .sort()
  const signStr = keys.map((k) => `${k}=${params[k]}`).join('&')
  return createHmac('sha256', secret).update(signStr).digest('hex')
}

function mockFetch(responseBody: unknown) {
  const captured: { url?: string; init?: RequestInit } = {}
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    captured.url = url
    captured.init = init
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { captured, fetchMock }
}

function client() {
  return new GoatFlowClient({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET })
}

// Every signed param must be a top-level scalar (the HMAC scheme cannot sign nested
// JSON), and X-Sign must match a server-side recomputation over body + auth params.
function assertSignedScalars(captured: { url?: string; init?: RequestInit }) {
  const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>
  for (const [k, v] of Object.entries(body)) {
    expect(['string', 'number', 'boolean'], `param ${k} must be a scalar`).toContain(typeof v)
  }
  const headers = captured.init?.headers as Record<string, string>
  expect(headers['X-API-Key']).toBe(API_KEY)
  expect(headers['X-Sign']).toBeTruthy()
  const expected: Record<string, string> = {}
  for (const [k, v] of Object.entries(body)) expected[k] = String(v)
  expected.api_key = API_KEY
  expected.timestamp = headers['X-Timestamp']
  expected.nonce = headers['X-Nonce']
  expect(headers['X-Sign']).toBe(serverSign(expected, API_SECRET))
  return body
}

describe('createCheckoutSession (unified)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('DIRECT: posts the unified endpoint with a token-agnostic price + JSON-string nested fields', async () => {
    const { captured, fetchMock } = mockFetch({
      checkout_id: 'cs_abc',
      checkout_type: 'DIRECT',
      url: 'https://pay.example.com/checkout?cs=cs_abc',
      expires_at: 1893456000,
    })

    const res = await client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '9.99',
      clientReferenceId: 'ref-1',
      lineItems: [{ name: 'Mug', amount: '9.99', quantity: 1 }],
      publicMetadata: { cart: 'c1' },
    })

    expect(res).toEqual({
      checkoutId: 'cs_abc',
      checkoutType: 'DIRECT',
      url: 'https://pay.example.com/checkout?cs=cs_abc',
      expiresAt: 1893456000,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(captured.url).toBe(`${BASE_URL}/api/v1/checkout/sessions`)
    expect(captured.init?.method).toBe('POST')

    const body = assertSignedScalars(captured)
    expect(body.checkout_type).toBe('DIRECT')
    expect(body.price).toBe('9.99')
    expect(body.client_reference_id).toBe('ref-1')
    // Nested values ride as JSON STRINGS (signable).
    expect(body.line_items_json).toBe(JSON.stringify([{ name: 'Mug', amount: '9.99', quantity: 1 }]))
    expect(body.public_metadata_json).toBe(JSON.stringify({ cart: 'c1' }))
  })

  it('DELEGATE: acceptable_tokens rides as a JSON-string array', async () => {
    const { captured } = mockFetch({
      checkout_id: 'cs_d',
      checkout_type: 'DELEGATE',
      url: 'u',
      expires_at: 1,
    })
    await client().createCheckoutSession({
      checkoutType: 'DELEGATE',
      chainId: 56,
      fixedAmountWei: '1000000',
      callbackCalldata: '0xdeadbeef',
      acceptableTokens: ['0xA', '0xB'],
    })
    const body = assertSignedScalars(captured)
    expect(body.checkout_type).toBe('DELEGATE')
    expect(body.chain_id).toBe(56)
    expect(body.fixed_amount_wei).toBe('1000000')
    expect(body.acceptable_tokens).toBe(JSON.stringify(['0xA', '0xB']))
  })
})

describe('createDelegateCheckoutSession (deprecated wrapper)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('forwards to the unified endpoint, wrapping the single tokenContract + mapping amountWei', async () => {
    const { captured, fetchMock } = mockFetch({
      checkout_id: 'cs_abc',
      checkout_type: 'DELEGATE',
      url: 'https://pay.example.com/checkout?cs=cs_abc',
      expires_at: 1893456000,
    })

    const res = await client().createDelegateCheckoutSession({
      chainId: 56,
      tokenContract: '0xToken',
      amountWei: '1000000',
      callbackCalldata: '0xdeadbeef',
      successUrl: 'https://shop.example.com/ok',
      cancelUrl: 'https://shop.example.com/cancel',
      clientReferenceId: 'ref-1',
      expiresIn: 1800,
    })

    // Deprecated shape maps checkout_id -> handle.
    expect(res).toEqual({
      handle: 'cs_abc',
      url: 'https://pay.example.com/checkout?cs=cs_abc',
      expiresAt: 1893456000,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(captured.url).toBe(`${BASE_URL}/api/v1/checkout/sessions`)

    const body = assertSignedScalars(captured)
    expect(body.checkout_type).toBe('DELEGATE')
    expect(body.chain_id).toBe(56)
    expect(body.fixed_amount_wei).toBe('1000000')
    expect(body.callback_calldata).toBe('0xdeadbeef')
    // The single tokenContract is wrapped into a one-element acceptable_tokens array.
    expect(body.acceptable_tokens).toBe(JSON.stringify(['0xToken']))
    expect(body.success_url).toBe('https://shop.example.com/ok')
    expect(body.cancel_url).toBe('https://shop.example.com/cancel')
    expect(body.client_reference_id).toBe('ref-1')
    expect(body.expires_in).toBe(1800)
  })
})
