/**
 * ERC20 Token Contract Helpers
 */

import { ethers } from 'ethers'
import {
  MAX_REPLACEMENT_FOLLOWS,
  replacedTransactionFrom,
} from '../internal/replacement.js'

// Keep the ABI as human-readable fragments instead of importing JSON. A JSON
// import attribute (`with { type: 'json' }`) would still leave the build
// responsible for copying the JSON asset into dist, which tsc does not do.
// Inlining is portable across Node and browser bundlers and keeps clean builds
// self-contained. QuickPay loads this SDK dynamically in Node for MPP payments,
// so the root entry point must remain importable without a bundler.
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
]

export interface ApprovalOptions {
  /** Approve MaxUint256 instead of the exact requested amount. */
  unlimited?: boolean
}

export interface ApprovalUpdate {
  /**
   * The confirmed final approval transaction. Absent when no transaction was
   * needed because the allowance already equaled the requested value
   * (including revoking an already-zero allowance).
   */
  tx?: ethers.TransactionResponse
  /** A confirmed approve(0) transaction used for USDT-style tokens. */
  resetTx?: ethers.TransactionResponse
}

/**
 * An ethers v6 contract method is a callable object; `staticCall` simulates
 * the call via eth_call without sending a transaction. Optional so that
 * minimal contract-like objects (tests, wrappers) remain accepted — without
 * it the USDT-safe reset path is used unconditionally.
 * @internal
 */
export interface ERC20ApproveMethod {
  (spender: string, amount: bigint): Promise<ethers.TransactionResponse>
  staticCall?(spender: string, amount: bigint): Promise<boolean>
}

/**
 * The subset of the ERC20 contract surface used by ERC20Token. ethers decodes
 * uint8 as bigint, hence the widened decimals() return type.
 * @internal
 */
export interface ERC20ContractLike {
  balanceOf(address: string): Promise<bigint>
  allowance(owner: string, spender: string): Promise<bigint>
  decimals(): Promise<bigint | number>
  symbol(): Promise<string>
  approve: ERC20ApproveMethod
  transfer(to: string, amount: bigint): Promise<ethers.TransactionResponse>
}

export class ERC20Token {
  private contract: ERC20ContractLike

  constructor(
    tokenAddress: string,
    signerOrProvider: ethers.Signer | ethers.Provider
  )
  /** @internal Test seam: wrap a preconstructed contract-like object. */
  constructor(contract: ERC20ContractLike)
  constructor(
    tokenAddressOrContract: string | ERC20ContractLike,
    signerOrProvider?: ethers.Signer | ethers.Provider
  ) {
    if (typeof tokenAddressOrContract === 'string') {
      this.contract = new ethers.Contract(
        tokenAddressOrContract,
        ERC20_ABI,
        signerOrProvider
      ) as unknown as ERC20ContractLike
      return
    }
    // Fail fast for plain-JavaScript callers passing junk or a partial object
    // instead of an address; a deferred "not a function" error on any of the
    // contract methods would be far less clear.
    const methods: Array<keyof ERC20ContractLike> = [
      'balanceOf',
      'allowance',
      'decimals',
      'symbol',
      'approve',
      'transfer',
    ]
    if (
      tokenAddressOrContract === null ||
      typeof tokenAddressOrContract !== 'object' ||
      methods.some((m) => typeof tokenAddressOrContract[m] !== 'function')
    ) {
      throw new Error('ERC20Token requires a token address string or a contract instance')
    }
    this.contract = tokenAddressOrContract
  }

  /**
   * Get token balance
   */
  async balanceOf(address: string): Promise<bigint> {
    return this.contract.balanceOf(address)
  }

  /**
   * Get token allowance
   */
  async allowance(owner: string, spender: string): Promise<bigint> {
    return this.contract.allowance(owner, spender)
  }

  /**
   * Get token decimals
   */
  async decimals(): Promise<number> {
    return Number(await this.contract.decimals())
  }

