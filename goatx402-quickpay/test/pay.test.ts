import { describe, it, expect, vi } from 'vitest'
import { payX402, payMpp } from '../src/pay.js'
import type { PaymentBackend, MppBackend } from '../src/pay.js'
import { inspect } from '../src/inspect.js'
import { jsonResponse, recordingFetch } from './helpers.js'

const MAN = {
  schema: 'goatx402.quickpay.v1',
  merchant: { merchant_id: 'acme', display_name: 'ACME' },
  rails: {
    // Deliberately point the manifest's own URLs at an attacker host: the CLI
    // must IGNORE these and use endpoints derived from the trusted link origin.
    x402: {
      enabled: true,
      session_endpoint: 'https://EVIL.example/x402/sessions',
      tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xToken', decimals: 6, min_amount_wei: '1000000' }],
    },
    mpp: { enabled: true, routes: [{ route_canonical: 'GET:api:data', chain_id: 4217, token_symbol: 'USDC', amount_wei: '100000' }] },
  },
}

type StatusFixture = string | { status: string; tx_hash?: string }

function routeFetch(session: any, statuses: StatusFixture[], manifest: any = MAN) {
  let pollN = 0
  return recordingFetch((url, init) => {
    if (url.endsWith('/manifest.json')) return jsonResponse(manifest)
    if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST') return jsonResponse(session)
    if (url.includes('/quickpay/v1/x402/sessions/')) {
      const entry = statuses[Math.min(pollN, statuses.length - 1)]
      pollN++
      const body = typeof entry === 'string' ? { status: entry } : entry
      return jsonResponse({ session_id: session.session_id, order_id: session.order_id, ...body })
    }
    return jsonResponse({ error: `unexpected ${url}` }, 500)
  })
}

