/**
 * HMAC-SHA256 signature utilities for GOAT Flow API authentication
 */

import { createHmac, randomBytes, randomUUID } from 'crypto'

/**
 * Calculate HMAC-SHA256 signature for API request
 *
 * Algorithm:
 * 1. Sort all parameters by key in ASCII order
 * 2. Concatenate as key1=value1&key2=value2 format
 * 3. Encrypt using HMAC-SHA256 algorithm
 * 4. Return hexadecimal string
 */
export function calculateSignature(
  params: Record<string, string>,
  secret: string
): string {
  // Exclude sign field if present
  const filteredParams = { ...params }
  delete filteredParams.sign

  // Sort keys alphabetically
  const sortedKeys = Object.keys(filteredParams)
    .filter((k) => filteredParams[k] !== '')
    .sort()

  // Build signature string
  const signStr = sortedKeys.map((k) => `${k}=${filteredParams[k]}`).join('&')

  // Compute HMAC-SHA256
  const signature = createHmac('sha256', secret).update(signStr).digest('hex')

  return signature
}

/**
 * Generate authentication headers for API request
 */
export function signRequest(
  params: Record<string, unknown>,
  apiKey: string,
  apiSecret: string
): {
  'X-API-Key': string
  'X-Timestamp': string
  'X-Nonce': string
  'X-Sign': string
} {
  // Convert all params to strings
  const strParams: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      strParams[k] = String(v)
    }
  }

  // Add authentication parameters
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce =
    typeof randomUUID === 'function'
      ? randomUUID()
      : `${Date.now().toString(36)}-${randomBytes(12).toString('hex')}`
  strParams.api_key = apiKey
  strParams.timestamp = timestamp
  strParams.nonce = nonce

  // Calculate signature
  const sign = calculateSignature(strParams, apiSecret)

  return {
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': sign,
  }
}
