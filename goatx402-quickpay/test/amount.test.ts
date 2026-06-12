import { describe, it, expect } from 'vitest'
import { toWei } from '../src/amount.js'

describe('toWei', () => {
  it('whole numbers', () => expect(toWei('12', 6)).toBe('12000000'))
  it('decimals', () => expect(toWei('12.5', 6)).toBe('12500000'))
  it('max precision', () => expect(toWei('0.000001', 6)).toBe('1'))
  it('zero', () => expect(toWei('0', 6)).toBe('0'))
  it('18 decimals', () => expect(toWei('1.000000000000000001', 18)).toBe('1000000000000000001'))
  it('rejects over-precise', () => expect(() => toWei('1.0000001', 6)).toThrow(/decimal/))
  it('rejects junk', () => expect(() => toWei('abc', 6)).toThrow(/invalid amount/))
  it('rejects negative', () => expect(() => toWei('-1', 6)).toThrow())
})
