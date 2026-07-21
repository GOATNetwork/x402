// Public types for the GOAT Flow drop-in Checkout SDK (checkout.js).
//
// The SDK is framework-free and opens the platform-hosted checkout page in a
// TOP-LEVEL window (popup or full-page redirect) — never an iframe. It relays
// only NON-SENSITIVE UX events back to the developer's page via postMessage;
// it is NOT proof of payment (fulfillment must rely on webhooks / order status).

/** Where the hosted checkout lives + popup-channel tunables. */
export interface GoatCheckoutConfig {
  /**
   * The platform QuickPay payment origin, e.g. 'https://pay.goat.network'.
   * This is the TRUST ANCHOR: it is the only origin the SDK will accept
   * postMessage events from, and the only origin it opens. Must be a bare
   * https origin (http allowed only for localhost dev).
   */
  origin: string
  /**
   * Unified hosted checkout path on that origin. Default '/checkout'. Serves BOTH
   * DIRECT and DELEGATE checkouts — the page learns the type from the server read.
   * Used for `checkout_id` (`cs`) sessions.
   */
  checkoutPath?: string
  /**
   * Hosted path for the legacy product/custom QuickPay page — the page opened by
   * `open({ productKey })` / `openCustom(...)`, NOT `cs` sessions. When unset it falls back
   * to `checkoutPath` (which previously configured these opens) and then to
   * '/quickpay/checkout', so existing integrations keep working. Set it explicitly if your
   * deployment serves that page under a custom route distinct from the unified `checkoutPath`.
   */
  quickpayCheckoutPath?: string
  /**
   * @deprecated Ignored. DELEGATE now uses the SAME unified `checkoutPath`; this
   * field is kept only so existing configs do not break and will be removed in a
   * future version.
   */
  delegateCheckoutPath?: string
  /**
   * How long (ms) to wait for the popup's `goat:ready` before declaring the
   * popup channel unusable (`opener_unavailable` — usually a strict COOP on the
   * opener or checkout page severing `window.opener`). Default 12000.
   */
  readyTimeoutMs?: number
  /**
   * Grace period (ms) after opening before a `closed` popup may be reported as
   * `cancel`, so a near-instant close on some browsers is not misread. Default 600.
   */
  closeGraceMs?: number
}

/** A confirmed/terminal checkout outcome, surfaced as a UX signal only. */
export interface CheckoutResult {
  /** QuickPay session id (resume/reconcile handle). */
  session_id?: string
  /** On-chain tx hash, when the checkout reported one. */
  tx_hash?: string
  /** Terminal status, e.g. 'PAYMENT_CONFIRMED'. */
  status?: string
  /** The product_key, when this was a product checkout. */
  product_key?: string
  /** The created order id, when the checkout reported one (e.g. DELEGATE flow). */
  order_id?: string
  /** The DELEGATE checkout session handle, echoed back by that flow. */
  handle?: string
  /** Merchant's own order/cart reference, echoed back when one was supplied. */
  client_reference_id?: string
}

/** Why a checkout could not be completed via the popup channel. */
export type CheckoutErrorReason =
  | 'popup_blocked' // window.open returned null (browser blocked the popup)
  | 'opener_unavailable' // never received goat:ready (COOP severed the channel) — advise redirect mode
  | 'invalid_options' // the SDK was called with an unusable option set
  | 'checkout_error' // the hosted checkout reported an error (detail carries the message)

/** Common fields shared by the open variants. */
interface BaseOpenOptions {
  /** Pay in this token symbol (optional; otherwise chosen on the hosted page). */
  token?: string
  /** Pay on this EVM chain id (optional; otherwise chosen on the hosted page). */
  chain?: number
  /**
   * 'popup' (default) opens a small top-level window; 'tab' opens a full new browser tab
   * (same postMessage channel); 'redirect' navigates the current page.
   */
  display?: 'popup' | 'tab' | 'redirect'
  /** Called once on a terminal CONFIRMED outcome. UX signal only — NOT proof of payment. */
  onSuccess?: (result: CheckoutResult) => void
  /** Called when the buyer abandons (closes the popup) or the checkout reports cancel. */
  onCancel?: () => void
  /** Called when the popup cannot run (blocked / channel severed / checkout error). */
  onError?: (reason: CheckoutErrorReason, detail?: unknown) => void
  /**
   * Merchant's own order/cart reference. Threaded to the hosted checkout (URL param
   * `client_reference_id`), echoed back on the `quickpay.payment.confirmed` webhook and
   * appended to the redirect query. It is a correlation hint, NOT a price — safe in the URL.
   */
  clientReferenceId?: string
  /**
   * Where to send the buyer after a CONFIRMED payment (Stripe-style). The hosted page
   * only honors it if the merchant's redirect_allowlist permits it (open-redirect guard).
   * Not a price — safe in the URL.
   */
  successUrl?: string
  /**
   * Where to send the buyer on cancel/abandon (Stripe-style). Same allowlist gate as
   * `successUrl`. Not a price — safe in the URL.
   */
  cancelUrl?: string
}

