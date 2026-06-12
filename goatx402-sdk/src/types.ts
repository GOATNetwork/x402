/**
 * GoatX402 Client SDK Type Definitions
 *
 * These types are used for frontend wallet interactions.
 * Order data is received from your backend (which uses goatx402-sdk-server).
 */

import type { TransactionResponse } from 'ethers'

// ============================================================================
// Order Types (received from backend)
// ============================================================================

/**
 * Payment flow types returned by GoatX402 API.
 *
 * All flows require the user to directly transfer tokens to payToAddress.
 * The flow type indicates the receiving mode:
 * - DIRECT flows: payToAddress = merchant's receiving address
 * - DELEGATE flows (3009/APPROVE_XFER): payToAddress = TSS wallet address
 */
export type PaymentFlow =
  | 'ERC20_DIRECT'        // Direct to merchant address
  | 'ERC20_3009'          // To TSS (token supports EIP-3009)
  | 'ERC20_APPROVE_XFER'  // To TSS (token doesn't support EIP-3009)

export interface Order {
  /** Order ID from GoatX402 */
  orderId: string
  /** Payment flow type */
  flow: PaymentFlow
  /** Token symbol */
  tokenSymbol: string
  /** Token contract address */
  tokenContract: string
  /** Payer address */
  fromAddress: string
  /**
   * Recipient address for payment.
   * User should transfer tokens to this address.
   * - DIRECT mode: merchant's receiving address
   * - DELEGATE mode: TSS wallet address
   */
  payToAddress: string
  /** Chain ID */
  chainId: number
  /** Payment amount in wei */
  amountWei: string
  /** Order expiration timestamp (unix seconds) */
  expiresAt: number
  /** Calldata sign request (for DELEGATE merchants with callback) */
  calldataSignRequest?: CalldataSignRequest
}

export type OrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'

// ============================================================================
// EIP-712 Types
// ============================================================================

export interface EIP712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}

export interface EIP712Type {
  name: string
  type: string
}

/**
 * Calldata sign request for EIP-712 signing.
 * Message type depends on the payment flow:
 * - EIP-3009 flow: Eip3009CalldataMessage (primaryType: "Eip3009CallbackData")
 * - Permit2 flow: Permit2CalldataMessage (primaryType: "Permit2CallbackData")
 */
export interface CalldataSignRequest {
  /** EIP-712 domain */
  domain: EIP712Domain
  /** EIP-712 types */
  types: Record<string, EIP712Type[]>
  /** Primary type name: "Eip3009CallbackData" or "Permit2CallbackData" */
  primaryType: string
  /** Message to sign - structure depends on primaryType */
  message: Eip3009CalldataMessage | Permit2CalldataMessage
}

/**
 * EIP-712 message for EIP-3009 calldata signature.
 * Used when primaryType is "Eip3009CallbackData".
 */
export interface Eip3009CalldataMessage {
  token: string         // Token contract address
  owner: string         // TSS wallet address
  payer: string         // User address (originalPayer)
  amount: string        // Payment amount in wei
  orderId: string       // Order ID hash (bytes32) - links to specific order
  calldataNonce: string // Replay protection nonce
  deadline: string      // Signature expiry timestamp
  calldataHash: string  // keccak256 hash of calldata
}

/**
 * EIP-712 message for Permit2 calldata signature.
 * Used when primaryType is "Permit2CallbackData".
 */
export interface Permit2CalldataMessage {
  permit2: string       // Permit2 contract address
  token: string         // Token contract address
  owner: string         // TSS wallet address
  payer: string         // User address (originalPayer)
  amount: string        // Payment amount in wei
  orderId: string       // Order ID hash (bytes32) - links to specific order
  calldataNonce: string // Replay protection nonce
  deadline: string      // Signature expiry timestamp
  calldataHash: string  // keccak256 hash of calldata
}

// ============================================================================
// Payment Types
// ============================================================================

export interface PaymentResult {
  /** Whether payment was successful */
  success: boolean
  /** Transaction hash (if successful) */
  txHash?: string
  /** Error message (if failed) */
  error?: string
}

// ============================================================================
// Error Types
// ============================================================================

export class PaymentError extends Error {
  code?: string
  txHash?: string

  constructor(message: string, code?: string, txHash?: string) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
    this.txHash = txHash
  }
}

// ============================================================================
// MPP (Machine Payments Protocol) Types
// ============================================================================

/**
 * MPP challenge issued by Core's /mpp/v1/challenge endpoint.
 *
 * The challenge is a server-signed (HMAC) commitment to a price + payee
 * + token + chain for a specific (merchant_id, payer_addr,
 * request_canonical) tuple. The buyer pays on-chain and submits the
 * tx_hash + MAC back to /mpp/v1/verify to receive a Payment-Receipt.
 *
 * Fields use camelCase (SDK convention). The corresponding wire JSON
 * uses snake_case (challenge_id, expiry_unix, amount_wei, chain_id,
 * token_contract, mac, route_pricing_version, recipient).
 */
export interface MPPChallenge {
  challengeId: string
  expiryUnix: number
  amountWei: string
  chainId: number
  tokenContract: string
  recipient: string
  mac: string
  routePricingVersion: number
}

