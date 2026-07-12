import { describe, expect, it } from 'vitest'
import { loadMppSdk } from '../src/backend-mpp-sdk.js'

describe('loadMppSdk', () => {
  it('resolves with the imported module on success', async () => {
    const fakeSdk = { MPPClient: class {} }
    const requested: string[] = []

    await expect(
      loadMppSdk(async (specifier) => {
        requested.push(specifier)
        return fakeSdk
      })
    ).resolves.toBe(fakeSdk)
    expect(requested).toEqual(['goatx402-sdk'])
  })

  it('preserves the underlying import failure as the error cause', async () => {
    const importFailure = new TypeError('SDK entry point failed to initialize')

    try {
      await loadMppSdk(async () => {
        throw importFailure
      })
      throw new Error('expected loadMppSdk to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('could not load the optional dependency')
      expect((error as Error & { cause?: unknown }).cause).toBe(importFailure)
    }
  })
})
