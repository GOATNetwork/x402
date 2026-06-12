/**
 * Tests for MPPClient.pay() — the high-level composition.
 *
 * Focus: post-payment recovery handle (codex round 18 P2).
 * verifyChallenge / requestChallenge / payChallenge are exercised
 * individually elsewhere; here we only assert the composition's
 * error-decoration behaviour, which is the only logic pay() owns
 * beyond delegating to its three sub-steps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ethers } from 'ethers'

const transferMock = vi.fn()
vi.mock('../contracts/erc20.js', () => ({
  ERC20Token: vi.fn().mockImplementation(() => ({
    transfer: transferMock,
  })),
}))

import { MPPClient } from '../mpp.js'
import { MPPError } from '../types.js'

const CHAIN_ID = 42431
const FAKE_PAYER = '0x1111111111111111111111111111111111111111'

function mockSigner(): ethers.Signer {
  const provider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(CHAIN_ID) } as ethers.Network),
  }
  return {
    getAddress: vi.fn().mockResolvedValue(FAKE_PAYER),
    provider,
  } as unknown as ethers.Signer
}

const VALID_CHALLENGE = {
  challenge_id: 'ch_abc',
  expiry: 9_999_999_999,
  amount_wei: '1000000',
  chain_id: CHAIN_ID,
  token_contract: '0x' + 'a'.repeat(40),
  recipient: '0x' + 'b'.repeat(40),
  mac: 'mac',
  route_pricing_version: 1,
}

interface QueuedResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function queuedFetch(responses: QueuedResponse[]): typeof fetch {
  let i = 0
  return vi.fn().mockImplementation(async () => {
    if (i >= responses.length) {
      throw new Error(`queuedFetch exhausted — call #${i + 1} not staged`)
    }
    const r = responses[i++]
    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
    } as unknown as Response
  }) as unknown as typeof fetch
}

/**
 * base64url-encode a payload as the first segment of a 3-segment
 * Payment-Receipt header (sig/alg segments are placeholders — the SDK only
 * decodes the payload segment).
 */
function makeReceipt(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${b64}.sig.alg`
}

/**
 * Like queuedFetch but records each request's parsed JSON body so tests can
 * assert which tx_hash a given verify POST carried (the challenge POST has
 * no tx_hash).
 */
function recordingFetch(responses: QueuedResponse[]): {
  fn: typeof fetch
  bodies: Array<Record<string, unknown>>
} {
  const bodies: Array<Record<string, unknown>> = []
  let i = 0
  const fn = vi.fn().mockImplementation(async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body))
    if (i >= responses.length) {
      throw new Error(`recordingFetch exhausted — call #${i + 1} not staged`)
    }
    const r = responses[i++]
    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, bodies }
}

