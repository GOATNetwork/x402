import { describe, it, expect } from 'vitest'
import { mppRecovery } from '../src/mpp-error.js'

describe('mppRecovery', () => {
  it('extracts the resume payload from a post-broadcast MPPError', () => {
    const err = {
      name: 'MPPError',
      message: 'verify polling timed out',
      recoverable: { challenge: { challenge_id: 'c1' }, txHash: '0xabc', payerAddr: '0xPayer' },
    }
    const r = mppRecovery(err)
    expect(r).not.toBeNull()
    expect(r).toMatchObject({ ok: false, rail: 'mpp', tx_hash: '0xabc', payer_addr: '0xPayer' })
    expect((r as any).challenge).toEqual({ challenge_id: 'c1' })
  })

  it('returns null for a pre-broadcast MPPError (no recovery handle)', () => {
    expect(mppRecovery({ name: 'MPPError', message: 'wallet rejected' })).toBeNull()
  })

  it('returns null for a non-MPP error', () => {
    expect(mppRecovery(new Error('boom'))).toBeNull()
    expect(mppRecovery('nope')).toBeNull()
    expect(mppRecovery(null)).toBeNull()
  })
})