describe('payX402', () => {
  it('creates session on the TRUSTED origin, transfers to session payTo, polls to confirmed', async () => {
    const session = {
      session_id: 's1',
      order_id: 'o1',
      status: 'ORDER_CREATED',
      x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xPayTo', asset: '0xToken', amount: '12500000' }] },
    }
    const { fetch, calls } = routeFetch(session, ['ORDER_CREATED', 'PAYMENT_CONFIRMED'])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }

    const out = await payX402({
      input: 'https://pay.goat.network/quickpay/acme/agent.md',
      amount: '12.5',
      tokenSymbol: 'usdc', // case-insensitive
      chainId: 4217,
      backend,
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })

    expect(out.ok).toBe(true)
    expect(out.status).toBe('PAYMENT_CONFIRMED')
    expect(out.tx_hash).toBe('0xTx')
    expect(out.amount_wei).toBe('12500000')
    expect(out.session_id).toBe('s1')
    expect(out.order_id).toBe('o1')
    expect(out.reused).toBe(false)

    // The session POST hit the TRUSTED origin, never the manifest's evil URL.
    const post = calls.find((c) => c.init?.method === 'POST')
    expect(post?.url).toBe('https://pay.goat.network/quickpay/v1/x402/sessions')
    expect(calls.some((c) => c.url.toLowerCase().includes('evil'))).toBe(false)

    // Transfer used the session's payTo + amount.
    expect(transferErc20).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xPayTo', amountWei: '12500000', tokenContract: '0xToken', chainId: 4217 }),
    )
  })

  it('returns ok=false on a non-confirmed terminal status', async () => {
    const session = { session_id: 's2', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, ['EXPIRED'])
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20: async () => '0xTx' }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.ok).toBe(false)
    expect(out.status).toBe('EXPIRED')
  })

  it('Case 1: reports the freshly fetched status for a terminal-on-create session (late revival)', async () => {
    // The create response already shows a terminal status (EXPIRED), but a late
    // watcher bind has since moved it to PAYMENT_CONFIRMED. The CLI must report the
    // FRESHLY fetched status, not the stale create-time EXPIRED. Never broadcasts.
    const session = { session_id: 's-revive', status: 'EXPIRED', x402: { accepts: [] } }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xRevived' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.status).toBe('PAYMENT_CONFIRMED')
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xRevived')
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('does NOT auto-pay a reused fresh session — resumes by polling instead', async () => {
    const session = { session_id: 's3', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    // A prior attempt's transfer confirms while we poll; we must NOT broadcast again.
    const { fetch } = routeFetch(session, ['ORDER_CREATED', { status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.reused).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xPrior')
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('pays a reused fresh session only when force is set', async () => {
    const session = { session_id: 's3f', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, ['ORDER_CREATED', 'PAYMENT_CONFIRMED'])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, force: true, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xTx')
    expect(transferErc20).toHaveBeenCalledTimes(1)
  })

  it('preserves the broadcast tx_hash when confirmation polling does not complete', async () => {
    const session = { session_id: 's6', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, ['ORDER_CREATED'])
    const transferErc20 = vi.fn(async () => '0xBroadcast')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    // pollTimeoutMs 0 => polling resolves no terminal status; the broadcast hash
    // must still be returned (not discarded) so a retry can resume, not re-pay.
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, pollTimeoutMs: 0, sleep: async () => {} })
    expect(transferErc20).toHaveBeenCalledTimes(1)
    expect(out.tx_hash).toBe('0xBroadcast')
    expect(out.ok).toBe(false)
  })

  it('does NOT re-pay a reused session once a tx is already tracked', async () => {
    const session = { session_id: 's3b', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xExisting' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.ok).toBe(true)
    expect(out.reused).toBe(true)
    expect(out.tx_hash).toBe('0xExisting')
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('rejects a session whose accept asset != requested token (wrong-token guard)', async () => {
    const session = { session_id: 's4', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xEVILTOKEN', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, [])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/do not match/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('rejects pay-x402 when the merchant requires a memo and none is given', async () => {
    const manifest = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, memo_required: true } } }
    const { fetch } = routeFetch({}, [], manifest)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/requires a memo/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('allows pay-x402 with a memo when the merchant requires one', async () => {
    const manifest = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, memo_required: true } } }
    const session = { session_id: 'sm', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '12500000' }] } }
    const { fetch } = routeFetch(session, ['PAYMENT_CONFIRMED'], manifest)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '12.5', tokenSymbol: 'USDC', chainId: 4217, backend, memo: 'invoice-1', fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.ok).toBe(true)
    expect(transferErc20).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsupported token before any transfer', async () => {
    const { fetch } = routeFetch({}, [])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0x', transferErc20 }
    await expect(
      payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'DAI', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not supported/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('rejects ambiguous token symbols on the same chain without --token-contract', async () => {
    const manifest = {
      ...MAN,
      rails: {
        ...MAN.rails,
        x402: {
          ...MAN.rails.x402,
          tokens: [
            { chain_id: 4217, token_symbol: 'USDC', token_contract: '0xTokenA', decimals: 6, min_amount_wei: '1000000' },
            { chain_id: 4217, token_symbol: 'USDC', token_contract: '0xTokenB', decimals: 6, min_amount_wei: '1000000' },
          ],
        },
      },
    }
    const { fetch } = routeFetch({}, [], manifest)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0x', transferErc20 }
    await expect(
      payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/ambiguous.*--token-contract/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('selects the requested token contract when symbols collide', async () => {
    const manifest = {
      ...MAN,
      rails: {
        ...MAN.rails,
        x402: {
          ...MAN.rails.x402,
          tokens: [
            { chain_id: 4217, token_symbol: 'USDC', token_contract: '0xTokenA', decimals: 6, min_amount_wei: '1000000' },
            { chain_id: 4217, token_symbol: 'USDC', token_contract: '0xTokenB', decimals: 6, min_amount_wei: '1000000' },
          ],
        },
      },
    }
    const session = { session_id: 's5', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xTokenB', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, ['PAYMENT_CONFIRMED'], manifest)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({
      input: 'https://pay.goat.network/quickpay/acme',
      amount: '1',
      tokenSymbol: 'USDC',
      tokenContract: '0xTokenB',
      chainId: 4217,
      backend,
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(transferErc20).toHaveBeenCalledWith(expect.objectContaining({ tokenContract: '0xTokenB' }))
  })
})

describe('payMpp', () => {
  it('finds the route and pays via the backend with the trusted coreUrl', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const pay = vi.fn(async () => ({ txHash: '0xMpp', receiptHeader: 'rh', receipt: { ok: 1 } }))
    const backend: MppBackend = { pay }
    const out = await payMpp({ input: 'https://pay.goat.network/quickpay/acme', route: 'GET:api:data', backend, fetchImpl: fetch })
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xMpp')
    expect(out.receipt_header).toBe('rh')
    expect(pay).toHaveBeenCalledWith(
      expect.objectContaining({ coreUrl: 'https://pay.goat.network', merchantId: 'acme', routeCanonical: 'GET:api:data', chainId: 4217 }),
    )
  })

  it('rejects an unknown route', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const backend: MppBackend = { pay: vi.fn(async () => ({ txHash: '0x' })) }
    await expect(payMpp({ input: 'https://pay.goat.network/quickpay/acme', route: 'NOPE', backend, fetchImpl: fetch })).rejects.toThrow(/not offered/)
  })
})

describe('inspect', () => {
  it('summarizes rails from the manifest', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const r = await inspect('https://pay.goat.network/quickpay/acme', fetch)
    expect(r.merchant_id).toBe('acme')
    expect(r.x402_enabled).toBe(true)
    expect(r.x402_tokens[0].token_symbol).toBe('USDC')
    expect(r.mpp_enabled).toBe(true)
    expect(r.mpp_routes[0].route_canonical).toBe('GET:api:data')
  })
})
