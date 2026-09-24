import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { GoatFlowClient } from '../src/client.js'

const API_KEY = 'test-key'
const API_SECRET = 'test-secret'
const BASE_URL = 'https://api.example.com'

/**
 * Regression cover for the fiat rail's wire fields (`payment_rails`,
 * `fiat_currency`, `fiat_amount`).
 *
 * These went out with no test at all, and every one of their failure modes is
 * silent from the SDK's side: a renamed field, a `payment_rails` array that
 * stops being CSV-joined, or a fiat field that slips out of the signed body
 * all produce a request the server rejects (or, worse, accepts having ignored
 * the rail) with nothing local to point at. The HMAC scheme signs the body
 * verbatim, so the serialization IS the contract.
 */

/**
 * Mirror the core HMAC scheme (goatx402-core/internal/api/signature.go):
 * sort non-empty params by key, join as `k=v&...`, HMAC-SHA256 hex.
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

const OK_SESSION = {
  checkout_id: 'chk_1',
  checkout_type: 'DIRECT',
  url: 'https://pay.example.com/chk_1',
  expires_at: 1893456000,
}

describe('fiat rail wire fields', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends payment_rails as CSV and the fiat fields under their exact names', async () => {
    const { captured } = mockFetch(OK_SESSION)
    await client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '12.50',
      paymentRails: ['crypto', 'fiat'],
      fiatCurrency: 'USD',
      fiatAmount: '12.50',
    })
    const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>

    // CSV, in the order given — not a JSON array, not repeated keys.
    expect(body.payment_rails).toBe('crypto,fiat')
    expect(body.fiat_currency).toBe('USD')
    expect(body.fiat_amount).toBe('12.50')

    // The camelCase spellings must NOT leak onto the wire — the server reads
    // snake_case and would silently ignore an unknown field.
    expect(body).not.toHaveProperty('paymentRails')
    expect(body).not.toHaveProperty('fiatCurrency')
    expect(body).not.toHaveProperty('fiatAmount')
  })

  it('signs the fiat fields — they are part of the HMAC input, not extras', async () => {
    const { captured } = mockFetch(OK_SESSION)
    await client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '12.50',
      paymentRails: ['fiat'],
      fiatCurrency: 'EUR',
      fiatAmount: '9.99',
    })
    const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>
    const headers = captured.init?.headers as Record<string, string>

    // Every signed param must be a top-level scalar: the scheme cannot sign
    // nested JSON, so a fiat field that ever became an object or array would
    // break signing rather than just look different.
    for (const [k, v] of Object.entries(body)) {
      expect(['string', 'number', 'boolean'], `param ${k} must be a scalar`).toContain(typeof v)
    }

    const expected: Record<string, string> = {}
    for (const [k, v] of Object.entries(body)) expected[k] = String(v)
    expected.api_key = API_KEY
    expected.timestamp = headers['X-Timestamp']
    expected.nonce = headers['X-Nonce']
    // Recomputed over the WHOLE body including the fiat fields: if any of them
    // were excluded from signing, or renamed after signing, this diverges.
    expect(headers['X-Sign']).toBe(serverSign(expected, API_SECRET))
  })

  it('omits the fiat fields entirely when not requested', async () => {
    const { captured } = mockFetch(OK_SESSION)
    await client().createCheckoutSession({ checkoutType: 'DIRECT', price: '5.00' })
    const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>

    // Absent, not empty-string: the HMAC scheme drops empty values, so an
    // empty `fiat_currency: ''` signs identically but still reaches the server
    // as a present-but-blank field.
    expect(body).not.toHaveProperty('payment_rails')
    expect(body).not.toHaveProperty('fiat_currency')
    expect(body).not.toHaveProperty('fiat_amount')
  })

  it('sends a single rail without a trailing separator', async () => {
    const { captured } = mockFetch(OK_SESSION)
    await client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '5.00',
      paymentRails: ['crypto'],
    })
    const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>
    expect(body.payment_rails).toBe('crypto')
  })

  it('supports a true fiat-only session with no crypto price', async () => {
    const { captured } = mockFetch(OK_SESSION)
    await client().createCheckoutSession({
      checkoutType: 'DIRECT',
      paymentRails: ['fiat'],
      fiatCurrency: 'USD',
      fiatAmount: '12.50',
    })
    const body = JSON.parse(captured.init?.body as string) as Record<string, unknown>
    expect(body).toEqual({
      checkout_type: 'DIRECT',
      payment_rails: 'fiat',
      fiat_currency: 'USD',
      fiat_amount: '12.50',
    })
    expect(body).not.toHaveProperty('price')
  })

  it('rejects contradictory fiat rail fields before fetch', async () => {
    const { fetchMock } = mockFetch(OK_SESSION)
    await expect(client().createCheckoutSession({
      checkoutType: 'DIRECT',
      paymentRails: ['fiat'],
      fiatCurrency: 'USD',
    })).rejects.toThrow(/fiatAmount/)
    await expect(client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '1',
      fiatCurrency: 'USD',
      fiatAmount: '1',
    })).rejects.toThrow(/paymentRails/)
    await expect(client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '1',
      paymentRails: [] as never[],
    })).rejects.toThrow(/non-empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid or duplicate rails from plain JavaScript callers', async () => {
    const { fetchMock } = mockFetch(OK_SESSION)
    await expect(client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '1',
      paymentRails: ['crypto', 'crypto'],
    })).rejects.toThrow(/duplicate/)
    await expect(client().createCheckoutSession({
      checkoutType: 'DIRECT',
      price: '1',
      paymentRails: ['fiatt'] as never,
    })).rejects.toThrow(/unsupported/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
