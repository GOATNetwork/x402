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

// Hard per-request deadline applied to every fetch (overridable per call).
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const FIAT_AMOUNT_RE = /^\d{1,40}(?:\.\d+)?$/

function validateCheckoutPaymentRails(params: CreateCheckoutSessionParams): void {
  const rawRails = params.paymentRails as unknown
  const hasFiatFields = params.fiatCurrency !== undefined || params.fiatAmount !== undefined
  if (rawRails === undefined) {
    if (hasFiatFields) {
      throw new Error('fiatCurrency/fiatAmount require paymentRails to include fiat')
    }
    return
  }
  if (!Array.isArray(rawRails) || rawRails.length === 0) {
    throw new Error('paymentRails must be a non-empty subset of crypto,fiat')
  }
  const seen = new Set<string>()
  for (const rail of rawRails) {
    if (rail !== 'crypto' && rail !== 'fiat') {
      throw new Error(`unsupported payment rail: ${String(rail)}`)
    }
    if (seen.has(rail)) throw new Error(`duplicate payment rail: ${rail}`)
    seen.add(rail)
  }
  if (!seen.has('fiat')) {
    if (hasFiatFields) {
      throw new Error('fiatCurrency/fiatAmount require paymentRails to include fiat')
    }
    return
  }
  if (typeof params.fiatCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(params.fiatCurrency.trim())) {
    throw new Error('fiatCurrency must be a 3-letter ISO-4217 code when the fiat rail is enabled')
  }
  const amount = typeof params.fiatAmount === 'string' ? params.fiatAmount.trim() : ''
  if (!FIAT_AMOUNT_RE.test(amount) || !/[1-9]/.test(amount)) {
    throw new Error('fiatAmount must be a positive decimal string when the fiat rail is enabled')
  }
}

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

    // Sent only when opted in, matching the Go server SDK's `omitempty` — the
    // wire shape stays byte-identical for every ordinary caller.
    if (params.recoverExistingOrder) {
      body.recover_existing_order = true
    }

    if (params.tokenContract) {
      body.token_contract = params.tokenContract
    }
    if (params.callbackCalldata) {
      body.callback_calldata = params.callbackCalldata
    }

    // Order creation is the ONLY endpoint where HTTP 402 is the expected
    // success shape (x402 Payment Required carries the payment terms).
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
   * DELEGATE). A crypto rail lets the buyer pick a token; a fiat rail sends the
   * buyer to hosted card checkout. Every offered amount is pinned server-side
   * from `price`/`fixedAmountWei` and/or `fiatAmount`.
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
    validateCheckoutPaymentRails(params)
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
    // Fiat rail (flat, signable). payment_rails is a CSV subset of "crypto,fiat".
    if (params.paymentRails !== undefined) body.payment_rails = params.paymentRails.join(',')
    if (params.fiatCurrency !== undefined) body.fiat_currency = params.fiatCurrency
    if (params.fiatAmount !== undefined) body.fiat_amount = params.fiatAmount

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
    const encodedOrderId = encodeURIComponent(orderId)
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
    }>('GET', `/api/v1/orders/${encodedOrderId}`, undefined, { timeoutMs: opts?.timeoutMs })

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
    return this.request('GET', `/api/v1/orders/${encodeURIComponent(orderId)}/proof`)
  }

  /**
   * Submit user's EIP-712 signature for calldata
   */
  async submitCalldataSignature(orderId: string, signature: string): Promise<void> {
    await this.request<{ status: string; order_id: string }>(
      'POST',
      `/api/v1/orders/${encodeURIComponent(orderId)}/calldata-signature`,
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
      `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`,
      {}
    )
  }

  /**
   * Get merchant information (public API, no authentication required)
   */
  async getMerchant(merchantId: string): Promise<MerchantInfo> {
    const encodedMerchantId = encodeURIComponent(merchantId)
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
    }>(`/merchants/${encodedMerchantId}`)

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
      // Bound each poll by the remaining overall deadline (and the default
      // per-request timeout) so one hung request cannot outlive the declared
      // timeout — previously the deadline was only checked BETWEEN polls.
      const remaining = timeout - (Date.now() - startTime)
      let order: OrderProof
      try {
        order = await this.getOrderStatus(orderId, {
          timeoutMs: Math.max(1, Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining)),
        })
      } catch (err) {
        // A single slow/failed poll (per-request abort, transient network or
        // retryable server error) must not abort the whole wait — the
        // documented contract is "poll until terminal status or the overall
        // timeout". Deterministic client errors are different: a 401 (bad
        // credentials) or 404 (wrong order id) will never heal, so hiding them
        // for the full timeout would only mask misconfiguration — rethrow.
        const status = err instanceof GoatFlowError ? err.status : undefined
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw err
        }
        lastError = err
        // Clamp to the remaining deadline so a failure near the end cannot
        // overshoot the caller's timeout by a full interval. Break only when
        // the DEADLINE is spent — a zero interval just means re-poll at once.
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

      // Wait before next poll (clamped to the remaining overall deadline)
      const remainingAfterPoll = timeout - (Date.now() - startTime)
      if (remainingAfterPoll <= 0) break
      const nextSleepMs = Math.min(Math.max(0, interval), remainingAfterPoll)
      await new Promise((resolve) => setTimeout(resolve, nextSleepMs))
    }

    const lastErrNote =
      lastError instanceof Error ? ` (last poll error: ${lastError.message})` : ''
    throw new Error(`Timeout waiting for order ${orderId} confirmation${lastErrNote}`)
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
      // Every request gets a hard deadline: without one, a hung connection
      // blocks the caller indefinitely (and lets waitForConfirmation overshoot
      // its declared overall timeout).
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

    // Handle errors. HTTP 402 is a success shape ONLY where the caller says so
    // (order creation returns x402 Payment Required); everywhere else a 402 —
    // e.g. injected by an intermediary — must not be silently coerced into the
    // expected response type (cancelOrder would report success on an error body).
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
