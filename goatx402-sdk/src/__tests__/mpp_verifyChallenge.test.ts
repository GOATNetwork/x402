/**
 * Tests for MPPClient.verifyChallenge (B-4).
 *
 * Focus: 200 happy path with valid 3-segment Payment-Receipt; 202
 * retry-after polling; 4xx terminal codes; receipt parse failures;
 * 5xx retry; fake clock + sleep injection so no real timers fire.
 */
import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import { MPPClient } from '../mpp.js'
import type { MPPChallenge } from '../types.js'

const FAKE_PAYER = '0x1111111111111111111111111111111111111111'
const CHALLENGE: MPPChallenge = {
  challengeId: 'ch_abc',
  expiryUnix: 1_700_000_000,
  amountWei: '1000000',
  chainId: 42431,
  tokenContract: '0x' + 'a'.repeat(40),
  recipient: '0x' + 'b'.repeat(40),
  mac: 'mac',
  routePricingVersion: 1,
}

function mockSigner(): ethers.Signer {
  return {
    getAddress: vi.fn().mockResolvedValue(FAKE_PAYER),
    provider: null,
  } as unknown as ethers.Signer
}

/**
 * Encode a payload object as the base64url first segment of a
 * Payment-Receipt header. Tests only need a syntactically valid 3-segment
 * shape; signature + alg segments are arbitrary placeholders.
 */
function makeReceipt(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${b64}.sig.alg`
}

interface QueuedResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function queuedFetch(responses: QueuedResponse[]): {
  fn: typeof fetch
  callCount: () => number
} {
  let i = 0
  const fn = vi.fn().mockImplementation(async () => {
    if (i >= responses.length) {
      throw new Error(`queuedFetch exhausted — call #${i + 1} not staged`)
    }
    const r = responses[i++]
    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
    } as unknown as Response
  })
  return { fn: fn as unknown as typeof fetch, callCount: () => i }
}

