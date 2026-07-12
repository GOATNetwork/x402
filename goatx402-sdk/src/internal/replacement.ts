/**
 * Shared classifier for ethers v6 TRANSACTION_REPLACED rejections.
 */

import { ethers } from 'ethers'

/**
 * Upper bound on how many chained same-call replacements a waiter follows.
 * A broken or malicious provider feeding an endless (or cyclic) replacement
 * chain must not trap callers in an infinite loop.
 */
export const MAX_REPLACEMENT_FOLLOWS = 10

export interface ReplacedTransaction {
  /** The replacement transaction, guaranteed to carry the original (to, data). */
  tx: ethers.TransactionResponse
  /** The replacement's validated, non-empty hash. */
  hash: string
  /** ethers reason: 'repriced' | 'cancelled' | 'replaced'. */
  reason: string
  /** ethers' cancelled flag when it is a boolean, otherwise undefined. */
  cancelled?: boolean
  /**
   * The replacement's own receipt, attached only when its hash provably
   * matches the replacement transaction.
   */
  receipt?: ethers.TransactionReceipt
}

/**
 * Extract the replacement transaction from an ethers v6 tx.wait() rejection.
 * ethers sets err.code = 'TRANSACTION_REPLACED', err.reason ∈
 * {'repriced','cancelled','replaced'} and err.replacement = the new
 * TransactionResponse.
 *
 * Returns null unless the replacement still performs the SAME call — its
 * (to, data) must match the original's (wantTo, wantData). A genuine fee-bump
 * changes only gas, so the (to, data) check is authoritative rather than
 * trusting err.reason: a user cancellation (0-value to self) or a same-nonce
 * transaction that is a different operation is rejected here. Callers apply
 * their own policy on top of reason/cancelled/receipt.
 */
export function replacedTransactionFrom(
  err: unknown,
  wantTo: string,
  wantData: string
): ReplacedTransaction | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as {
    code?: unknown
    reason?: unknown
    cancelled?: unknown
    replacement?: unknown
    receipt?: unknown
  }
  if (e.code !== 'TRANSACTION_REPLACED') return null
  const rep = e.replacement as ethers.TransactionResponse | undefined
  if (!rep || typeof rep.hash !== 'string' || rep.hash === '') return null
  if ((rep.to ?? '').toLowerCase() !== wantTo) return null
  if ((rep.data ?? '0x') !== wantData) return null
  // value is deliberately not compared: approve/transfer are nonpayable, so a
  // value-carrying same-calldata replacement reverts and is rejected by the
  // callers' receipt-status gate.
  //
  // Attach the receipt only when it provably belongs to the replacement — a
  // wrapper could hand back the original's failed receipt (false failure) or
  // an unrelated successful one (false success). Without a trusted receipt
  // the callers re-wait on the replacement and fetch the authentic one.
  const rawReceipt = e.receipt as ethers.TransactionReceipt | undefined
  const receipt =
    rawReceipt &&
    typeof rawReceipt === 'object' &&
    typeof rawReceipt.hash === 'string' &&
    rawReceipt.hash.toLowerCase() === rep.hash.toLowerCase()
      ? rawReceipt
      : undefined
  return {
    tx: rep,
    hash: rep.hash,
    reason: typeof e.reason === 'string' ? e.reason : 'replaced',
    cancelled: typeof e.cancelled === 'boolean' ? e.cancelled : undefined,
    receipt,
  }
}