  /**
   * Get token symbol
   */
  async symbol(): Promise<string> {
    return this.contract.symbol()
  }

  /**
   * Approve spender to transfer tokens
   */
  async approve(
    spender: string,
    amount: bigint
  ): Promise<ethers.TransactionResponse> {
    return this.contract.approve(spender, amount)
  }

  /**
   * Transfer tokens to recipient
   */
  async transfer(
    to: string,
    amount: bigint
  ): Promise<ethers.TransactionResponse> {
    return this.contract.transfer(to, amount)
  }

  /**
   * Check if approval is needed and approve only when the current allowance is
   * insufficient for the requested amount. `unlimited` only changes the value
   * written when a new approval is needed; a token that decrements even a
   * MaxUint256 allowance would otherwise never satisfy the check and every
   * call would destructively replace a usable allowance. A zero amount is
   * always satisfied and never submits a transaction (except that zero
   * combined with `{ unlimited: true }` is rejected as an invalid input
   * before the allowance is read). Replacing an insufficient non-zero
   * allowance first simulates the direct write via eth_call: tokens that
   * accept it (standard ERC20s) get a single approval with no reset. Only
   * when the simulation does not positively succeed (USDT-style tokens, or
   * no simulation support) is a confirmed approve(0) reset submitted first;
   * if the final approval then fails or is rejected in the wallet, the
   * allowance remains zero. Returns only after any required final approval
   * is confirmed.
   */
  async ensureApproval(
    owner: string,
    spender: string,
    amount: bigint,
    options: ApprovalOptions = {}
  ): Promise<{ needed: boolean } & Partial<ApprovalUpdate>> {
    const target = this.approvalTarget(amount, options)
    const currentAllowance = await this.allowance(owner, spender)

    if (currentAllowance >= amount) {
      return { needed: false }
    }

    const update = await this.replaceApproval(owner, spender, currentAllowance, target)
    return { needed: true, ...update }
  }

  /**
   * Set an exact allowance by default. Unlimited approval is an explicit opt-in.
   * No transaction is sent when the allowance already equals the requested
   * value, so passing zero revokes with at most a single confirmed approve(0).
   * Changing an existing non-zero allowance to a different non-zero value
   * first simulates the direct write via eth_call: tokens that accept it
   * (standard ERC20s) get a single approval with no reset. Only when the
   * simulation does not positively succeed (USDT-style tokens, or no
   * simulation support) is a confirmed approve(0) reset submitted first; if
   * the final approval then fails or is rejected in the wallet, the allowance
   * remains zero and the call must be re-run. Returns only after the final
   * approval transaction is confirmed.
   */
  async setApproval(
    owner: string,
    spender: string,
    amount: bigint,
    options: ApprovalOptions = {}
  ): Promise<ApprovalUpdate> {
    const target = this.approvalTarget(amount, options)
    const currentAllowance = await this.allowance(owner, spender)
    if (currentAllowance === target) {
      return {}
    }
    return this.replaceApproval(owner, spender, currentAllowance, target)
  }