/**
 * Lifecycle phases reported via the optional onPhase callback. Callers
 * use these to render progress UI without having to wrap each MPPClient
 * call site themselves.
 */
export type MPPPhase =
  | 'requesting_challenge'
  | 'challenge_received'
  | 'sending_transaction'
  | 'transaction_sent'
  | 'transaction_replaced' // wallet fee-bump / "speed up" produced a new tx_hash; verify now follows it
  | 'verifying'
  | 'verify_pending' // received 202 + Retry-After
  | 'verified'
  | 'failed'

/**
 * Successful MPP verification result. Callers attach receiptHeader to
 * subsequent requests to the merchant's protected resource as a
 * `Payment-Receipt:` header.
 */
export interface MPPVerifyResult {
  /** Full "payload.sig.alg" Payment-Receipt header value */
  receiptHeader: string
  /** Decoded JSON receipt payload (the "payload" segment of receiptHeader) */
  receiptBody: Record<string, unknown>
  txHash: string
  challengeId: string
}

/**
 * Inputs to the high-level MPPClient.pay() composition. Lower-level
 * callers can use requestChallenge / payChallenge / verifyChallenge
 * directly.
 */
export interface MPPPayParams {
  merchantId: string
  routeCanonical: string
  /**
   * Optional finer-grained request fingerprint. Must equal
   * routeCanonical OR start with `routeCanonical + ":"` — Core
   * enforces this strict-prefix binding so a low-price route can't
   * be paired with a high-price request_canonical.
   * Defaults to routeCanonical when omitted.
   */
  requestCanonical?: string
  /**
   * Max verify polling attempts (including the first). Defaults to
   * 16, pinned UNDER Core's per-(tx_hash, order_id) server budget
   * (TxOrderBudget=18) so a normal flow cannot exhaust the server's
   * non-refundable retry tokens. ~80s of polling at the typical 5s
   * Retry-After. Slower chains require BOTH a higher
   * mpp.rate_limit.tx_order_budget on Core AND an explicit higher
   * maxVerifyAttempts here — bumping the SDK alone hides a 429
   * budget-exhausted failure mode.
   */
  maxVerifyAttempts?: number
  /** Progress callback for UI updates. */
  onPhase?: (phase: MPPPhase, detail?: unknown) => void
}

/**
 * Typed error surfaced by every MPPClient method. Callers branch on
 * `code` to render expected vs unexpected failures (e.g.
 * challenge_expired ≠ user_rejected ≠ network_error).
 *
 * Stable codes (subject to extension, never renamed):
 *   - "network_error" / "parse_error" — SDK-side
 *   - "route_not_found" / "invalid_request" — Core /challenge errors
 *   - "chain_mismatch" / "user_rejected" / "payment_failed" — payment-side
 *   - "challenge_expired" / "challenge_already_consumed" /
 *     "challenge_tx_hash_mismatch" / "payer_mismatch" — Core /verify
 *     pre-settle rejections
 *   - "bad_request" — Core /verify settle validation failure (e.g.
 *     underpayment, wrong recipient)
 *   - "verify_timeout" — SDK gave up after maxAttempts
 *   - "service_unavailable" — Core 503 (RPC breaker open / transient)
 *   - "receipt_missing" / "receipt_malformed" — verify 200 without a
 *     usable Payment-Receipt header (server bug or CORS misconfig)
 */
/**
 * Recovery payload attached to MPPError instances thrown by the
 * high-level pay() composition AFTER an on-chain transfer has been
 * broadcast. Lets callers retry verification of the already-paid tx
 * without re-prompting the wallet:
 *
 *   try { await client.pay(...) } catch (err) {
 *     if (err instanceof MPPError && err.recoverable) {
 *       return await client.verifyChallenge(err.recoverable)
 *     }
 *     throw err
 *   }
 *
 * Only populated when the failure occurred during verify polling.
 * Errors from earlier phases (requestChallenge, payChallenge before
 * broadcast, wallet rejection) leave this undefined.
 *
 * payerAddr is the address Core bound the challenge to — typically
 * what signer.getAddress() returned when pay() started. It is included
 * here (rather than re-derived from the current signer at retry time)
 * so recovery survives wallet disconnects and account switches between
 * pay() failing and the caller retrying: Core verifies against the
 * original payer_addr, and a mid-flow account switch would otherwise
 * produce a payer_mismatch on a tx that was already correctly paid.
 */
export interface MPPRecoverable {
  challenge: MPPChallenge
  txHash: string
  payerAddr: string
  /**
   * The broadcast TransactionResponse (present when the failure occurred
   * during verify polling after payChallenge). `txHash` above is the latest
   * hash KNOWN at throw time — a fee-bump / "speed up" replacement detected
   * during polling is already reflected there. In the rare case the provider
   * reports the replacement only AFTER verify polling exhausted, `txHash` may
   * still be the pre-replacement hash; callers that must be robust to that can
   * `await tx.wait()` (ethers rejects with TRANSACTION_REPLACED carrying the
   * new tx) and resume `verifyChallenge` with the replacement hash. Undefined
   * for pre-broadcast failures.
   */
  tx?: TransactionResponse
}

export class MPPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus?: number,
    public readonly cause?: unknown,
    public readonly recoverable?: MPPRecoverable
  ) {
    super(message)
    this.name = 'MPPError'
  }
}
