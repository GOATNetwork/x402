/**
 * Tests for MPPClient.requestChallenge (B-2).
 *
 * Focus: the request body shape (camelCase → snake_case conversion),
 * the 402-is-success spec quirk, and typed error propagation for
 * non-402 responses.
 */
import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import { MPPClient } from '../mpp.js'
import { MPPError } from '../types.js'

const FAKE_PAYER = '0x1111111111111111111111111111111111111111'

function mockSigner(): ethers.Signer {
  const signer = {
    getAddress: vi.fn().mockResolvedValue(FAKE_PAYER),
    provider: null,
  }
  return signer as unknown as ethers.Signer
}

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  const h = new Headers(headers)
  const r = {
    status,
    headers: h,
    json: async () => body,
  } as unknown as Response
  return vi.fn().mockResolvedValue(r) as unknown as typeof fetch
}

// Core's ChallengeResponse uses JSON tag "expiry" (see
// internal/mpp/handler/challenge_handler.go:94). Fixture mirrors the
// real wire shape exactly so the parse_error guard tests actually
// exercise the same field name the decoder reads.
const VALID_CHALLENGE_BODY = {
  challenge_id: 'ch_abc',
  expiry: 1_700_000_000,
  amount_wei: '1000000',
  chain_id: 42431,
  token_contract: '0x' + 'a'.repeat(40),
  recipient: '0x' + 'b'.repeat(40),
  mac: 'mac-hex',
  route_pricing_version: 1,
}

describe('MPPClient.requestChallenge', () => {
  it('returns the decoded challenge on HTTP 402 with a complete body', async () => {
    const fetchImpl = mockFetch(402, VALID_CHALLENGE_BODY)
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl,
    })

    const ch = await client.requestChallenge({
      merchantId: 'm1',
      routeCanonical: 'GET:api:protected',
      requestCanonical: 'GET:api:protected:v1',
    })

    expect(ch.challengeId).toBe('ch_abc')
    expect(ch.amountWei).toBe('1000000')
    expect(ch.chainId).toBe(42431)
    expect(ch.routePricingVersion).toBe(1)
  })

  it('sends snake_case wire body (challenge wire contract)', async () => {
    const fetchImpl = mockFetch(402, VALID_CHALLENGE_BODY)
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await client.requestChallenge({
      merchantId: 'm1',
      routeCanonical: 'GET:api:protected',
      requestCanonical: 'GET:api:protected:v1',
    })

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(call[0]).toBe('http://core.test/mpp/v1/challenge')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      merchant_id: 'm1',
      route_canonical: 'GET:api:protected',
      request_canonical: 'GET:api:protected:v1',
      payer_addr: FAKE_PAYER,
    })
  })

  it('uses signer.getAddress when payerAddr is not provided', async () => {
    const fetchImpl = mockFetch(402, VALID_CHALLENGE_BODY)
    const signer = mockSigner()
    const client = new MPPClient({ coreUrl: 'http://core.test', signer, fetchImpl })

    await client.requestChallenge({
      merchantId: 'm1',
      routeCanonical: 'r',
      requestCanonical: 'r',
    })
    expect((signer.getAddress as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0)
  })

  it('throws MPPError with the backend error code on 404 route_not_found', async () => {
    const fetchImpl = mockFetch(404, { error: 'route_not_found' })
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await expect(
      client.requestChallenge({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
    ).rejects.toMatchObject({ code: 'route_not_found', httpStatus: 404 })
  })

  it('throws MPPError without auto-retrying on 503 — challenge is not idempotent', async () => {
    // The plan explicitly forbids SDK auto-retry on challenge; a retried
    // /challenge could create duplicate orders. Confirm the SDK throws
    // immediately rather than silently retrying.
    const fetchImpl = mockFetch(503, { error: 'service_unavailable' }, { 'Retry-After': '1' })
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await expect(
      client.requestChallenge({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
    ).rejects.toBeInstanceOf(MPPError)
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1)
  })

  it('throws parse_error when the 402 body is missing a required field', async () => {
    const fetchImpl = mockFetch(402, { ...VALID_CHALLENGE_BODY, challenge_id: undefined })
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await expect(
      client.requestChallenge({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
    ).rejects.toMatchObject({ code: 'parse_error' })
  })

  it('throws parse_error when a required field has the wrong type', async () => {
    const fetchImpl = mockFetch(402, { ...VALID_CHALLENGE_BODY, amount_wei: 1000000 })
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await expect(
      client.requestChallenge({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
    ).rejects.toMatchObject({ code: 'parse_error' })
  })

  it('throws network_error when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('refused')) as unknown as typeof fetch
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    await expect(
      client.requestChallenge({ merchantId: 'm1', routeCanonical: 'r', requestCanonical: 'r' })
    ).rejects.toMatchObject({ code: 'network_error' })
  })

  it('accepts the legacy expiry_unix alias when the canonical expiry key is absent', async () => {
    // Forward-compat: some pre-spec deployments emit expiry_unix.
    // Decoder tolerates both; verified separately so a future spec
    // change that drops the alias doesn't silently break this path.
    const { expiry, ...rest } = VALID_CHALLENGE_BODY
    void expiry
    const fetchImpl = mockFetch(402, { ...rest, expiry_unix: 1_700_000_001 })
    const client = new MPPClient({ coreUrl: 'http://core.test', signer: mockSigner(), fetchImpl })

    const ch = await client.requestChallenge({
      merchantId: 'm1',
      routeCanonical: 'r',
      requestCanonical: 'r',
    })
    expect(ch.expiryUnix).toBe(1_700_000_001)
  })

  it('rejects a coreUrl with a trailing slash at construction time', () => {
    expect(
      () =>
        new MPPClient({
          coreUrl: 'http://core.test/',
          signer: mockSigner(),
          fetchImpl: mockFetch(402, VALID_CHALLENGE_BODY),
        })
    ).toThrow(/trailing slash/)
  })
})
