/**
 * Tests for MPPClient.payChallenge (B-3).
 *
 * After codex round 12, payChallenge no longer waits for tx.wait(1):
 * the broadcast hash is returned immediately so pay() can call verify
 * before the challenge expires. Tests focus on:
 *   - expiry pre-check (refuses to broadcast on a stale challenge)
 *   - chain_mismatch pre-check
 *   - return-hash success path
 *   - user_rejected mapping (both ethers v6 + EIP-1193)
 *   - payment_failed for arbitrary transfer rejection
 *
 * The previous tx.wait()-based tests (status=0 revert, TRANSACTION_REPLACED
 * speed-up / cancel / replacement-revert) are no longer reachable
 * because payChallenge doesn't call wait(). Those edge cases are now
 * handled by the verify-side settler (status=0 → bad_request) or
 * surface as verify_timeout (speed-up: original hash never mines).
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
import type { MPPChallenge } from '../types.js'

const CHAIN_ID = 42431

// expiryUnix is far in the future so the pre-check doesn't trip on
// tests that depend on signer / transfer mocks. The expiry-check
// test below uses its own past-expiry challenge.
const CHALLENGE: MPPChallenge = {
  challengeId: 'ch_abc',
  expiryUnix: 9_999_999_999,
  amountWei: '1000000',
  chainId: CHAIN_ID,
  tokenContract: '0x' + 'a'.repeat(40),
  recipient: '0x' + 'b'.repeat(40),
  mac: 'mac',
  routePricingVersion: 1,
}

function mockSigner(chainId = CHAIN_ID): ethers.Signer {
  const provider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(chainId) } as ethers.Network),
  }
  const signer = {
    getAddress: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
    provider,
  }
  return signer as unknown as ethers.Signer
}

beforeEach(() => {
  transferMock.mockReset()
})

describe('MPPClient.payChallenge', () => {
  it('returns the broadcast tx hash immediately (no tx.wait)', async () => {
    // Mock includes a wait() that throws to prove it is NOT called.
    transferMock.mockResolvedValue({
      hash: '0xdeadbeef',
      wait: vi.fn().mockRejectedValue(new Error('wait should not be called')),
    })
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    const { txHash } = await client.payChallenge(CHALLENGE)
    expect(txHash).toBe('0xdeadbeef')
    expect(transferMock).toHaveBeenCalledWith(CHALLENGE.recipient, BigInt(CHALLENGE.amountWei))
  })

  it('throws challenge_expired BEFORE opening the wallet when challenge.expiryUnix is in the past', async () => {
    // Critical: stale challenge must not initiate a wallet popup.
    // The buyer would otherwise sign a transfer that Core will refuse
    // to verify, stranding their on-chain payment.
    const expired: MPPChallenge = { ...CHALLENGE, expiryUnix: 1_700_000_000 }
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      // Clock pinned well past the expiry.
      clock: () => 2_000_000_000_000,
    })

    await expect(client.payChallenge(expired)).rejects.toMatchObject({ code: 'challenge_expired' })
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('throws chain_mismatch when signer is on a different chain', async () => {
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(1),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(client.payChallenge(CHALLENGE)).rejects.toMatchObject({ code: 'chain_mismatch' })
    expect(transferMock).not.toHaveBeenCalled()
  })

  it('throws user_rejected when the wallet rejects (ethers v6 ACTION_REJECTED)', async () => {
    transferMock.mockRejectedValue(
      Object.assign(new Error('user rejected'), { code: 'ACTION_REJECTED' })
    )
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(client.payChallenge(CHALLENGE)).rejects.toMatchObject({ code: 'user_rejected' })
  })

  it('throws user_rejected when the wallet rejects (EIP-1193 code 4001)', async () => {
    transferMock.mockRejectedValue(Object.assign(new Error('user rejected'), { code: 4001 }))
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(client.payChallenge(CHALLENGE)).rejects.toMatchObject({ code: 'user_rejected' })
  })

  it('throws payment_failed when the transfer rejects with a non-rejection error', async () => {
    transferMock.mockRejectedValue(new Error('rpc dropped connection'))
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(client.payChallenge(CHALLENGE)).rejects.toMatchObject({ code: 'payment_failed' })
  })

  it('throws payment_failed when the broadcast somehow returns an empty hash', async () => {
    transferMock.mockResolvedValue({ hash: '' })
    const client = new MPPClient({
      coreUrl: 'http://core.test',
      signer: mockSigner(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    await expect(client.payChallenge(CHALLENGE)).rejects.toMatchObject({ code: 'payment_failed' })
  })
})
