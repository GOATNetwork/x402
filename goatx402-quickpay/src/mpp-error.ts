/**
 * mppRecovery extracts the resume payload from a goatx402-sdk MPPError thrown
 * AFTER the on-chain transfer was broadcast (i.e. a verify-polling failure).
 *
 * It is detected STRUCTURALLY (name + recoverable) so the CLI keeps no hard
 * dependency on the optional goatx402-sdk. Returns null for pre-broadcast errors
 * (which carry no recovery handle) so the caller falls back to the generic error
 * path. The returned object lets an agent RESUME verification with the same
 * challenge + tx hash instead of starting a fresh (double-)payment.
 */
export function mppRecovery(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== 'object') return null
  const e = err as {
    name?: string
    message?: string
    recoverable?: { challenge?: unknown; txHash?: string; payerAddr?: string }
  }
  if (e.name !== 'MPPError' || !e.recoverable) return null
  return {
    ok: false,
    rail: 'mpp',
    error: e.message ?? 'MPP verification failed after broadcast',
    tx_hash: e.recoverable.txHash,
    payer_addr: e.recoverable.payerAddr,
    challenge: e.recoverable.challenge,
    hint: 'A payment was already broadcast but verification did not complete. Resume verification with this challenge + tx_hash; do NOT pay again.',
  }
}
