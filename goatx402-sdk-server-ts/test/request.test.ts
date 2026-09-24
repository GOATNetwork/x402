import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoatFlowClient, GoatFlowError } from '../src/index.js'

const client = () =>
  new GoatFlowClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
  })

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const orderStatus = (status: string) => ({
  order_id: 'order_1',
  merchant_id: 'merchant_1',
  dapp_order_id: 'dapp_1',
  chain_id: 137,
  token_contract: '0xToken',
  token_symbol: 'USDC',
  from_address: '0xPayer',
  amount_wei: '1000000',
  status,
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('request boundaries', () => {
  it('accepts HTTP 402 only for order creation and applies a request deadline', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          x402Version: 2,
          resource: { url: 'https://shop.example.com/order/1' },
          accepts: [],
          order_id: 'order_1',
          flow: 'ERC20_DIRECT',
          token_symbol: 'USDC',
        },
        402
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await client().createOrderRaw({
      dappOrderId: 'dapp_1',
      chainId: 137,
      tokenSymbol: 'USDC',
      fromAddress: '0xPayer',
      amountWei: '1000000',
    })

    expect(response.order_id).toBe('order_1')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects HTTP 402 from a non-create endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'payment required elsewhere', code: 'UNEXPECTED_402' }, 402)
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await client().cancelOrder('order_1').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GoatFlowError)
    expect(error).toMatchObject({ status: 402, code: 'UNEXPECTED_402' })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('applies a request deadline to public endpoints', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ merchant_id: 'merchant_1', receive_type: 'DIRECT', wallets: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    await client().getMerchant('merchant_1')

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('encodes order and merchant IDs as single URL path segments', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(orderStatus('PAYMENT_CONFIRMED')))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', order_id: 'order_1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', order_id: 'order_1' }))
      .mockResolvedValueOnce(
        jsonResponse({ merchant_id: 'merchant_1', receive_type: 'DIRECT', wallets: [] })
      )
    vi.stubGlobal('fetch', fetchMock)

    const unsafeId = 'victim/../cancel?#%'
    const goat = client()
    await goat.getOrderStatus(unsafeId)
    await goat.getOrderProof(unsafeId)
    await goat.submitCalldataSignature(unsafeId, '0xsig')
    await goat.cancelOrder(unsafeId)
    await goat.getMerchant(unsafeId)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/api/v1/orders/victim%2F..%2Fcancel%3F%23%25',
      'https://api.example.com/api/v1/orders/victim%2F..%2Fcancel%3F%23%25/proof',
      'https://api.example.com/api/v1/orders/victim%2F..%2Fcancel%3F%23%25/calldata-signature',
      'https://api.example.com/api/v1/orders/victim%2F..%2Fcancel%3F%23%25/cancel',
      'https://api.example.com/merchants/victim%2F..%2Fcancel%3F%23%25',
    ])
  })
})

describe('waitForConfirmation', () => {
  it('retries transient server errors and returns a later confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse(orderStatus('PAYMENT_CONFIRMED')))
    vi.stubGlobal('fetch', fetchMock)

    const result = await client().waitForConfirmation('order_1', { timeout: 1000, interval: 0 })

    expect(result.status).toBe('PAYMENT_CONFIRMED')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats INVOICED as a successful terminal state', async () => {
    // Core flips DIRECT orders PAYMENT_CONFIRMED → INVOICED inside one watcher
    // transaction, so a poller may only ever observe INVOICED. Without this
    // terminal, every DIRECT wait would run to timeout.
    const fetchMock = vi.fn(async () => jsonResponse(orderStatus('INVOICED')))
    vi.stubGlobal('fetch', fetchMock)

    const result = await client().waitForConfirmation('order_1', { timeout: 1000, interval: 0 })

    expect(result.status).toBe('INVOICED')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('immediately rethrows deterministic client errors', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'order not found', code: 'ORDER_NOT_FOUND' }, 404)
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await client()
      .waitForConfirmation('missing', { timeout: 1000, interval: 0 })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GoatFlowError)
    expect(error).toMatchObject({ status: 404, code: 'ORDER_NOT_FOUND' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // The Go server SDK marks `recover_existing_order` omitempty; this SDK must
  // stay byte-identical on the wire: absent by default, `true` only when opted
  // in. Pinned at the request body, not the type, so a dropped assignment
  // cannot pass type-checking and drift the two SDKs apart again.
  it('sends recover_existing_order only when opted in', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          resource: { url: 'https://shop.example.com/order/1' },
          accepts: [],
          order_id: 'order_1',
          flow: 'ERC20_DIRECT',
          token_symbol: 'USDC',
        },
        402
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const base = {
      dappOrderId: 'dapp_1',
      chainId: 137,
      tokenSymbol: 'USDC',
      fromAddress: '0xPayer',
      amountWei: '1000000',
    }
    await client().createOrderRaw(base)
    const plain = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>
    expect('recover_existing_order' in plain).toBe(false)

    await client().createOrderRaw({ ...base, recoverExistingOrder: true })
    const optedIn = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>
    expect(optedIn.recover_existing_order).toBe(true)

    await client().createOrderRaw({ ...base, recoverExistingOrder: false })
    const optedOut = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as Record<string, unknown>
    expect('recover_existing_order' in optedOut).toBe(false)
  })
})
