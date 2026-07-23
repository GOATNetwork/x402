import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoatFlowClient, GoatFlowError } from '../src/index.js'

const client = () =>
  new GoatFlowClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
  })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GoatFlowError', () => {
  it('is exported at runtime and used for public API failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'merchant unavailable', code: 'MERCHANT_DOWN' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )

    const error = await client().getMerchant('merchant_1').catch((cause: unknown) => cause)

    expect(GoatFlowError).toBeTypeOf('function')
    expect(error).toBeInstanceOf(GoatFlowError)
    expect(error).toMatchObject({
      name: 'GoatFlowError',
      message: 'merchant unavailable',
      code: 'MERCHANT_DOWN',
      status: 503,
    })
  })

  it('preserves the response body for authenticated API failures', async () => {
    const responseBody = JSON.stringify({ message: 'order unavailable', code: 'ORDER_DOWN' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(responseBody, {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )

    const error = await client().getOrderStatus('order_1').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GoatFlowError)
    expect(error).toMatchObject({
      name: 'GoatFlowError',
      message: 'order unavailable',
      code: 'ORDER_DOWN',
      status: 502,
      responseBody,
    })
  })
})
