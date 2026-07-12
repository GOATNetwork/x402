import { describe, it, expect, vi } from 'vitest'
import { payX402, payProduct, payMpp } from '../src/pay.js'
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

type StatusFixture = string | { status: string; tx_hash?: string; amount_wei?: string }

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
  it('rejects an amount below the manifest minimum BEFORE creating a session or broadcasting', async () => {
    // MAN advertises USDC min_amount_wei '1000000' (1 USDC); 0.5 -> 500000 wei.
    const session = { session_id: 's1', order_id: 'o1', status: 'ORDER_CREATED', x402: { accepts: [] } }
    const { fetch, calls } = routeFetch(session, ['ORDER_CREATED'])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payX402({
        input: 'https://pay.goat.network/quickpay/acme/agent.md',
        amount: '0.5',
        tokenSymbol: 'usdc',
        chainId: 4217,
        backend,
        fetchImpl: fetch,
        pollIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/below this token's minimum/)
    expect(transferErc20).not.toHaveBeenCalled()
    // Preflight fails before any session POST.
    expect(calls.some((c) => c.url.endsWith('/quickpay/v1/x402/sessions'))).toBe(false)
  })

  it('skips the min/max preflight for an explicit idempotency key (server recovers the session)', async () => {
    // 0.5 is below MAN's USDC min (1 USDC), but with an explicit idempotencyKey the
    // caller is resuming a prior intent the server recovers BEFORE re-checking
    // limits, so the SDK must NOT reject it client-side — it must reach the server.
    const session = { session_id: 's1', order_id: 'o1', reused: true, status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior', x402: { accepts: [] } }
    const { fetch, calls } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({
      input: 'https://pay.goat.network/quickpay/acme/agent.md',
      amount: '0.5',
      tokenSymbol: 'usdc',
      chainId: 4217,
      backend,
      idempotencyKey: 'retry-key-1',
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xPrior')
    expect(transferErc20).not.toHaveBeenCalled() // recovered, not re-broadcast
    // The preflight did NOT short-circuit — the create POST reached the server.
    expect(calls.some((c) => c.url.endsWith('/quickpay/v1/x402/sessions'))).toBe(true)
  })

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

  it('does NOT pay a reused session when force is a truthy non-boolean (string "false")', async () => {
    // A plain-JS caller passing the string "false" must not bypass the reused
    // double-pay guard: only a literal boolean true forces a broadcast.
    const session = { session_id: 's3s', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, ['ORDER_CREATED', { status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, force: 'false' as unknown as boolean, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(transferErc20).not.toHaveBeenCalled()
    expect(out.tx_hash).toBe('0xPrior')
  })

  it('adopts the server-confirmed replacement hash for a fresh fee-bumped payment', async () => {
    // Fresh session (reused=false): the wallet sped up the broadcast, so the
    // watcher confirms a DIFFERENT (replacement) hash. The result must report the
    // confirmed on-chain hash, not the original pre-replacement one.
    const session = { session_id: 's-bump', order_id: 'o-bump', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xPayTo', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xReplacement' }])
    const transferErc20 = vi.fn(async () => '0xOriginal')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.reused).toBe(false)
    expect(out.tx_hash).toBe('0xReplacement')
  })

  it('keeps the locally broadcast hash for a forced reused session (never adopts a different server tx)', async () => {
    // Forced reuse: we broadcast a NEW tx; the server may still report a prior/
    // different tx for the session. That must NOT overwrite the hash we just sent.
    const session = { session_id: 's-force-keep', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xPayTo', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xServerPrior' }])
    const transferErc20 = vi.fn(async () => '0xLocalNew')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, force: true, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(transferErc20).toHaveBeenCalledTimes(1)
    expect(out.tx_hash).toBe('0xLocalNew')
  })

  it('ignores a malformed server amount_wei and reports its own computed amount (custom)', async () => {
    // A reused custom session whose status reports a garbage amount_wei: the client's
    // own expectedAmountWei is authoritative (the reuse tuple keys on it), so we must
    // NOT surface the malformed value or a spurious drift note.
    const session = { session_id: 'sbad', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xP', amount_wei: 'not-a-number' }])
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(out.ok).toBe(true)
    expect(out.amount_wei).toBe('1000000') // own quote, not the garbage
    expect(out.note).toBeUndefined() // no spurious drift note
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('forced reuse keeps THIS run\'s broadcast tx_hash even if status reports a different (prior) tx', async () => {
    // --force broadcasts a NEW tx on a reused session; meanwhile a prior in-flight tx
    // confirms and status reports IT. We must NOT lose the hash we just broadcast.
    const session = { session_id: 'sff', reused: true, status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '1000000' }] } }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior' }])
    const transferErc20 = vi.fn(async () => '0xNew')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payX402({ input: 'https://pay.goat.network/quickpay/acme', amount: '1', tokenSymbol: 'USDC', chainId: 4217, backend, force: true, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} })
    expect(transferErc20).toHaveBeenCalledTimes(1)
    expect(out.tx_hash).toBe('0xNew') // our broadcast, not the status's 0xPrior
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

describe('payProduct', () => {
  // MAN advertises USDC (decimals 6). A product priced "9.99" -> 9990000 wei.
  const MAN_PROD = {
    ...MAN,
    rails: {
      ...MAN.rails,
      x402: { ...MAN.rails.x402, products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }] },
    },
  }

  it('prices the product client-side, sends product_key (no amount/memo), transfers to payTo, confirms', async () => {
    const session = {
      session_id: 'sp1',
      order_id: 'op1',
      status: 'ORDER_CREATED',
      x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xPayTo', asset: '0xToken', amount: '9990000' }] },
    }
    const { fetch, calls } = routeFetch(session, ['ORDER_CREATED', 'PAYMENT_CONFIRMED'], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }

    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenSymbol: 'usdc', // case-insensitive
      chainId: 4217,
      backend,
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })

    expect(out.ok).toBe(true)
    expect(out.product_key).toBe('mug')
    expect(out.amount_wei).toBe('9990000')
    expect(transferErc20).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xPayTo', amountWei: '9990000', tokenContract: '0xToken', chainId: 4217 }),
    )
    // The create body carries product_key and OMITS amount_wei/memo (server prices it).
    const post = calls.find((c) => c.init?.method === 'POST')
    const body = JSON.parse(String(post?.init?.body))
    expect(body.product_key).toBe('mug')
    expect(body.amount_wei).toBeUndefined()
    expect(body.memo).toBeUndefined()
    // Hit the TRUSTED origin, never the manifest's evil session_endpoint.
    expect(post?.url).toBe('https://pay.goat.network/quickpay/v1/x402/sessions')
  })

  it('fails closed when the server prices the product differently than the manifest (no broadcast)', async () => {
    // Manifest price 9.99 -> expected 9990000, but the session quotes 90000000.
    const session = {
      session_id: 'sp2',
      status: 'ORDER_CREATED',
      x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '90000000' }] },
    }
    const { fetch } = routeFetch(session, [], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/do not match/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails fast (no POST) for a no-key purchase of a product not in the current manifest', async () => {
    // Without an explicit idempotency key Core cannot auto-recover a removed product (it
    // 404s), so a clear client-side error beats a server round-trip. No POST, no broadcast.
    const manNoProducts = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, products: [] } } }
    const { fetch, calls } = routeFetch({}, [], manNoProducts)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not offered/)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails before POST on a conflicting --token symbol vs --token-contract (contract is in the manifest)', async () => {
    // 0xToken is USDC in the manifest; --token DAI conflicts. Must NOT silently fall back
    // to the explicit contract and create an unpaid session — fail before posting.
    const { fetch, calls } = routeFetch({}, [], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'DAI', tokenContract: '0xToken', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not supported|ambiguous/)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails closed (no broadcast) for a FRESH purchase whose price is not representable in the chosen token', async () => {
    // price "1.999" (3 fractional digits) cannot be denominated in a 2-decimal token,
    // so there is no verifiable quote. A fresh session must NOT broadcast on the
    // server's amount blind — runX402Session fails closed at Case 3.
    const man = {
      ...MAN,
      rails: {
        ...MAN.rails,
        x402: {
          ...MAN.rails.x402,
          tokens: [{ chain_id: 4217, token_symbol: 'XYZ', token_contract: '0xXYZ', decimals: 2, min_amount_wei: '1' }],
          products: [{ product_key: 'p', name: 'P', price: '1.999' }],
        },
      },
    }
    const session = { session_id: 'snr', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xXYZ', amount: '200' }] } }
    const { fetch } = routeFetch(session, [], man)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'p', tokenSymbol: 'XYZ', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not representable|cannot verify/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('recovers a prior product session even when the product was removed/repriced out of the current manifest', async () => {
    // P2-B: a missing/repriced current product must NOT block recovery. The manifest
    // no longer lists 'mug', but core recovers the prior confirmed session on
    // (payer, product_key, chain, token). We report the server's authoritative amount.
    const manNoProducts = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, products: [] } } }
    const session = { session_id: 'sprec', order_id: 'oprec', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch, calls } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld', amount_wei: '9990000' }], manNoProducts)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenSymbol: 'USDC',
      chainId: 4217,
      backend,
      idempotencyKey: 'resume-1', // durable recovery requires an explicit key
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.amount_wei).toBe('9990000') // server-authoritative, no local quote existed
    expect(out.product_key).toBe('mug')
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(true)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('rejects a product purchase when the x402 rail is unavailable and no explicit token is given', async () => {
    // Product present so this isolates the rail-disabled fail-fast (not the product check).
    const manDisabled = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, enabled: false, tokens: [], products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }] } } }
    const { fetch } = routeFetch({}, [], manDisabled)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not available/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('recovers a prior product session even when the x402 rail shows disabled (last token removed) given an explicit --token-contract', async () => {
    // Merchant removed all tokens, so x402.enabled is false — but a prior product
    // session is still recoverable server-side, and the buyer supplies the contract.
    const manNoTokens = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, enabled: false, tokens: [], products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }] } } }
    const session = { session_id: 'sprail', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld', amount_wei: '9990000' }], manNoTokens)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenContract: '0xGoneToken',
      chainId: 4217,
      backend,
      idempotencyKey: 'resume-1', // durable recovery requires an explicit key
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.amount_wei).toBe('9990000')
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('recovers a prior product session even when the chosen token was removed from the manifest (explicit --token-contract)', async () => {
    // The manifest no longer lists the token the buyer originally used, but they pass
    // an explicit --token-contract. We must still post for recovery on
    // (payer, product_key, chain, token); the server's amount is authoritative.
    const manOtherToken = {
      ...MAN,
      rails: {
        ...MAN.rails,
        x402: {
          ...MAN.rails.x402,
          tokens: [{ chain_id: 4217, token_symbol: 'OTHER', token_contract: '0xOther', decimals: 6, min_amount_wei: '1' }],
          products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }],
        },
      },
    }
    const session = { session_id: 'sptok', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch, calls } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld', amount_wei: '9990000' }], manOtherToken)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenContract: '0xGoneToken', // not in the current manifest
      chainId: 4217,
      backend,
      idempotencyKey: 'resume-1', // durable recovery requires an explicit key
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.amount_wei).toBe('9990000') // server-authoritative
    const post = calls.find((c) => c.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body)).token_contract).toBe('0xGoneToken') // explicit contract posted
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails closed when a recovered product status snapshot omits amount_wei (amount not server-substantiated)', async () => {
    // Status succeeds but omits amount_wei (malformed/version-skewed server). The
    // current quote (19990000) is not server-authoritative for a recovered product, so
    // we must NOT report it — fail closed rather than claim a possibly-stale amount.
    const man = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, products: [{ product_key: 'mug', name: 'Coffee Mug', price: '19.99' }] } } }
    const session = { session_id: 'snoamt', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld' }], man) // no amount_wei
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/could not read|reconcile|authoritative/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails closed when a recovered CONFIRMED product session returns no tx_hash', async () => {
    // Amount is substantiated but the server omits tx_hash; we cannot point the buyer at
    // the on-chain payment, so don't claim a clean success.
    const session = { session_id: 'snotx', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', amount_wei: '9990000' }], MAN_PROD) // no tx_hash
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/transaction hash|reconcile/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('does not broadcast a fresh product purchase on a disabled rail even if the manifest still lists token+product (skew)', async () => {
    const manSkew = {
      ...MAN,
      rails: {
        ...MAN.rails,
        x402: {
          ...MAN.rails.x402,
          enabled: false,
          tokens: [{ chain_id: 4217, token_symbol: 'USDC', token_contract: '0xToken', decimals: 6, min_amount_wei: '1000000' }],
          products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }],
        },
      },
    }
    const session = { session_id: 'sskew', status: 'ORDER_CREATED', x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '9990000' }] } }
    const { fetch } = routeFetch(session, [], manSkew)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenContract: '0xToken', chainId: 4217, backend, fetchImpl: fetch, pollIntervalMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/cannot verify|not representable|not available/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails closed when a recovered product session yields no status snapshot (cannot vouch for amount/tx)', async () => {
    // P2-A: create says the recovered session is terminal, but every status fetch
    // fails. We must NOT report a success at the stale quote with an empty tx_hash —
    // throw a reconcile error instead.
    const seq = [0, 1, 1000, 1000] // now(): deadline=0+T, one iteration, then past deadline
    let i = 0
    const now = () => seq[Math.min(i++, seq.length - 1)]
    const fetchImpl = recordingFetch((url, init) => {
      if (url.endsWith('/manifest.json')) return jsonResponse(MAN_PROD)
      if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST') {
        return jsonResponse({ session_id: 'snosnap', reused: true, status: 'PAYMENT_CONFIRMED' })
      }
      return jsonResponse({ error: 'status unavailable' }, 503) // every status GET fails
    }).fetch
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({
        input: 'https://pay.goat.network/quickpay/acme',
        productKey: 'mug',
        tokenSymbol: 'USDC',
        chainId: 4217,
        backend,
        fetchImpl,
        pollIntervalMs: 0,
        pollTimeoutMs: 100,
        sleep: async () => {},
        now,
      }),
    ).rejects.toThrow(/could not read|reconcile/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('gives a product-specific error when no token is supplied', async () => {
    const { fetch } = routeFetch({}, [], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/pay-product requires --token/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('rejects a token the merchant does not support', async () => {
    const { fetch } = routeFetch({}, [], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'DAI', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/not supported/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('reports the SERVER amount + a price-drift note when a recovered product session was priced differently', async () => {
    // The product is now priced 19.99 (-> 19990000), but core recovered a prior
    // session confirmed at the OLD price 9990000 (product idempotency keys on
    // payer+product_key+chain+token, NOT amount). We must report the REAL amount
    // paid (9990000), not the current quote, and flag the drift.
    const man = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, products: [{ product_key: 'mug', name: 'Coffee Mug', price: '19.99' }] } } }
    const session = { session_id: 'spd', order_id: 'opd', reused: true, status: 'PAYMENT_CONFIRMED' }
    const { fetch } = routeFetch(session, [{ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld', amount_wei: '9990000' }], man)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenSymbol: 'USDC',
      chainId: 4217,
      backend,
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xOld')
    expect(out.amount_wei).toBe('9990000') // the REAL amount, not the 19990000 quote
    expect(out.product_key).toBe('mug')
    expect(out.note).toMatch(/repriced|differs/)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('does NOT auto-pay a reused fresh product session — resumes by polling', async () => {
    const session = {
      session_id: 'sp5',
      reused: true,
      status: 'ORDER_CREATED',
      x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '9990000' }] },
    }
    // Status carries the authoritative amount_wei (as real core does).
    const { fetch } = routeFetch(session, ['ORDER_CREATED', { status: 'PAYMENT_CONFIRMED', tx_hash: '0xPrior', amount_wei: '9990000' }], MAN_PROD)
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenSymbol: 'USDC',
      chainId: 4217,
      backend,
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.reused).toBe(true)
    expect(out.ok).toBe(true)
    expect(out.tx_hash).toBe('0xPrior')
    expect(out.product_key).toBe('mug')
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('recovers a prior product session via explicit key even when the MANIFEST is unavailable (explicit --token-contract)', async () => {
    // The merchant's manifest endpoint is down (503), but the buyer holds an explicit
    // idempotency key + the token contract they originally used. Durable recovery must not
    // depend on the manifest being reachable: we POST to let Core recover on (merchant,
    // key) and report its authoritative amount. No quote exists, so no fresh broadcast.
    const { fetch, calls } = recordingFetch((url, init) => {
      if (url.endsWith('/manifest.json')) return jsonResponse({ error: 'unavailable' }, 503)
      if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST') {
        return jsonResponse({ session_id: 'smdown', reused: true, status: 'PAYMENT_CONFIRMED' })
      }
      return jsonResponse({ status: 'PAYMENT_CONFIRMED', tx_hash: '0xOld', amount_wei: '9990000' })
    })
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    const out = await payProduct({
      input: 'https://pay.goat.network/quickpay/acme',
      productKey: 'mug',
      tokenContract: '0xToken',
      chainId: 4217,
      backend,
      idempotencyKey: 'resume-1',
      fetchImpl: fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    expect(out.ok).toBe(true)
    expect(out.amount_wei).toBe('9990000') // server-authoritative; no local quote existed
    expect(out.tx_hash).toBe('0xOld')
    expect(out.product_key).toBe('mug')
    const post = calls.find((c) => c.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body)).token_contract).toBe('0xToken') // explicit contract posted
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('fails (no POST) for a FRESH product purchase when the manifest is unavailable', async () => {
    // No explicit idempotency key => fresh purchase => a reachable, valid manifest is
    // required to price the product. We must not POST blind.
    const { fetch, calls } = recordingFetch((url) => {
      if (url.endsWith('/manifest.json')) return jsonResponse({ error: 'unavailable' }, 503)
      return jsonResponse({ session_id: 'x', status: 'ORDER_CREATED' })
    })
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenContract: '0xToken', chainId: 4217, backend, fetchImpl: fetch }),
    ).rejects.toThrow(/manifest/)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('still requires the manifest for recovery when no explicit --token-contract is given (only a symbol)', async () => {
    // Without the manifest we cannot resolve a SYMBOL to a contract, so manifest-less
    // recovery is gated on an explicit --token-contract. A symbol-only recovery must still
    // surface the manifest error rather than POST an unresolved token.
    const { fetch, calls } = recordingFetch((url) => {
      if (url.endsWith('/manifest.json')) return jsonResponse({ error: 'unavailable' }, 503)
      return jsonResponse({ session_id: 'x', status: 'ORDER_CREATED' })
    })
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({ input: 'https://pay.goat.network/quickpay/acme', productKey: 'mug', tokenSymbol: 'USDC', chainId: 4217, backend, idempotencyKey: 'resume-1', fetchImpl: fetch }),
    ).rejects.toThrow(/manifest/)
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
    expect(transferErc20).not.toHaveBeenCalled()
  })

  it('does NOT broadcast when a manifest-less recovery yields a FRESH (non-reused) session — fails closed', async () => {
    // If the explicit key matched no prior session and Core returns a fresh session, we
    // have no quote (the manifest was unavailable) and must NEVER broadcast on the server's
    // terms blind. runX402Session Case 3 throws because expectedAmountWei is undefined.
    const { fetch } = recordingFetch((url, init) => {
      if (url.endsWith('/manifest.json')) return jsonResponse({ error: 'unavailable' }, 503)
      if (url.endsWith('/quickpay/v1/x402/sessions') && init?.method === 'POST') {
        return jsonResponse({
          session_id: 'sfresh',
          status: 'ORDER_CREATED',
          x402: { accepts: [{ scheme: 'exact', network: 'eip155:4217', payTo: '0xP', asset: '0xToken', amount: '9990000' }] },
        })
      }
      return jsonResponse({ status: 'ORDER_CREATED' })
    })
    const transferErc20 = vi.fn(async () => '0xTx')
    const backend: PaymentBackend = { getAddress: async () => '0xPayer', transferErc20 }
    await expect(
      payProduct({
        input: 'https://pay.goat.network/quickpay/acme',
        productKey: 'mug',
        tokenContract: '0xToken',
        chainId: 4217,
        backend,
        idempotencyKey: 'resume-1',
        fetchImpl: fetch,
        pollIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/cannot verify/)
    expect(transferErc20).not.toHaveBeenCalled()
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

  it('rejects when the backend returns no tx hash (nothing was broadcast)', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const backend: MppBackend = { pay: vi.fn(async () => ({ txHash: '' })) }
    await expect(
      payMpp({ input: 'https://pay.goat.network/quickpay/acme', route: 'GET:api:data', backend, fetchImpl: fetch }),
    ).rejects.toThrow(/no transaction hash/)
  })

  it('rejects a broadcast-but-unverified payment (tx hash, no receipt) without a false resume handle', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    const backend: MppBackend = { pay: vi.fn(async () => ({ txHash: '0xMpp' })) }
    const err = await payMpp({ input: 'https://pay.goat.network/quickpay/acme', route: 'GET:api:data', backend, fetchImpl: fetch }).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('0xMpp')
    expect(err.message).toMatch(/incomplete/i)
    // Must NOT impersonate the SDK's resumable MPPError: we have no challenge here,
    // so marking it recoverable would emit a recovery payload that cannot resume.
    expect(err.name).not.toBe('MPPError')
    expect(err.recoverable).toBeUndefined()
  })

  it('rejects when only a decoded receipt body (no signed header) is returned', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(MAN))
    // A receipt BODY is not the signed Payment-Receipt header the merchant verifies.
    const backend: MppBackend = { pay: vi.fn(async () => ({ txHash: '0xMpp', receipt: { ok: 1 } })) }
    await expect(
      payMpp({ input: 'https://pay.goat.network/quickpay/acme', route: 'GET:api:data', backend, fetchImpl: fetch }),
    ).rejects.toThrow(/no signed receipt header/i)
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

  it('surfaces x402 products from the manifest', async () => {
    const man = { ...MAN, rails: { ...MAN.rails, x402: { ...MAN.rails.x402, products: [{ product_key: 'mug', name: 'Coffee Mug', price: '9.99' }] } } }
    const { fetch } = recordingFetch(() => jsonResponse(man))
    const r = await inspect('https://pay.goat.network/quickpay/acme', fetch)
    expect(r.x402_products).toHaveLength(1)
    expect(r.x402_products[0]).toMatchObject({ product_key: 'mug', name: 'Coffee Mug', price: '9.99' })
  })
})
