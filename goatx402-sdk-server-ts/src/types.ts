/**
 * GoatX402 Server SDK Type Definitions
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface GoatX402Config {
  /** API base URL */
  baseUrl: string
  /** Merchant API Key */
  apiKey: string
  /** Merchant API Secret (keep this secure on the server!) */
  apiSecret: string
}

// ============================================================================
// Order Types
// ============================================================================

export type PaymentFlow =
  | 'ERC20_DIRECT'
  | 'ERC20_3009'
  | 'ERC20_APPROVE_XFER'

export interface CreateOrderParams {
  /** Unique order ID from DApp */
  dappOrderId: string
  /** Source chain ID (where user pays) */
  chainId: number
  /** Token symbol (e.g., 'USDC', 'USDT') */
  tokenSymbol: string
  /** Token contract address (optional, looked up by symbol) */
  tokenContract?: string
  /** Payer wallet address */
  fromAddress: string
  /** Payment amount in wei (string for big numbers) */
  amountWei: string
  /** Optional callback calldata for DELEGATE merchants */
  callbackCalldata?: string
}

export interface Order {
  /** Order ID from GoatX402 */
  orderId: string
  /** Payment flow type */
  flow: PaymentFlow
  /** Token symbol (e.g., "USDC", "USDT") */
  tokenSymbol: string
  /** Token contract address on source chain */
  tokenContract: string
  /** Recipient address for payment */
  payToAddress: string
  /** Source chain ID (where user pays) */
  fromChainId: number
  /** Destination chain ID (where merchant receives) */
  payToChainId: number
  /** Payment amount in wei */
  amountWei: string
  /** Order expiration timestamp (unix seconds) */
  expiresAt: number
  /** Calldata sign request (for DELEGATE merchants) */
  calldataSignRequest?: CalldataSignRequest
  /** Raw x402 response for advanced use cases */
  x402?: X402PaymentRequired
}

export type OrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'

// ============================================================================
// Unified Hosted Checkout Types
// ============================================================================

/**
 * Parameters for creating a server-authoritative unified hosted-checkout session
 * via {@link GoatX402Client.createCheckoutSession}. One subsystem covers both
 * DIRECT and DELEGATE merchants — the buyer picks ONLY a token on the hosted page;
 * the amount is always pinned server-side (never from the browser).
 *
 * The merchant is taken from the authenticated API key — never the body. Field
 * names map onto the snake_case body the core handler parses
 * (`POST /api/v1/checkout/sessions`).
 *
 * SIGNING NOTE: the HMAC scheme flattens the JSON body field-by-field with Go
 * `fmt %v` and CANNOT sign nested objects. Every nested value is therefore sent
 * as a JSON STRING (`acceptable_tokens`, `line_items_json`, `public_metadata_json`,
 * `private_metadata_json`); the server JSON-parses them AFTER verifying the
 * signature. The SDK does this stringification for you, so all fields below are
 * signable.
 */
export interface CreateCheckoutSessionParams {
  /** Checkout subsystem: `DIRECT` (buyer pays the merchant) or `DELEGATE` (TSS/Permit2/EIP-3009). */
  checkoutType: 'DIRECT' | 'DELEGATE'
  /**
   * Token-agnostic decimal price (e.g. `"9.99"`) — body field `price`. Used by DIRECT, and by
   * cross-chain DELEGATE (PRICE_DECIMAL) where the buyer picks any payable (source chain,
   * token) and the amount is `price * 10^decimals`. (Legacy single-chain DELEGATE uses
   * `fixedAmountWei` instead.)
   */
  price?: string
  /** Legacy fixed-wei DELEGATE only — pinned source EVM chain ID. Omit for cross-chain price mode. */
  chainId?: number
  /** DELEGATE only — pinned payment amount in wei (string for big numbers) — body field `fixed_amount_wei`. */
  fixedAmountWei?: string
  /** DELEGATE only — non-empty hex calldata (with or without 0x) for the merchant callback contract — body field `callback_calldata`. */
  callbackCalldata?: string
  /**
   * Legacy fixed-wei DELEGATE only — token contracts accepted for the fixed
   * amount. Cross-chain price mode derives candidates server-side. Sent
   * JSON-stringified as body field `acceptable_tokens`.
   */
  acceptableTokens?: string[]
  /** Optional redirect URL after a successful payment — body field `success_url`. */
  successUrl?: string
  /** Optional redirect URL after cancellation — body field `cancel_url`. */
  cancelUrl?: string
  /** Optional line items shown on the hosted checkout. Sent JSON-stringified as body field `line_items_json`. */
  lineItems?: unknown[]
  /** Optional public metadata (surfaced in the public session view). Sent JSON-stringified as body field `public_metadata_json`. */
  publicMetadata?: Record<string, unknown>
  /** Optional private metadata (merchant-only; never exposed publicly). Sent JSON-stringified as body field `private_metadata_json`. */
  privateMetadata?: Record<string, unknown>
  /** Optional client-supplied idempotency/correlation reference (max 200 chars) — body field `client_reference_id`. */
  clientReferenceId?: string
  /** Optional session lifetime in seconds — body field `expires_in`. */
  expiresIn?: number
}