describe('MPPClient.verifyChallenge', () => {
  it('returns the receipt on 200 with a valid Payment-Receipt header', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1', amount_wei: '1000000' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    const result = await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(result.receiptHeader).toBe(receiptHeader)
    expect(result.receiptBody.receipt_id).toBe('r1')
    expect(result.challengeId).toBe(CHALLENGE.challengeId)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('polls past 202 + Retry-After then succeeds, never calling real sleep', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl, callCount } = queuedFetch([
      { status: 202, body: {}, headers: { 'Retry-After': '1' } },
      { status: 202, body: {}, headers: { 'Retry-After': '2' } },
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    const result = await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(result.receiptHeader).toBe(receiptHeader)
    expect(callCount()).toBe(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 1000)
    expect(sleep).toHaveBeenNthCalledWith(2, 2000)
  })

  it('clamps Retry-After to MAX_RETRY_AFTER_SECONDS (30s) — server cannot stall the SDK', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 202, body: {}, headers: { 'Retry-After': '9999' } },
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(sleep).toHaveBeenCalledWith(30_000)
  })

  it('falls back to a default Retry-After when the header is missing', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 202, body: {} },
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    // DEFAULT_RETRY_AFTER_SECONDS == 2
    expect(sleep).toHaveBeenCalledWith(2000)
  })

  it('throws verify_timeout when maxAttempts of 202 responses are exhausted', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl } = queuedFetch([
      { status: 202, body: {}, headers: { 'Retry-After': '1' } },
      { status: 202, body: {}, headers: { 'Retry-After': '1' } },
      { status: 202, body: {}, headers: { 'Retry-After': '1' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx', maxAttempts: 3 })
    ).rejects.toMatchObject({ code: 'verify_timeout' })
    expect(sleep).toHaveBeenCalledTimes(2) // No sleep after the final attempt.
  })

  it('throws the backend error code on 401 challenge_expired (no retry)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, callCount } = queuedFetch([
      { status: 401, body: { error: 'challenge_expired' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    ).rejects.toMatchObject({ code: 'challenge_expired', httpStatus: 401 })
    expect(callCount()).toBe(1)
  })

  it('throws challenge_already_consumed on 401 — no retry', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, callCount } = queuedFetch([
      { status: 401, body: { error: 'challenge_already_consumed' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    ).rejects.toMatchObject({ code: 'challenge_already_consumed' })
    expect(callCount()).toBe(1)
  })

  it('retries 5xx with backoff and succeeds on a later 200', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 503, body: { error: 'service_unavailable' } },
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    const result = await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(result.receiptHeader).toBe(receiptHeader)
    expect(sleep).toHaveBeenCalledTimes(1) // One backoff between the 503 and 200.
  })

  it('throws receipt_missing when 200 has no Payment-Receipt header', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl } = queuedFetch([{ status: 200, body: {} }])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    ).rejects.toMatchObject({ code: 'receipt_missing' })
  })

  it('throws receipt_malformed when Payment-Receipt does not have 3 segments', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl } = queuedFetch([
      { status: 200, body: {}, headers: { 'Payment-Receipt': 'only.two' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    ).rejects.toMatchObject({ code: 'receipt_malformed' })
  })

  it('sends snake_case verify wire body with mac echo', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(call[0]).toBe('http://core.test/mpp/v1/verify')
    const sent = JSON.parse((call[1] as RequestInit).body as string)
    expect(sent).toEqual({
      challenge_id: CHALLENGE.challengeId,
      tx_hash: '0xtx',
      payer_addr: FAKE_PAYER,
      mac: CHALLENGE.mac,
    })
  })

  it('retries verify after a transient fetch rejection and succeeds on a later 200', async () => {
    // Critical post-payment recovery: after the buyer has sent the
    // ERC-20 transfer, a network blip during verify polling must not
    // discard the binding. SDK should back off and re-poll until the
    // attempt budget is exhausted.
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    let call = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call++
      if (call === 1) throw new Error('network down')
      return {
        status: 200,
        headers: new Headers({ 'Payment-Receipt': receiptHeader }),
        json: async () => ({}),
      } as unknown as Response
    }) as unknown as typeof fetch
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    const result = await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(result.receiptHeader).toBe(receiptHeader)
    expect(sleep).toHaveBeenCalledTimes(1) // One backoff after the network error.
  })

  it('throws network_error only after exhausting maxAttempts of fetch rejections', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn().mockRejectedValue(new Error('refused')) as unknown as typeof fetch
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx', maxAttempts: 2 })
    ).rejects.toMatchObject({ code: 'network_error' })
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2)
  })

  it('treats 429 rate_limited like 202: retries with Retry-After, succeeds on a later 200', async () => {
    // Critical: after the buyer has already sent the on-chain
    // transfer, a 429 leaves the challenge Pending — there is nothing
    // the buyer can do to "fix" rate-limiting except wait. Letting
    // the SDK back off and re-poll keeps the tx recoverable.
    const sleep = vi.fn().mockResolvedValue(undefined)
    const receiptHeader = makeReceipt({ receipt_id: 'r1' })
    const { fn: fetchImpl } = queuedFetch([
      { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '3' } },
      { status: 200, body: {}, headers: { 'Payment-Receipt': receiptHeader } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    const result = await client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    expect(result.receiptHeader).toBe(receiptHeader)
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('throws verify_timeout when 429 responses exhaust maxAttempts', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl } = queuedFetch([
      { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '1' } },
      { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '1' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx', maxAttempts: 2 })
    ).rejects.toMatchObject({ code: 'verify_timeout', httpStatus: 429 })
  })

  it('throws bad_request on 400 with backend detail (no retry)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { fn: fetchImpl, callCount } = queuedFetch([
      { status: 400, body: { error: 'bad_request', detail: 'settle validation failed' } },
    ])
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
      sleep,
    })

    await expect(
      client.verifyChallenge({ challenge: CHALLENGE, txHash: '0xtx' })
    ).rejects.toMatchObject({ code: 'bad_request', httpStatus: 400 })
    expect(callCount()).toBe(1)
  })
})
