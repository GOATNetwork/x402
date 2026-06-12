import { describe, expect, it, vi } from 'vitest'
import { QuickPayClient } from '../src/client.js'
import type { MppBackend, PaymentBackend } from '../src/pay.js'
import { jsonResponse, recordingFetch } from './helpers.js'

const MAN = {
  schema: 'goatx402.quickpay.v1',
  merchant: { merchant_id: 'acme', display_name: 'ACME' },
  rails: {
    x402: {
      enabled: true,
      tokens: [
        {
          chain_id: 4217,
          token_symbol: 'USDC',
          token_contract: '0xToken',
          decimals: 6,
          min_amount_wei: '1000000',
        },
      ],
    },
    mpp: {
      enabled: true,
      routes: [{ route_canonical: 'GET:api:data', chain_id: 4217, token_symbol: 'USDC', amount_wei: '100000' }],
    },
  },
}

function quickPayFetch() {
  let pollN = 0
  return recordingFetch((url, init) => {
    if (url.endsWith('/manifest.json')) return jsonResponse(MAN)
    if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST') {
      return jsonResponse({
        session_id: 's1',
        order_id: 'o1',
        status: 'ORDER_CREATED',
        x402: {
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:4217',
              payTo: '0xPayTo',
              asset: '0xToken',
              amount: '12500000',
            },
          ],
        },
      })
    }
    if (url.includes('/quickpay/v1/x402/sessions/')) {
      pollN++
      return jsonResponse({ status: pollN === 1 ? 'ORDER_CREATED' : 'PAYMENT_CONFIRMED', tx_hash: '0xTx' })
    }
    return jsonResponse({ error: `unexpected ${url}` }, 500)
  })
}

describe('QuickPayClient', () => {
  it('loads and inspects a manifest using constructor fetch', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(MAN))
    const client = new QuickPayClient({
      input: 'https://pay.goat.network/quickpay/acme/agent.md',
      fetchImpl: fetch,
    })

    const loaded = await client.loadManifest()
    const summary = await client.inspect()

    expect(loaded.merchantId).toBe('acme')
    expect(summary.merchant_id).toBe('acme')
    expect(summary.x402_enabled).toBe(true)
    expect(calls.every((c) => c.url === 'https://pay.goat.network/quickpay/acme/manifest.json')).toBe(true)
  })

  it('runs x402 payment with the stored QuickPay link', async () => {
    const { fetch, calls } = quickPayFetch()
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const client = new QuickPayClient('https://pay.goat.network/quickpay/acme', { fetchImpl: fetch })

    const out = await client.payX402({
      amount: '12.5',
      tokenSymbol: 'USDC',
      chainId: 4217,
      backend,
      pollIntervalMs: 0,
      sleep: async () => {},
    })

    expect(out.ok).toBe(true)
    expect(out.session_id).toBe('s1')
    expect(transferErc20).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xPayTo', tokenContract: '0xToken', amountWei: '12500000' }),
    )
    expect(calls.some((c) => c.url === 'https://pay.goat.network/quickpay/v1/x402/sessions')).toBe(true)
  })

  it('runs MPP through the injected backend against the trusted origin', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const pay = vi.fn(async () => ({ txHash: '0xMpp', receiptHeader: 'receipt', receipt: { ok: true } }))
    const backend: MppBackend = { pay }
    const client = new QuickPayClient('https://pay.goat.network/quickpay/acme/manifest.json', { fetchImpl: fetch })

    const out = await client.payMpp({ route: 'GET:api:data', backend })

    expect(out.ok).toBe(true)
    expect(out.receipt_header).toBe('receipt')
    expect(pay).toHaveBeenCalledWith(
      expect.objectContaining({
        coreUrl: 'https://pay.goat.network',
        merchantId: 'acme',
        routeCanonical: 'GET:api:data',
        chainId: 4217,
      }),
    )
  })
})