/** Result of creating a unified hosted-checkout session. */
export interface CheckoutSession {
  /** Opaque checkout id (the raw handle) — pass to the checkout SDK's `open({ checkoutId })`. */
  checkoutId: string
  /** Checkout subsystem (`DIRECT` | `DELEGATE`). */
  checkoutType: string
  /** Hosted checkout URL to redirect the buyer to. */
  url: string
  /** Session expiration timestamp (unix seconds). */
  expiresAt: number
}

// ============================================================================
// DELEGATE Hosted Checkout Types (DEPRECATED)
// ============================================================================

/**
 * @deprecated Use {@link CreateCheckoutSessionParams} with `checkoutType: 'DELEGATE'`.
 *
 * Parameters for the deprecated {@link GoatX402Client.createDelegateCheckoutSession}
 * wrapper, kept for one version. It now forwards to the unified
 * `POST /api/v1/checkout/sessions` endpoint. The single `tokenContract` is wrapped
 * into `acceptableTokens: [tokenContract]` (unless `acceptableTokens` is given
 * directly), and `amountWei` maps to `fixedAmountWei`.
 */
export interface CreateDelegateCheckoutSessionParams {
  /** Source EVM chain ID (DELEGATE is EVM-only). */
  chainId: number
  /** Single ERC-20 token contract address (wrapped into `acceptableTokens`). */
  tokenContract?: string
  /** Token contract addresses the merchant accepts (overrides `tokenContract` when set). */
  acceptableTokens?: string[]
  /** Payment amount in wei (string for big numbers); maps to `fixedAmountWei`. */
  amountWei?: string
  /** Pinned payment amount in wei (takes precedence over `amountWei`). */
  fixedAmountWei?: string
  /** Non-empty hex calldata (with or without 0x) for the merchant callback contract. */
  callbackCalldata: string
  /** Optional redirect URL after a successful payment. */
  successUrl?: string
  /** Optional redirect URL after cancellation. */
  cancelUrl?: string
  /** Optional client-supplied idempotency/correlation reference (max 200 chars). */
  clientReferenceId?: string
  /** Optional session lifetime in seconds. */
  expiresIn?: number
  /** Optional line items shown on the hosted checkout. */
  lineItems?: unknown[]
  /** Optional public metadata (surfaced in the public session view). */
  publicMetadata?: Record<string, unknown>
  /** Optional private metadata (merchant-only). */
  privateMetadata?: Record<string, unknown>
}

/**
 * @deprecated Use {@link CheckoutSession}.
 * Result of the deprecated DELEGATE hosted-checkout wrapper.
 */
export interface DelegateCheckoutSession {
  /** Opaque session handle (the checkout id). */
  handle: string
  /** Hosted checkout URL to redirect the buyer to. */
  url: string
  /** Session expiration timestamp (unix seconds). */
  expiresAt: number
}

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

export interface CalldataSignRequest {
  domain: EIP712Domain
  types: Record<string, EIP712Type[]>
  primaryType: string
  message: {
    // Common fields
    token: string
    owner: string
    payer: string
    amount: string
    orderId: string
    calldataNonce: string
    deadline: string
    calldataHash: string
    // Permit2 flow only
    permit2?: string
  }
}

