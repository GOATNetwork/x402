/**
 * GOAT Flow Server SDK Client
 *
 * This client handles API authentication securely on the backend.
 * Never expose API credentials to the frontend!
 */

import { signRequest } from './signature.js'
import type {
  GoatFlowConfig,
  CreateOrderParams,
  CreateCheckoutSessionParams,
  CheckoutSession,
  CreateDelegateCheckoutSessionParams,
  DelegateCheckoutSession,
  Order,
  OrderProof,
  OrderProofResponse,
  MerchantInfo,
  PaymentFlow,
  OrderStatus,
  X402PaymentRequired,
} from './types.js'
import { fromCAIP2, GoatFlowError } from './types.js'

// Hard per-request deadline applied to every fetch.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class GoatFlowClient {
  private baseUrl: string
  private apiKey: string
  private apiSecret: string

  constructor(config: GoatFlowConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.apiKey = config.apiKey
    this.apiSecret = config.apiSecret
  }

  /**
   * Create a new payment order
   * Returns an x402-compliant response normalized to the Order struct
   */
  async createOrder(params: CreateOrderParams): Promise<Order> {
    // Get raw x402 response
    const x402Response = await this.createOrderRaw(params)

    // Parse x402 response to Order
    return this.parseX402ToOrder(x402Response, params)
  }

  /**
   * Create a new payment order and return the raw x402 response
   * Use this if you need full x402 protocol access
   */
  async createOrderRaw(params: CreateOrderParams): Promise<X402PaymentRequired> {
    const body: Record<string, unknown> = {
      dapp_order_id: params.dappOrderId,
      chain_id: params.chainId,
      token_symbol: params.tokenSymbol,
      from_address: params.fromAddress,
      amount_wei: params.amountWei,
    }

    if (params.tokenContract) {
      body.token_contract = params.tokenContract
    }
    if (params.callbackCalldata) {
      body.callback_calldata = params.callbackCalldata
    }

    // Order creation is the only endpoint where HTTP 402 is the expected x402
    // success shape.
    return this.request<X402PaymentRequired>('POST', '/api/v1/orders', body, { expect402: true })
  }

  /**
   * Parse x402 response to normalized Order struct
   */
  private parseX402ToOrder(x402: X402PaymentRequired, params: CreateOrderParams): Order {
    const opt = x402.accepts?.[0]

    // Get flow from x402 response or extra
    let flow = x402.flow
    if (!flow && opt?.extra?.flow) {
      flow = opt.extra.flow
    }

    // Get token symbol
    let tokenSymbol = x402.token_symbol
    if (!tokenSymbol && opt?.extra?.tokenSymbol) {
      tokenSymbol = opt.extra.tokenSymbol
    }

    // Get chain IDs
    let fromChainId = opt ? fromCAIP2(opt.network) : 0
    let payToChainId = x402.extensions?.goatx402?.destinationChain
      ? fromCAIP2(x402.extensions.goatx402.destinationChain)
      : 0

    // Fallback to request params
    if (!fromChainId && params.chainId) {
      fromChainId = params.chainId
    }

    return {
      orderId: x402.order_id,
      flow: (flow || 'ERC20_DIRECT') as PaymentFlow,
      tokenSymbol: tokenSymbol || params.tokenSymbol,
      tokenContract: opt?.asset || params.tokenContract || '',
      payToAddress: opt?.payTo || '',
      fromChainId,
      payToChainId,
      amountWei: opt?.amount || params.amountWei,
      expiresAt: x402.extensions?.goatx402?.expiresAt || 0,
      calldataSignRequest: x402.calldata_sign_request,
      x402,
    }
  }

  /**
   * Create a server-authoritative unified hosted-checkout session (DIRECT or
   * DELEGATE). The buyer picks ONLY a token on the hosted page; the amount is
   * always pinned server-side. DIRECT uses `price`; DELEGATE uses either `price`
   * for cross-chain decimal-price checkout or `fixedAmountWei` for the legacy
   * single-chain form.
   *
   * The merchant is derived from the authenticated API key (HMAC). Returns
   * `{ checkoutId, checkoutType, url, expiresAt }`; the `url` is built by the
   * platform from the QuickPay public origin — redirect the buyer there to pay.
   *
   * SIGNING NOTE: nested values cannot be HMAC-signed, so they are sent as JSON
   * STRINGS (`acceptable_tokens`, `line_items_json`, `public_metadata_json`,
   * `private_metadata_json`) and the server parses them after verifying the
   * signature. This is handled below — every field is signable.
   */
  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSession> {
    const body: Record<string, unknown> = {
      checkout_type: params.checkoutType,
    }

    // Scalars pass straight through (signable as-is).
    if (params.price !== undefined) body.price = params.price
    if (params.chainId !== undefined) body.chain_id = params.chainId
    if (params.fixedAmountWei !== undefined) body.fixed_amount_wei = params.fixedAmountWei
    if (params.callbackCalldata !== undefined) body.callback_calldata = params.callbackCalldata
    if (params.successUrl !== undefined) body.success_url = params.successUrl
    if (params.cancelUrl !== undefined) body.cancel_url = params.cancelUrl
    if (params.clientReferenceId !== undefined) body.client_reference_id = params.clientReferenceId
    if (params.expiresIn !== undefined) body.expires_in = params.expiresIn

    // Nested values are JSON-stringified so they ride as scalar (signable) fields;
    // the server JSON-parses them after verifying the HMAC signature.
    if (params.acceptableTokens !== undefined) body.acceptable_tokens = JSON.stringify(params.acceptableTokens)
    if (params.lineItems !== undefined) body.line_items_json = JSON.stringify(params.lineItems)
    if (params.publicMetadata !== undefined) body.public_metadata_json = JSON.stringify(params.publicMetadata)
    if (params.privateMetadata !== undefined) body.private_metadata_json = JSON.stringify(params.privateMetadata)

    const data = await this.request<{
      checkout_id: string
      checkout_type: string
      url: string
      expires_at: number
    }>('POST', '/api/v1/checkout/sessions', body)

    return {
      checkoutId: data.checkout_id,
      checkoutType: data.checkout_type,
      url: data.url,
      expiresAt: data.expires_at,
    }
  }

  /**
   * @deprecated Use {@link GoatFlowClient.createCheckoutSession} with
   * `checkoutType: 'DELEGATE'`. Thin wrapper kept for one version; it forwards to
   * the unified endpoint, wrapping the single `tokenContract` into
   * `acceptableTokens: [tokenContract]` and mapping `amountWei → fixedAmountWei`.
   */
  async createDelegateCheckoutSession(
    params: CreateDelegateCheckoutSessionParams
  ): Promise<DelegateCheckoutSession> {
    const acceptableTokens =
      params.acceptableTokens ?? (params.tokenContract ? [params.tokenContract] : undefined)

    const session = await this.createCheckoutSession({
      checkoutType: 'DELEGATE',
      chainId: params.chainId,
      fixedAmountWei: params.fixedAmountWei ?? params.amountWei,
      callbackCalldata: params.callbackCalldata,
      acceptableTokens,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      clientReferenceId: params.clientReferenceId,
      expiresIn: params.expiresIn,
      lineItems: params.lineItems,
      publicMetadata: params.publicMetadata,
      privateMetadata: params.privateMetadata,
    })

    return {
      handle: session.checkoutId,
      url: session.url,
      expiresAt: session.expiresAt,
    }
  }

  /**
   * Get order status and details (for polling)
   */
  async getOrderStatus(orderId: string, opts?: { timeoutMs?: number }): Promise<OrderProof> {
    const data = await this.request<{
      order_id: string
      merchant_id: string
      dapp_order_id: string
      chain_id: number
      token_contract: string
      token_symbol: string
      from_address: string
      amount_wei: string
      status: string
      tx_hash?: string
      confirmed_at?: string
    }>('GET', `/api/v1/orders/${orderId}`, undefined, { timeoutMs: opts?.timeoutMs })

    return {
      orderId: data.order_id,
      merchantId: data.merchant_id,
      dappOrderId: data.dapp_order_id,
      chainId: data.chain_id,
      tokenContract: data.token_contract,
      tokenSymbol: data.token_symbol,
      fromAddress: data.from_address,
      amountWei: data.amount_wei,
      status: data.status as OrderStatus,
      txHash: data.tx_hash,
      confirmedAt: data.confirmed_at,
    }
  }

  /**
   * Get the server-issued payment record for a completed order.
   * Only available after payment is confirmed.
   *
   * NOTE: the returned `signature` is an unsigned Keccak256 hash covering only
   * a subset of the payload fields, not a cryptographic attestation (see
   * {@link OrderProofResponse} for the exact field list); verify
   * `payload.tx_hash` on-chain if you need independent verification.
   */
  async getOrderProof(orderId: string): Promise<OrderProofResponse> {
    return this.request('GET', `/api/v1/orders/${orderId}/proof`)
  }

  /**
   * Submit user's EIP-712 signature for calldata
   */
  async submitCalldataSignature(orderId: string, signature: string): Promise<void> {
    await this.request<{ status: string; order_id: string }>(
      'POST',
      `/api/v1/orders/${orderId}/calldata-signature`,
      { signature }
    )
  }

  /**
   * Cancel an order that is in CHECKOUT_VERIFIED status
   * This will restore any reserved balance and refund fees
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request<{ status: string; order_id: string }>(
      'POST',
      `/api/v1/orders/${orderId}/cancel`,
      {}
    )
  }

  /**
   * Get merchant information (public API, no authentication required)
   */
  async getMerchant(merchantId: string): Promise<MerchantInfo> {
    const data = await this.publicRequest<{
      merchant_id: string
      name?: string
      logo?: string
      receive_type: string
      wallets: Array<{
        address: string
        chain_id: number
        token_symbol: string
        token_contract: string
      }>
    }>(`/merchants/${merchantId}`)

    return {
      merchantId: data.merchant_id,
      name: data.name || data.merchant_id,
      logo: data.logo,
      receiveType: data.receive_type as 'DIRECT' | 'DELEGATE',
      supportedTokens:
        data.wallets?.map((w) => ({
          chainId: w.chain_id,
          symbol: w.token_symbol,
          tokenContract: w.token_contract,
        })) || [],
    }
  }

  /**
   * Poll for order confirmation
   */
  async waitForConfirmation(
    orderId: string,
    options: {
      timeout?: number // milliseconds, default 5 minutes
      interval?: number // milliseconds, default 3 seconds
      onStatusChange?: (status: string) => void
    } = {}
  ): Promise<OrderProof> {
    const timeout = options.timeout ?? 5 * 60 * 1000
    const interval = options.interval ?? 3000
    const startTime = Date.now()

    let lastStatus = ''
    let lastError: unknown

    while (Date.now() - startTime < timeout) {
      const remaining = timeout - (Date.now() - startTime)
      let order: OrderProof
      try {
        order = await this.getOrderStatus(orderId, {
          timeoutMs: Math.max(1, Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining)),
        })
      } catch (error) {
        // Retry request timeouts, network failures, 408/429, and server errors.
        // Other 4xx responses are deterministic caller/configuration errors.
        const status = error instanceof GoatFlowError ? error.status : undefined
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw error
        }
        lastError = error
        const remainingAfterPoll = timeout - (Date.now() - startTime)
        if (remainingAfterPoll <= 0) break
        const sleepMs = Math.min(Math.max(0, interval), remainingAfterPoll)
        await new Promise((resolve) => setTimeout(resolve, sleepMs))
        continue
      }

      if (order.status !== lastStatus) {
        lastStatus = order.status
        options.onStatusChange?.(order.status)
      }

      // Check for terminal states. INVOICED is a SUCCESS terminal: Core flips
      // DIRECT orders PAYMENT_CONFIRMED → INVOICED inside one watcher
      // transaction, so a poller may never observe PAYMENT_CONFIRMED at all —
      // without INVOICED here every DIRECT wait would run to timeout.
      if (
        order.status === 'PAYMENT_CONFIRMED' ||
        order.status === 'INVOICED' ||
        order.status === 'FAILED' ||
        order.status === 'EXPIRED' ||
        order.status === 'CANCELLED'
      ) {
        return order
      }

      const remainingAfterPoll = timeout - (Date.now() - startTime)
      if (remainingAfterPoll <= 0) break
      const sleepMs = Math.min(Math.max(0, interval), remainingAfterPoll)
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }

    const lastErrorNote =
      lastError instanceof Error ? ` (last poll error: ${lastError.message})` : ''
    throw new Error(`Timeout waiting for order ${orderId} confirmation${lastErrorNote}`)
  }

  /**
   * Make authenticated API request
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    opts?: { expect402?: boolean; timeoutMs?: number }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`

    // Generate auth headers
    const authHeaders = signRequest(body || {}, this.apiKey, this.apiSecret)

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    })

    // Read response as text first, then try to parse as JSON
    const responseText = await response.text()
    let data: Record<string, unknown> = {}
    try {
      data = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      // Response is not JSON, keep as text
    }

    // HTTP 402 is a success shape only for the explicitly marked order-create
    // request; every other endpoint must treat it as an error.
    const ok = response.ok || (response.status === 402 && opts?.expect402 === true)
    if (!ok) {
      // Fiber returns 'message', standard APIs return 'error'
      // Include full response body for debugging
      const errorMessage =
        (data.error as string) ||
        (data.message as string) ||
        (Object.keys(data).length > 0 ? JSON.stringify(data) : null) ||
        responseText ||
        `HTTP ${response.status}`
      throw new GoatFlowError(
        errorMessage,
        data.code as string | undefined,
        response.status,
        responseText
      )
    }

    return data as T
  }

  /**
   * Make public API request (no authentication)
   */
  private async publicRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    })

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (!response.ok) {
      throw new GoatFlowError(
        (data.error as string) || `HTTP ${response.status}`,
        data.code as string | undefined,
        response.status
      )
    }

    return data as T
  }
}
