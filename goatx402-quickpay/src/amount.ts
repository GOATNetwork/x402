/**
 * toWei converts a human decimal amount string (e.g. "12.50") to an integer wei
 * string for the given token decimals. Pure (no ethers) so it is trivially
 * testable. Rejects malformed input and over-precise amounts.
 */
export function toWei(amount: string, decimals: number): string {
  const s = amount.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid amount: ${amount}`)
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`invalid decimals: ${decimals}`)
  }
  const [intPart, fracPart = ''] = s.split('.')
  if (fracPart.length > decimals) {
    throw new Error(`amount "${amount}" has more than ${decimals} decimal places`)
  }
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals)
  const wei = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(frac === '' ? '0' : frac)
  return wei.toString()
}