/**
 * Options for a fulfillable purchase. Exactly one price source must be given:
 *   - `checkoutId` (a server-created CheckoutSession; amount pinned server-side), OR
 *   - `merchant` + `productKey` (a server-priced product).
 * The amount is NEVER taken from the browser for these — that is the whole point.
 */
export interface OpenOptions extends BaseOpenOptions {
  /** Merchant id (required for product mode; ignored/derived for checkoutId mode). */
  merchant?: string
  /** Server-priced product key. */
  productKey?: string
  /** Opaque server-created checkout session id (URL param `cs`). */
  checkoutId?: string
}

/**
 * Options for a CUSTOM / donation payment. The amount is browser-supplied and
 * therefore UNTRUSTED — the merchant MUST reconcile the actually-paid amount
 * server-side (webhook / order status) before fulfilling. Never use this for an
 * automatically-fulfilled purchase; use a product or a CheckoutSession instead.
 */
export interface OpenCustomOptions extends BaseOpenOptions {
  merchant: string
  /** Human decimal amount (e.g. '12.50'). Untrusted — see above. */
  amount: string
  /** Optional payment memo/reference. */
  memo?: string
}

/**
 * Options for a full-page redirect to the hosted checkout (no callbacks).
 * Fulfillable only: carries `checkoutId` (cs) OR `merchant`+`productKey` — never a
 * price. For a custom/donation redirect use `openCustom({ display: 'redirect' })`.
 */
export interface RedirectOptions {
  merchant?: string
  productKey?: string
  checkoutId?: string
  token?: string
  chain?: number
  /** Merchant's own order/cart reference (URL param `client_reference_id`). Not a price. */
  clientReferenceId?: string
  /** Post-CONFIRMED redirect target (Stripe-style); allowlist-gated by the hosted page. Not a price. */
  successUrl?: string
  /** Cancel/abandon redirect target (Stripe-style); allowlist-gated by the hosted page. Not a price. */
  cancelUrl?: string
}

/**
 * @deprecated Use {@link OpenOptions} with `{ checkoutId: handle }` via `open`.
 *
 * Options for opening a DELEGATE (TSS/Permit2/EIP-3009) hosted checkout. A DELEGATE
 * checkout id is now the SAME kind of handle from the same create endpoint and opens
 * the SAME unified page (URL param `cs`); the page learns DIRECT vs DELEGATE from the
 * server read. The merchant backend still creates the session via the server SDK.
 */
export interface OpenDelegateOptions {
  /** Opaque server-created DELEGATE checkout session handle (forwarded as `cs`). Required. */
  handle: string
  /** 'popup' (default) opens a small top-level window; 'tab' a full new tab; 'redirect' navigates the page. */
  display?: 'popup' | 'tab' | 'redirect'
  /** Post-CONFIRMED redirect target (Stripe-style); allowlist-gated by the hosted page. Not a price. */
  successUrl?: string
  /** Cancel/abandon redirect target (Stripe-style); same allowlist gate. Not a price. */
  cancelUrl?: string
  /** Called once on a terminal CONFIRMED outcome. UX signal only — NOT proof of payment. */
  onSuccess?: (result: CheckoutResult) => void
  /** Called when the buyer abandons (closes the popup) or the checkout reports cancel. */
  onCancel?: () => void
  /** Called when the popup cannot run (blocked / channel severed / checkout error / bad options). */
  onError?: (reason: CheckoutErrorReason, detail?: unknown) => void
}

/**
 * @deprecated Use {@link RedirectOptions} with `{ checkoutId: handle }` via `redirectToCheckout`.
 *
 * Options for a full-page redirect to the hosted DELEGATE checkout (no callbacks).
 * Carries only the opaque server-created `handle` (forwarded as `cs`) — never a price.
 */
export interface RedirectDelegateOptions {
  /** Opaque server-created DELEGATE checkout session handle (forwarded as `cs`). Required. */
  handle: string
  /** Post-CONFIRMED redirect target (Stripe-style); allowlist-gated by the hosted page. Not a price. */
  successUrl?: string
  /** Cancel/abandon redirect target (Stripe-style); same allowlist gate. Not a price. */
  cancelUrl?: string
}

/** Handle to an in-flight popup checkout. */
export interface CheckoutHandle {
  /** Tear down listeners/timers and close the popup if still open. Idempotent. */
  close(): void
}
