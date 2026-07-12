import { describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  ERC20Token,
  type ApprovalOptions,
  type ERC20ContractLike,
} from '../contracts/erc20.js'

type FakeContract = {
  allowance: ReturnType<typeof vi.fn>
  approve: ReturnType<typeof vi.fn>
  decimals: ReturnType<typeof vi.fn>
}

function tokenWithContract(contract: FakeContract): ERC20Token {
  // Single comparability-checked assertion: vi.fn() returns unknown, which is
  // not assignable to the interface's typed promises.
  const full = {
    balanceOf: vi.fn(),
    symbol: vi.fn(),
    transfer: vi.fn(),
    ...contract,
  } as ERC20ContractLike
  return new ERC20Token(full)
}

function transaction(
  status = 1,
  fields: Partial<ethers.TransactionResponse> = {}
): ethers.TransactionResponse {
  return {
    wait: vi.fn().mockResolvedValue({ status }),
    ...fields,
  } as unknown as ethers.TransactionResponse
}

describe('ERC20Token', () => {
  it('normalizes ethers uint8 decimals from bigint to number', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn().mockResolvedValue(18n),
    }
    const token = tokenWithContract(contract)

    await expect(token.decimals()).resolves.toBe(18)
  })

  it('approves the exact requested amount by default', async () => {
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.ensureApproval('0xowner', '0xspender', 25n)

    expect(result).toEqual({ needed: true, tx: finalTx })
    expect(contract.approve).toHaveBeenCalledOnce()
    expect(contract.approve).toHaveBeenCalledWith('0xspender', 25n)
    expect(finalTx.wait).toHaveBeenCalledOnce()
  })

  it('makes unlimited approval an explicit opt-in', async () => {
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await token.ensureApproval('0xowner', '0xspender', 25n, { unlimited: true })

    expect(contract.approve).toHaveBeenCalledWith('0xspender', ethers.MaxUint256)
  })

  it('confirms a zero reset before changing a non-zero allowance', async () => {
    const resetTx = transaction()
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockResolvedValueOnce(resetTx).mockResolvedValueOnce(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(contract.approve.mock.calls).toEqual([
      ['0xspender', 0n],
      ['0xspender', 25n],
    ])
    expect(resetTx.wait).toHaveBeenCalledOnce()
    expect(finalTx.wait).toHaveBeenCalledOnce()
    expect(result).toEqual({ tx: finalTx, resetTx })
  })

  it('skips the reset when the token accepts a direct non-zero overwrite', async () => {
    const finalTx = transaction()
    const approve = Object.assign(vi.fn().mockResolvedValue(finalTx), {
      staticCall: vi.fn().mockResolvedValue(true),
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve,
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(approve.staticCall).toHaveBeenCalledWith('0xspender', 25n)
    expect(approve).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledWith('0xspender', 25n)
    expect(result).toEqual({ tx: finalTx })
  })

  it('falls back to the reset path when the direct-write simulation reverts', async () => {
    const resetTx = transaction()
    const finalTx = transaction()
    const approve = Object.assign(
      vi.fn().mockResolvedValueOnce(resetTx).mockResolvedValueOnce(finalTx),
      { staticCall: vi.fn().mockRejectedValue(new Error('USDT-style revert')) }
    )
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve,
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(approve.mock.calls).toEqual([
      ['0xspender', 0n],
      ['0xspender', 25n],
    ])
    expect(result).toEqual({ tx: finalTx, resetTx })
  })

  it('falls back to the reset path when the simulation returns false', async () => {
    const resetTx = transaction()
    const finalTx = transaction()
    const approve = Object.assign(
      vi.fn().mockResolvedValueOnce(resetTx).mockResolvedValueOnce(finalTx),
      { staticCall: vi.fn().mockResolvedValue(false) }
    )
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve,
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(approve.mock.calls).toEqual([
      ['0xspender', 0n],
      ['0xspender', 25n],
    ])
    expect(result).toEqual({ tx: finalTx, resetTx })
  })

  it('keeps the existing allowance intact when a probed direct approval fails', async () => {
    const failedTx = transaction(0)
    const approve = Object.assign(vi.fn().mockResolvedValue(failedTx), {
      staticCall: vi.fn().mockResolvedValue(true),
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve,
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    // No reset was sent, so the failure message is the plain one and the
    // pre-existing allowance is untouched on-chain.
    await expect(token.setApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'approval transaction failed'
    )
    expect(approve).toHaveBeenCalledOnce()
    expect(approve).not.toHaveBeenCalledWith('0xspender', 0n)
  })

  it('probes before ensureApproval replaces an insufficient allowance', async () => {
    const finalTx = transaction()
    const approve = Object.assign(vi.fn().mockResolvedValue(finalTx), {
      staticCall: vi.fn().mockResolvedValue(true),
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve,
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.ensureApproval('0xowner', '0xspender', 25n)

    expect(approve).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledWith('0xspender', 25n)
    expect(result).toEqual({ needed: true, tx: finalTx })
  })

  it('sends nothing when explicitly setting an allowance to its current value', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(25n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(contract.approve).not.toHaveBeenCalled()
    expect(result).toEqual({})
  })

  it('sends nothing when the allowance is already unlimited and unlimited is requested', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(ethers.MaxUint256),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n, {
      unlimited: true,
    })

    expect(contract.approve).not.toHaveBeenCalled()
    expect(result).toEqual({})
  })

  it('revokes an allowance with one confirmed approve(0) transaction', async () => {
    const revokeTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(5n),
      approve: vi.fn().mockResolvedValue(revokeTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 0n)

    expect(contract.approve).toHaveBeenCalledOnce()
    expect(contract.approve).toHaveBeenCalledWith('0xspender', 0n)
    expect(revokeTx.wait).toHaveBeenCalledOnce()
    expect(result).toEqual({ tx: revokeTx })
  })

  it('skips the transaction when revoking an already-zero allowance', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 0n)

    expect(contract.approve).not.toHaveBeenCalled()
    expect(result).toEqual({})
  })

  it('continues after a successful fee-bump replacement of the zero reset', async () => {
    const resetReplacement = transaction(1, {
      hash: '0xreset-replacement',
      to: '0xtoken',
      data: '0xreset',
    })
    const submittedReset = transaction(1, {
      to: '0xtoken',
      data: '0xreset',
    })
    ;(submittedReset.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: resetReplacement,
      receipt: { status: 1 },
    })
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockResolvedValueOnce(submittedReset).mockResolvedValueOnce(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(contract.approve.mock.calls).toEqual([
      ['0xspender', 0n],
      ['0xspender', 25n],
    ])
    expect(result).toEqual({ tx: finalTx, resetTx: resetReplacement })
  })

  it('returns a successful fee-bump replacement of the final approval', async () => {
    const finalReplacement = transaction(1, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: finalReplacement,
      receipt: { status: 1 },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({
      needed: true,
      tx: finalReplacement,
    })
  })

  it('accepts a repriced replacement that omits the cancelled flag', async () => {
    const finalReplacement = transaction(1, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      replacement: finalReplacement,
      receipt: { status: 1 },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({
      needed: true,
      tx: finalReplacement,
    })
  })

  it("accepts a matched replacement labelled 'replaced' once it confirms", async () => {
    const finalReplacement = transaction(1, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    // ethers labels a same-calldata replacement 'replaced' (cancelled: true)
    // when its value differs; wrappers may omit reason entirely, which the
    // classifier also defaults to 'replaced'. Both must be followed.
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'replaced',
      cancelled: true,
      replacement: finalReplacement,
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({
      needed: true,
      tx: finalReplacement,
    })
  })

  it("rejects a matched replacement whose reason is 'cancelled'", async () => {
    const finalReplacement = transaction(1, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'cancelled',
      cancelled: true,
      replacement: finalReplacement,
      receipt: { status: 1, hash: '0xfinal-replacement' },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'approval transaction failed'
    )
  })

  it("follows a 'replaced' fee-bump of the zero reset through to success", async () => {
    const resetReplacement = transaction(1, {
      hash: '0xreset-replacement',
      to: '0xtoken',
      data: '0xreset',
    })
    const submittedReset = transaction(1, {
      to: '0xtoken',
      data: '0xreset',
    })
    ;(submittedReset.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'replaced',
      replacement: resetReplacement,
    })
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockResolvedValueOnce(submittedReset).mockResolvedValueOnce(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    const result = await token.setApproval('0xowner', '0xspender', 25n)

    expect(result).toEqual({ tx: finalTx, resetTx: resetReplacement })
  })

  it('rejects a same-nonce replacement that changes the approval call', async () => {
    const differentReplacement = transaction(1, {
      hash: '0xdifferent-replacement',
      to: '0xtoken',
      data: '0xdifferent',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'replaced',
      cancelled: true,
      replacement: differentReplacement,
      receipt: { status: 1 },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'approval transaction failed'
    )
  })

  it('does not submit a transaction when the exact allowance is sufficient', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(25n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({ needed: false })
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('does not replace an allowance that is already larger than requested', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(100n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({ needed: false })

    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('keeps a sufficient finite allowance even when unlimited approval is requested', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(1000n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(
      token.ensureApproval('0xowner', '0xspender', 25n, { unlimited: true })
    ).resolves.toEqual({ needed: false })

    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('treats a zero amount as always satisfied in ensureApproval', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 0n)).resolves.toEqual({
      needed: false,
    })
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('rejects a non-bigint amount before any transaction', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(
      token.ensureApproval('0xowner', '0xspender', undefined as unknown as bigint)
    ).rejects.toThrow('approval amount must be a bigint')
    await expect(
      token.setApproval('0xowner', '0xspender', 0 as unknown as bigint, { unlimited: true })
    ).rejects.toThrow('approval amount must be a bigint')

    expect(contract.allowance).not.toHaveBeenCalled()
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('rejects negative and oversized amounts before any transaction', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.setApproval('0xowner', '0xspender', -1n)).rejects.toThrow(
      'approval amount must not be negative'
    )
    await expect(
      token.ensureApproval('0xowner', '0xspender', ethers.MaxUint256 + 1n)
    ).rejects.toThrow('approval amount exceeds uint256 range')

    expect(contract.allowance).not.toHaveBeenCalled()
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean unlimited option before any transaction', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(
      token.ensureApproval('0xowner', '0xspender', 25n, {
        unlimited: 'false' as unknown as boolean,
      })
    ).rejects.toThrow('unlimited option must be a boolean')

    expect(contract.allowance).not.toHaveBeenCalled()
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('reads the unlimited option exactly once so a getter cannot bypass validation', async () => {
    const finalTx = transaction()
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)
    let reads = 0
    const options = {
      get unlimited() {
        // undefined on the validation read, truthy afterwards — the TOCTOU
        // shape that previously wrote MaxUint256 past the validation.
        return reads++ === 0 ? undefined : true
      },
    }

    await token.setApproval('0xowner', '0xspender', 5n, options)

    expect(reads).toBe(1)
    expect(contract.approve).toHaveBeenCalledWith('0xspender', 5n)
  })

  it('ignores a replacement receipt that does not belong to the replacement', async () => {
    // Mismatched status-1 receipt must NOT produce a false success: the real
    // replacement reverts, so the approval must fail.
    const revertedReplacement = transaction(0, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: revertedReplacement,
      receipt: { status: 1, hash: '0xsome-other-transaction' },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'approval transaction failed'
    )
    expect(revertedReplacement.wait).toHaveBeenCalledOnce()
  })

  it('recovers from a mismatched failed receipt by waiting on the replacement itself', async () => {
    // Mismatched status-0 receipt must NOT produce a false failure: the real
    // replacement succeeds when waited on directly.
    const minedReplacement = transaction(1, {
      hash: '0xfinal-replacement',
      to: '0xtoken',
      data: '0xapprove',
    })
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: minedReplacement,
      receipt: { status: 0, hash: '0xsome-other-transaction' },
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.ensureApproval('0xowner', '0xspender', 25n)).resolves.toEqual({
      needed: true,
      tx: minedReplacement,
    })
  })

  it('fails closed on a cyclic replacement chain', async () => {
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    const cyclicReplacement = transaction(1, {
      hash: '0xcycle',
      to: '0xtoken',
      data: '0xapprove',
    })
    // The replacement keeps reporting itself as replaced by the same hash.
    ;(cyclicReplacement.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: cyclicReplacement,
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: cyclicReplacement,
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    try {
      await token.ensureApproval('0xowner', '0xspender', 25n)
      throw new Error('expected ensureApproval to reject')
    } catch (error) {
      expect((error as Error).message).toBe('approval transaction failed')
      expect(((error as Error & { cause?: unknown }).cause as Error).message).toBe(
        'approval transaction was replaced too many times'
      )
    }
  })

  it('fails closed when a provider feeds an endless replacement chain', async () => {
    const makeReplaced = (depth: number): ethers.TransactionResponse => {
      const tx = transaction(1, {
        hash: `0xreplacement-${depth}`,
        to: '0xtoken',
        data: '0xapprove',
      })
      ;(tx.wait as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.reject({
          code: 'TRANSACTION_REPLACED',
          reason: 'repriced',
          cancelled: false,
          replacement: makeReplaced(depth + 1),
        })
      )
      return tx
    }
    const submittedFinal = transaction(1, {
      to: '0xtoken',
      data: '0xapprove',
    })
    ;(submittedFinal.wait as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'TRANSACTION_REPLACED',
      reason: 'repriced',
      cancelled: false,
      replacement: makeReplaced(0),
    })
    const contract = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue(submittedFinal),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    try {
      await token.ensureApproval('0xowner', '0xspender', 25n)
      throw new Error('expected ensureApproval to reject')
    } catch (error) {
      expect((error as Error).message).toBe('approval transaction failed')
      expect(((error as Error & { cause?: unknown }).cause as Error).message).toBe(
        'approval transaction was replaced too many times'
      )
    }
  })

  it('wraps a wallet rejection of the reset submit in the reset-specific error', async () => {
    const walletRejection = new Error('user rejected transaction')
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockRejectedValueOnce(walletRejection),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    try {
      await token.setApproval('0xowner', '0xspender', 25n)
      throw new Error('expected setApproval to reject')
    } catch (error) {
      expect((error as Error).message).toBe('allowance reset transaction failed')
      expect((error as Error & { cause?: unknown }).cause).toBe(walletRejection)
    }
    expect(contract.approve).toHaveBeenCalledOnce()
  })

  it('rejects null or non-object approval options before any transaction', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(
      token.setApproval('0xowner', '0xspender', 25n, null as unknown as ApprovalOptions)
    ).rejects.toThrow('approval options must be an object')
    await expect(
      token.ensureApproval('0xowner', '0xspender', 25n, [] as unknown as ApprovalOptions)
    ).rejects.toThrow('approval options must be an object')

    expect(contract.allowance).not.toHaveBeenCalled()
    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('rejects junk constructor input instead of failing later', () => {
    expect(() => new ERC20Token(undefined as unknown as ERC20ContractLike)).toThrow(
      'ERC20Token requires a token address string or a contract instance'
    )
    expect(() => new ERC20Token({} as ERC20ContractLike)).toThrow(
      'ERC20Token requires a token address string or a contract instance'
    )
    // A partial surface must fail at construction, not later at balanceOf().
    expect(
      () =>
        new ERC20Token({
          allowance: vi.fn(),
          approve: vi.fn(),
        } as unknown as ERC20ContractLike)
    ).toThrow('ERC20Token requires a token address string or a contract instance')
  })

  it('rejects a zero amount combined with unlimited approval', async () => {
    const contract = {
      allowance: vi.fn(),
      approve: vi.fn(),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(
      token.setApproval('0xowner', '0xspender', 0n, { unlimited: true })
    ).rejects.toThrow('zero amount cannot be combined with unlimited approval')

    expect(contract.approve).not.toHaveBeenCalled()
  })

  it('fails closed when the zero reset transaction fails', async () => {
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockResolvedValue(transaction(0)),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.setApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'allowance reset transaction failed'
    )
    expect(contract.approve).toHaveBeenCalledOnce()
  })

  it('reports when the final approval fails after a confirmed zero reset', async () => {
    const resetTx = transaction()
    const finalTx = transaction(0)
    const contract = {
      allowance: vi.fn().mockResolvedValue(10n),
      approve: vi.fn().mockResolvedValueOnce(resetTx).mockResolvedValueOnce(finalTx),
      decimals: vi.fn(),
    }
    const token = tokenWithContract(contract)

    await expect(token.setApproval('0xowner', '0xspender', 25n)).rejects.toThrow(
      'final approval failed after the allowance was reset to zero'
    )
    expect(resetTx.wait).toHaveBeenCalledOnce()
    expect(finalTx.wait).toHaveBeenCalledOnce()
  })
})