// ============================================================================
// API Response Types
// ============================================================================

export interface OrderProof {
  orderId: string
  merchantId: string
  dappOrderId: string
  chainId: number
  tokenContract: string
  tokenSymbol: string
  fromAddress: string
  amountWei: string
  status: OrderStatus
  txHash?: string
  confirmedAt?: string
}

export interface OrderProofResponse {
  payload: {
    order_id: string
    tx_hash: string
    log_index: number
    from_addr: string
    to_addr: string
    amount_wei: string
    chain_id: number
    flow: string
  }
  signature: string
}

export interface MerchantInfo {
  merchantId: string
  name: string
  logo?: string
  receiveType: 'DIRECT' | 'DELEGATE'
  supportedTokens: MerchantToken[]
}

export interface MerchantToken {
  chainId: number
  symbol: string
  tokenContract: string
}

// ============================================================================
// Error Types
// ============================================================================

export class GoatX402Error extends Error {
  code?: string
  status?: number

  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'GoatX402Error'
    this.code = code
    this.status = status
  }
}

// ============================================================================
// x402 Protocol Types
// See: https://github.com/coinbase/x402
// ============================================================================

/** x402 Resource describes the protected resource */
export interface X402Resource {
  url: string
  description?: string
  mimeType?: string
}

/** x402 Payment Option describes one payment method the server accepts */
export interface X402PaymentOption {
  /** Payment scheme (e.g., "exact", "exact-eip3009") */
  scheme: string
  /** Network in CAIP-2 format (e.g., "eip155:97") */
  network: string
  /** Amount in atomic units as string */
  amount: string
  /** Token contract address */
  asset: string
  /** Recipient address */
  payTo: string
  /** Maximum timeout in seconds */
  maxTimeoutSeconds: number
  /** Additional data */
  extra?: {
    flow?: string
    tokenSymbol?: string
    eip712Domain?: EIP712Domain
    eip712Types?: Record<string, EIP712Type[]>
    eip712PrimaryType?: string
    eip712Message?: Record<string, unknown>
    [key: string]: unknown
  }
}

/** GoatX402-specific extension in x402 response */
export interface X402GoatExtension {
  /** Destination chain in CAIP-2 format */
  destinationChain: string
  /** Expiration timestamp (unix seconds) */
  expiresAt: number
  /** Endpoint to submit signature (only present for EIP-3009 flow) */
  signatureEndpoint?: string
  /** Payment method: "transfer" for direct transfer, "eip3009-signature" for gasless */
  paymentMethod: 'transfer' | 'eip3009-signature'
  /** Receive type: DIRECT, DELEGATE, or VERIFY (informational) */
  receiveType?: 'DIRECT' | 'DELEGATE' | 'VERIFY'
}

/** x402 Payment Required response (HTTP 402) */
export interface X402PaymentRequired {
  /** x402 protocol version */
  x402Version: number
  /** Error message if any */
  error?: string
  /** Protected resource info */
  resource: X402Resource
  /** Accepted payment options */
  accepts: X402PaymentOption[]
  /** Protocol extensions */
  extensions?: {
    goatx402?: X402GoatExtension
    [key: string]: unknown
  }
  // Backward compatibility fields
  order_id: string
  flow: string
  token_symbol: string
  /** Calldata sign request for DELEGATE merchants with callback */
  calldata_sign_request?: CalldataSignRequest
}


// ============================================================================
// CAIP-2 Helper Functions
// See: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
// ============================================================================

/**
 * Convert chain ID to CAIP-2 format
 * @example toCAIP2(97) returns "eip155:97"
 */
export function toCAIP2(chainId: number): string {
  return `eip155:${chainId}`
}

/**
 * Parse CAIP-2 network identifier to chain ID
 * @example fromCAIP2("eip155:97") returns 97
 */
export function fromCAIP2(network: string): number {
  const match = network.match(/^eip155:(\d+)$/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Parse base64-encoded x402 PAYMENT-REQUIRED header
 */
export function parseX402Header(headerValue: string): X402PaymentRequired | null {
  try {
    const decoded = Buffer.from(headerValue, 'base64').toString('utf-8')
    return JSON.parse(decoded) as X402PaymentRequired
  } catch {
    return null
  }
}