  private approvalTarget(amount: bigint, options: ApprovalOptions): bigint {
    // Plain-JavaScript callers bypass the TypeScript types; validate here,
    // before any transaction, so an invalid amount can never zero an existing
    // allowance and then fail to encode.
    if (typeof amount !== 'bigint') {
      throw new Error('approval amount must be a bigint')
    }
    if (amount < 0n) {
      throw new Error('approval amount must not be negative')
    }
    if (amount > ethers.MaxUint256) {
      throw new Error('approval amount exceeds uint256 range')
    }
    // A null options argument bypasses the `= {}` parameter default, and a
    // primitive or array is never a valid options bag.
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('approval options must be an object')
    }
    // Snapshot the option with a SINGLE property read: a getter could
    // otherwise return undefined for the validation read and a truthy value
    // for the use read, granting an unlimited approval that was never
    // validated.
    const unlimited = options.unlimited
    if (unlimited !== undefined && typeof unlimited !== 'boolean') {
      throw new Error('unlimited option must be a boolean')
    }
    if (amount === 0n && unlimited) {
      throw new Error('zero amount cannot be combined with unlimited approval')
    }
    return unlimited ? ethers.MaxUint256 : amount
  }

  private async replaceApproval(
    owner: string,
    spender: string,
    currentAllowance: bigint,
    target: bigint
  ): Promise<ApprovalUpdate> {
    // USDT-style tokens reject every non-zero -> non-zero approve transition,
    // so changing a non-zero allowance may require an approve(0) reset first.
    // A zero target is itself a reset and needs no extra one. Probe with a free
    // eth_call before resetting: when the direct write would succeed (standard
    // ERC20s) a single approval is sent instead — no reset failure window and no
    // transient zero-allowance gap. A `true` here also serves as the final
    // send's preflight, so the direct path never issues a duplicate eth_call.
    const directOk =
      currentAllowance !== 0n && target !== 0n
        ? await this.canApproveDirectly(spender, target)
        : false

    let resetTx: ethers.TransactionResponse | undefined
    if (currentAllowance !== 0n && target !== 0n && !directOk) {
      // The submit itself is inside the try: a wallet rejection at the signing
      // prompt must also surface as a reset failure, not a raw error. The
      // preflight and post-write check catch a non-compliant token that returns
      // false without reverting — it would otherwise mine a status-1 receipt
      // while the allowance never changed.
      try {
        await this.preflightApprove(spender, 0n)
        const submittedResetTx = await this.approve(spender, 0n)
        resetTx = await this.waitForApproval(submittedResetTx)
        await this.assertAllowanceCleared(owner, spender)
      } catch (cause) {
        throw errorWithCause('allowance reset transaction failed', cause)
      }
    }

    let tx: ethers.TransactionResponse
    try {
      // Preflight the final approval unless the direct-write probe already
      // simulated it as true above.
      if (!directOk) {
        await this.preflightApprove(spender, target)
      }
      tx = await this.approve(spender, target)
      tx = await this.waitForApproval(tx)
      // Only a zero target is verified by a post-write read: a spender can
      // never reduce an allowance below zero, so there is no concurrent
      // transferFrom false negative (unlike a non-zero target).
      if (target === 0n) {
        await this.assertAllowanceCleared(owner, spender)
      }
    } catch (cause) {
      const message = resetTx
        ? 'final approval failed after the allowance was reset to zero'
        : 'approval transaction failed'
      throw errorWithCause(message, cause)
    }
    return resetTx ? { tx, resetTx } : { tx }
  }

  /**
   * Simulate approve(spender, target) with a free eth_call from the connected
   * signer (the same account the real send would use). Returns true only when
   * the simulation runs and positively reports success; a revert (USDT-style
   * nonzero -> nonzero rejection), a false return, a transport failure, or a
   * contract object without staticCall support all fail closed into the
   * proven reset path. This is a lenient SELECTION probe (a non-true result
   * chooses the reset path); the strict send-time check is preflightApprove.
   */
  private async canApproveDirectly(spender: string, target: bigint): Promise<boolean> {
    const approve = this.contract.approve
    if (typeof approve.staticCall !== 'function') {
      return false
    }
    try {
      return (await this.simulateApprove(spender, target)) === 'ok'
    } catch {
      return false
    }
  }

  /**
   * Classify an approve simulation independent of the ABI's declared return
   * type. A compliant token returns encoded `true`; a non-compliant silent
   * failure returns encoded `false`; USDT and other void-returning tokens
   * return NOTHING, which ethers cannot decode as bool (a BAD_DATA error on
   * empty data) even though the call SUCCEEDED. Only an explicit `false` is a
   * rejection here; a genuine revert or transport error is re-thrown.
   */
  private async simulateApprove(spender: string, amount: bigint): Promise<'ok' | 'rejected'> {
    const staticCall = this.contract.approve.staticCall
    // Callers only reach here after checking staticCall exists; this also
    // narrows the optional member and fails open if it is somehow absent.
    if (typeof staticCall !== 'function') {
      return 'ok'
    }
    try {
      return (await staticCall(spender, amount)) === false ? 'rejected' : 'ok'
    } catch (err) {
      if (isEmptyReturnData(err)) return 'ok'
      throw err
    }
  }

  /**
   * Strictly simulate an approval that is about to be sent. A token that would
   * return false without reverting must fail here rather than mine a status-1
   * receipt that leaves the allowance unchanged; a revert or transport error
   * propagates for the same reason. An empty (void) return — USDT and similar —
   * is a success. Fails open only when the contract-like object exposes no
   * staticCall (minimal wrappers); zero targets are still protected by the
   * post-write allowance check.
   */
  private async preflightApprove(spender: string, amount: bigint): Promise<void> {
    const approve = this.contract.approve
    if (typeof approve.staticCall !== 'function') {
      return
    }
    if ((await this.simulateApprove(spender, amount)) === 'rejected') {
      throw new Error('approval simulation returned false')
    }
  }

  /**
   * Confirm a zero-target approval actually took effect by reading the
   * allowance back. Zero is the only value verified post-write: it cannot be
   * reduced further by a concurrent transferFrom, so there is no false negative.
   */
  private async assertAllowanceCleared(owner: string, spender: string): Promise<void> {
    if ((await this.allowance(owner, spender)) !== 0n) {
      throw new Error('allowance was not cleared after the approval confirmed')
    }
  }

  /**
   * Wait for an approval transaction while accepting a mined fee-bump that
   * preserves the original contract call. ethers rejects tx.wait() with
   * TRANSACTION_REPLACED even when that replacement succeeded.
   */
  private async waitForApproval(
    tx: ethers.TransactionResponse
  ): Promise<ethers.TransactionResponse> {
    const wantTo = (tx.to ?? '').toLowerCase()
    const wantData = tx.data ?? '0x'
    const seenHashes = new Set<string>()
    let current = tx

    while (true) {
      try {
        const receipt = await current.wait()
        if (!receipt || receipt.status !== 1) {
          throw new Error('approval transaction failed')
        }
        return current
      } catch (cause) {
        // Follow only a replacement of the same approve call. The
        // classifier's (to, data) equality check is the authoritative
        // same-call test and the receipt-status gate decides success, so only
        // an explicit 'cancelled' reason is rejected — the same policy the
        // MPP payment watcher applies. The ethers `cancelled` boolean is NOT
        // consulted: ethers sets it true for every non-repriced replacement
        // (it means "the original did not execute", not "the user cancelled
        // the call").
        const replacement = replacedTransactionFrom(cause, wantTo, wantData)
        if (!replacement || replacement.reason === 'cancelled') {
          throw cause
        }
        if (
          seenHashes.has(replacement.hash) ||
          seenHashes.size >= MAX_REPLACEMENT_FOLLOWS
        ) {
          throw errorWithCause(
            'approval transaction was replaced too many times',
            cause
          )
        }
        seenHashes.add(replacement.hash)
        if (replacement.receipt) {
          if (replacement.receipt.status !== 1) throw cause
          return replacement.tx
        }
        current = replacement.tx
      }
    }
  }
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown }
  error.cause = cause
  return error
}

/**
 * True when an ethers error is the BAD_DATA it throws for empty returndata —
 * the shape of a SUCCESSFUL call to a void-returning `approve` (e.g. USDT),
 * which declares a bool return it does not actually emit.
 */
function isEmptyReturnData(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'BAD_DATA' &&
    (err as { value?: unknown }).value === '0x'
  )
}

/**
 * Parse amount string to wei (bigint)
 */
export function parseUnits(amount: string, decimals: number): bigint {
  return ethers.parseUnits(amount, decimals)
}

/**
 * Format wei to human-readable amount
 */
export function formatUnits(amount: bigint, decimals: number): string {
  return ethers.formatUnits(amount, decimals)
}
