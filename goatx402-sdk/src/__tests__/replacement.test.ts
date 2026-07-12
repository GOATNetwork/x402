import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { replacedTransactionFrom } from '../internal/replacement.js'

const WANT_TO = '0xtoken'
const WANT_DATA = '0xapprove'

function replacementTx(
  fields: Partial<ethers.TransactionResponse> = {}
): ethers.TransactionResponse {
  return {
    hash: '0xreplacement',
    to: '0xToken',
    data: '0xapprove',
    ...fields,
  } as unknown as ethers.TransactionResponse
}

function replacedError(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 'TRANSACTION_REPLACED',
    reason: 'repriced',
    cancelled: false,
    replacement: replacementTx(),
    ...overrides,
  }
}

describe('replacedTransactionFrom', () => {
  it('returns null for anything that is not a TRANSACTION_REPLACED object', () => {
    expect(replacedTransactionFrom(null, WANT_TO, WANT_DATA)).toBeNull()
    expect(replacedTransactionFrom('boom', WANT_TO, WANT_DATA)).toBeNull()
    expect(replacedTransactionFrom(new Error('boom'), WANT_TO, WANT_DATA)).toBeNull()
    expect(
      replacedTransactionFrom(replacedError({ code: 'CALL_EXCEPTION' }), WANT_TO, WANT_DATA)
    ).toBeNull()
  })

  it('returns null when the replacement is missing or has no usable hash', () => {
    expect(
      replacedTransactionFrom(replacedError({ replacement: undefined }), WANT_TO, WANT_DATA)
    ).toBeNull()
    expect(
      replacedTransactionFrom(
        replacedError({ replacement: replacementTx({ hash: '' }) }),
        WANT_TO,
        WANT_DATA
      )
    ).toBeNull()
  })

  it('returns null when the replacement is a different call', () => {
    expect(
      replacedTransactionFrom(
        replacedError({ replacement: replacementTx({ to: '0xother' }) }),
        WANT_TO,
        WANT_DATA
      )
    ).toBeNull()
    expect(
      replacedTransactionFrom(
        replacedError({ replacement: replacementTx({ data: '0xtransfer' }) }),
        WANT_TO,
        WANT_DATA
      )
    ).toBeNull()
  })

  it('matches the destination case-insensitively', () => {
    const result = replacedTransactionFrom(
      replacedError({ replacement: replacementTx({ to: '0xTOKEN' }) }),
      WANT_TO,
      WANT_DATA
    )
    expect(result?.hash).toBe('0xreplacement')
  })

  it('passes through a string reason and defaults a missing one to replaced', () => {
    expect(
      replacedTransactionFrom(replacedError({ reason: 'cancelled' }), WANT_TO, WANT_DATA)?.reason
    ).toBe('cancelled')
    expect(
      replacedTransactionFrom(replacedError({ reason: undefined }), WANT_TO, WANT_DATA)?.reason
    ).toBe('replaced')
  })

  it('maps a non-boolean cancelled flag to undefined', () => {
    expect(
      replacedTransactionFrom(replacedError({ cancelled: true }), WANT_TO, WANT_DATA)?.cancelled
    ).toBe(true)
    expect(
      replacedTransactionFrom(replacedError({ cancelled: 'yes' }), WANT_TO, WANT_DATA)?.cancelled
    ).toBeUndefined()
    expect(
      replacedTransactionFrom(replacedError({ cancelled: undefined }), WANT_TO, WANT_DATA)
        ?.cancelled
    ).toBeUndefined()
  })

  it('attaches the receipt only when its hash matches the replacement', () => {
    const matching = replacedTransactionFrom(
      replacedError({ receipt: { status: 1, hash: '0xreplacement' } }),
      WANT_TO,
      WANT_DATA
    )
    expect(matching?.receipt).toEqual({ status: 1, hash: '0xreplacement' })

    const caseInsensitive = replacedTransactionFrom(
      replacedError({ receipt: { status: 1, hash: '0xREPLACEMENT' } }),
      WANT_TO,
      WANT_DATA
    )
    expect(caseInsensitive?.receipt).toEqual({ status: 1, hash: '0xREPLACEMENT' })
  })

  it('strips a receipt that belongs to a different transaction or has no hash', () => {
    const foreign = replacedTransactionFrom(
      replacedError({ receipt: { status: 1, hash: '0xsomething-else' } }),
      WANT_TO,
      WANT_DATA
    )
    expect(foreign?.receipt).toBeUndefined()

    const hashless = replacedTransactionFrom(
      replacedError({ receipt: { status: 1 } }),
      WANT_TO,
      WANT_DATA
    )
    expect(hashless?.receipt).toBeUndefined()
  })
})