describe('MPPClient.pay error recovery handle', () => {
  beforeEach(() => {
    // transferMock is hoisted to module scope by vi.mock(); each test
    // needs a fresh state for the call-count assertions to be sound.
    transferMock.mockReset()
  })

  it('attaches { challenge, txHash } to MPPError when verify fails after payment', async () => {
    transferMock.mockResolvedValue({ hash: '0xpaidtx' })
    const sleep = vi.fn().mockResolvedValue(undefined)
    // Sequence: challenge (402) → verify (401 terminal challenge_expired).
    const fetchImpl = queuedFetch([
      { status: 402, body: VALID_CHALLENGE },
      { status: 401, body: { error: 'challenge_expired' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    let caught: MPPError | undefined
    await client
      .pay({ merchantId: 'm1', routeCanonical: 'GET:api', requestCanonical: 'GET:api:v1' })
      .catch((e) => {
        caught = e as MPPError
      })

    expect(caught).toBeInstanceOf(MPPError)
    expect(caught?.code).toBe('challenge_expired')
    // Critical: the on-chain payment has happened. The error must
    // expose enough state to resume verification without re-paying.
    expect(caught?.recoverable).toBeDefined()
    expect(caught?.recoverable?.txHash).toBe('0xpaidtx')
    expect(caught?.recoverable?.challenge.challengeId).toBe('ch_abc')
    expect(caught?.recoverable?.challenge.mac).toBe('mac')
    // Snapshot the payer at pay() time so retry is independent of
    // the current signer state (wallet may have disconnected or
    // switched accounts between pay() failing and retry).
    expect(caught?.recoverable?.payerAddr).toBe(FAKE_PAYER)
  })

  it('does NOT attach recoverable when failure is pre-payment (challenge request)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = queuedFetch([{ status: 404, body: { error: 'route_not_found' } }])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    let caught: MPPError | undefined
    await client
      .pay({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
      .catch((e) => {
        caught = e as MPPError
      })

    expect(caught?.code).toBe('route_not_found')
    expect(caught?.recoverable).toBeUndefined()
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('preserves an existing recoverable on re-thrown verify error rather than re-wrapping', async () => {
    // Indirect test: the catch in pay() checks for an existing
    // recoverable before constructing a new one. If verifyChallenge
    // already set one (it doesn't today, but the design preserves
    // any future provenance), pay() should not clobber it.
    transferMock.mockResolvedValue({ hash: '0xpaidtx' })
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = queuedFetch([
      { status: 402, body: VALID_CHALLENGE },
      { status: 401, body: { error: 'payer_mismatch' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    let caught: MPPError | undefined
    await client
      .pay({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
      .catch((e) => {
        caught = e as MPPError
      })

    // Even though verifyChallenge throws without a recoverable, pay()
    // wraps to attach one. The httpStatus from the original error is
    // preserved on the wrapped error.
    expect(caught?.code).toBe('payer_mismatch')
    expect(caught?.httpStatus).toBe(401)
    expect(caught?.recoverable?.txHash).toBe('0xpaidtx')
  })
})

describe('MPPClient.pay replacement following (unbound Pending)', () => {
  beforeEach(() => {
    transferMock.mockReset()
  })

  it('follows a fee-bump (speed up) replacement and verifies the new hash', async () => {
    const hash1 = '0x' + '1'.repeat(64)
    const hash2 = '0x' + '2'.repeat(64)
    // A genuine fee-bump keeps the SAME payment (to = token contract, data =
    // transfer calldata); only gas changes. The watcher follows only when
    // (to, data) match the original.
    const TOKEN = '0x' + 'a'.repeat(40)
    const DATA = '0xa9059cbb' + '0'.repeat(128)
    const replacementTx = { hash: hash2, to: TOKEN, data: DATA, wait: vi.fn().mockResolvedValue({}) }
    // The original tx is fee-bumped: ethers v6 reports this as a
    // TRANSACTION_REPLACED rejection from wait() carrying the replacement.
    const tx1 = {
      hash: hash1,
      to: TOKEN,
      data: DATA,
      wait: vi.fn().mockRejectedValue({
        code: 'TRANSACTION_REPLACED',
        reason: 'repriced',
        replacement: replacementTx,
      }),
    }
    transferMock.mockResolvedValue(tx1)

    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, bodies } = recordingFetch([
      { status: 402, body: VALID_CHALLENGE },
      { status: 202, headers: { 'Retry-After': '1' } }, // poll #1 (hash1): pending
      { status: 200, headers: { 'Payment-Receipt': makeReceipt({ receipt_id: 'r1' }) } }, // poll #2 (hash2): settled
    ])

    const phases: string[] = []
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })
    const result = await client.pay({
      merchantId: 'm1',
      routeCanonical: 'GET:api',
      requestCanonical: 'GET:api:v1',
      onPhase: (ph) => phases.push(ph),
    })

    // Settled on the REPLACEMENT hash, not the original.
    expect(result.txHash).toBe(hash2)
    expect(phases).toContain('transaction_replaced')

    // The first verify poll carried the original hash; the watcher then
    // redirected polling to the replacement for the second poll.
    const verifyBodies = bodies.filter((b) => b.tx_hash !== undefined)
    expect(verifyBodies).toHaveLength(2)
    expect(verifyBodies[0].tx_hash).toBe(hash1)
    expect(verifyBodies[1].tx_hash).toBe(hash2)
  })

  it('does NOT follow a user-cancelled replacement', async () => {
    const hash1 = '0x' + '1'.repeat(64)
    const cancelHash = '0x' + '9'.repeat(64)
    const cancelTx = { hash: cancelHash, wait: vi.fn().mockResolvedValue({}) }
    const tx1 = {
      hash: hash1,
      wait: vi.fn().mockRejectedValue({
        code: 'TRANSACTION_REPLACED',
        reason: 'cancelled', // a cancel sends 0 to self — never satisfies the payment
        replacement: cancelTx,
      }),
    }
    transferMock.mockResolvedValue(tx1)

    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, bodies } = recordingFetch([
      { status: 402, body: VALID_CHALLENGE },
      { status: 200, headers: { 'Payment-Receipt': makeReceipt({ receipt_id: 'r1' }) } },
    ])

    const phases: string[] = []
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })
    const result = await client.pay({
      merchantId: 'm1',
      routeCanonical: 'GET:api',
      requestCanonical: 'GET:api:v1',
      onPhase: (ph) => phases.push(ph),
    })

    // Polling stays on the original hash; the cancel hash is never used.
    expect(phases).not.toContain('transaction_replaced')
    expect(result.txHash).toBe(hash1)
    const verifyBodies = bodies.filter((b) => b.tx_hash !== undefined)
    expect(verifyBodies.every((b) => b.tx_hash === hash1)).toBe(true)
  })

  it('does NOT follow a same-nonce replacement to a different (non-payment) tx', async () => {
    const hash1 = '0x' + '1'.repeat(64)
    const otherHash = '0x' + '7'.repeat(64)
    const TOKEN = '0x' + 'a'.repeat(40)
    const DATA = '0xa9059cbb' + '0'.repeat(128)
    // Same-nonce replacement, but to a DIFFERENT contract / calldata — i.e.
    // the user replaced the payment with an unrelated tx, not a fee-bump.
    const otherTx = {
      hash: otherHash,
      to: '0x' + 'c'.repeat(40),
      data: '0xdeadbeef',
      wait: vi.fn().mockResolvedValue({}),
    }
    const tx1 = {
      hash: hash1,
      to: TOKEN,
      data: DATA,
      wait: vi.fn().mockRejectedValue({
        code: 'TRANSACTION_REPLACED',
        reason: 'replaced',
        replacement: otherTx,
      }),
    }
    transferMock.mockResolvedValue(tx1)

    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, bodies } = recordingFetch([
      { status: 402, body: VALID_CHALLENGE },
      { status: 200, headers: { 'Payment-Receipt': makeReceipt({ receipt_id: 'r1' }) } },
    ])

    const phases: string[] = []
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })
    const result = await client.pay({
      merchantId: 'm1',
      routeCanonical: 'GET:api',
      requestCanonical: 'GET:api:v1',
      onPhase: (ph) => phases.push(ph),
    })

    // A non-payment replacement is ignored: polling stays on the original.
    expect(phases).not.toContain('transaction_replaced')
    expect(result.txHash).toBe(hash1)
    const verifyBodies = bodies.filter((b) => b.tx_hash !== undefined)
    expect(verifyBodies.every((b) => b.tx_hash === hash1)).toBe(true)
  })
})
