import { BrowserEnv, IncomingMessage, PopupWindow, defaultBrowserEnv } from './env.js'
import type {
  CheckoutErrorReason,
  CheckoutHandle,
  CheckoutResult,
  GoatCheckoutConfig,
  OpenCustomOptions,
  OpenDelegateOptions,
  OpenOptions,
  RedirectDelegateOptions,
  RedirectOptions,
} from './types.js'

// Monotonic counter giving each GoatCheckout instance a distinct popup window
// name. Two instances must not share one OS window: their generation counters
// are independent, so a stale handle from one instance could otherwise close
// another instance's active checkout window.
let checkoutInstanceSeq = 0

const DEFAULT_CHECKOUT_PATH = '/checkout'
// Product/custom QuickPay opens (NO server-pinned checkout session) still target the
// legacy QuickPay checkout page; only a server-created CheckoutSession (`cs`) uses the
// unified `/checkout` page. Routing both to `/checkout` would land product/custom on a
// page that only understands `cs`.
const QUICKPAY_CHECKOUT_PATH = '/quickpay/checkout'
const DEFAULT_READY_TIMEOUT_MS = 12000
const DEFAULT_CLOSE_GRACE_MS = 600
const POLL_INTERVAL_MS = 400
const POPUP_FEATURES = 'popup,width=440,height=760'
// Empty features → the browser opens a full new TAB (not a small popup window). The named
// target is still reused, and window.opener is preserved, so the postMessage channel works
// exactly as it does for the popup.
const TAB_FEATURES = ''

// validateOrigin enforces that the configured origin is a bare, authenticated
// origin: https for any host, or http ONLY for loopback (local dev). This is the
// trust anchor — the SDK opens and accepts messages from THIS origin only.
function validateOrigin(origin: string): string {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    throw new Error(`goatx402-checkout: invalid origin: ${origin}`)
  }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol === 'http:') {
    if (!isLoopback) throw new Error(`goatx402-checkout: origin must be https (http only for localhost): ${origin}`)
  } else if (u.protocol !== 'https:') {
    throw new Error(`goatx402-checkout: origin must be https: ${origin}`)
  }
  if (u.username || u.password) throw new Error('goatx402-checkout: origin must not contain credentials')
  // Reject a path/query/fragment — origin must be bare scheme://host[:port].
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`goatx402-checkout: origin must be bare scheme://host: ${origin}`)
  return u.origin
}

// validateCheckoutPath enforces a root-relative, same-origin path with no scheme,
// protocol-relative authority, query, fragment, or whitespace — so it can never
// escape the configured origin or smuggle forbidden params (e.g. a preseeded amount).
function validateCheckoutPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`goatx402-checkout: checkoutPath must be a root-relative path (start with '/'): ${path}`)
  }
  if (/:\/\/|[?#\\]/.test(path) || /\s/.test(path)) {
    throw new Error(`goatx402-checkout: checkoutPath must not contain a scheme, query, fragment, or whitespace: ${path}`)
  }
  return path
}

// buildParams turns a resolved intent into the checkout URL query params (without
// the popup channel fields). Exactly one price source is encoded.
function buildParams(p: {
  merchant?: string
  productKey?: string
  checkoutId?: string
  token?: string
  chain?: number
  amount?: string
  memo?: string
  clientReferenceId?: string
  successUrl?: string
  cancelUrl?: string
}): Record<string, string> {
  const q: Record<string, string> = {}
  if (p.checkoutId) {
    q.cs = p.checkoutId
  } else {
    if (p.merchant) q.m = p.merchant
    if (p.productKey) q.product_key = p.productKey
    if (p.amount !== undefined) q.amount = p.amount
    if (p.memo !== undefined) q.memo = p.memo
  }
  if (p.token) q.token = p.token
  if (p.chain !== undefined) q.chain = String(p.chain)
  // Merchant reference + Stripe-style redirect URLs are NON-price correlation/UX params,
  // allowed on any open()/redirect (they carry no amount, so they never violate the
  // "fulfillable URL carries no price" boundary). The hosted page allowlist-gates the
  // redirect URLs before honoring them. Only set when present.
  if (p.clientReferenceId) q.client_reference_id = p.clientReferenceId
  if (p.successUrl) q.success_url = p.successUrl
  if (p.cancelUrl) q.cancel_url = p.cancelUrl
  return q
}

function buildUrl(origin: string, path: string, params: Record<string, string>, channel?: { o: string; n: string }): string {
  const u = new URL(path, origin)
  // Defense in depth: a validated root-relative path can never change the origin,
  // but assert it so a future caller mistake can never point the popup off-host.
  if (u.origin !== origin) throw new Error(`goatx402-checkout: checkout path escaped origin: ${path}`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  if (channel) {
    u.searchParams.set('o', channel.o)
    u.searchParams.set('n', channel.n)
  }
  return u.toString()
}

function noopHandle(): CheckoutHandle {
  return { close() {} }
}

// CheckoutCallbacks is the subset of open options the popup channel needs; the
// public option types (OpenOptions / OpenCustomOptions / OpenDelegateOptions) all
// structurally satisfy it, so launchPopup can serve every flow.
interface CheckoutCallbacks {
  onSuccess?: (result: CheckoutResult) => void
  onCancel?: () => void
  onError?: (reason: CheckoutErrorReason, detail?: unknown) => void
}

/** A configured checkout opener bound to one platform origin. */
export interface GoatCheckout {
  /** Open a fulfillable purchase (product_key or checkout_id) — popup by default. */
  open(opts: OpenOptions): CheckoutHandle
  /** Open a custom/donation payment (untrusted amount) — popup by default. */
  openCustom(opts: OpenCustomOptions): CheckoutHandle
  /** Navigate the whole page to the hosted checkout (no callbacks). */
  redirectToCheckout(opts: RedirectOptions): void
  /**
   * @deprecated Use {@link GoatCheckout.open} with `{ checkoutId: handle }`.
   * A DELEGATE checkout id is now the SAME kind of handle from the same create
   * endpoint and opens the SAME unified page — this is a thin alias kept for one version.
   */
  openDelegate(opts: OpenDelegateOptions): CheckoutHandle
  /**
   * @deprecated Use {@link GoatCheckout.redirectToCheckout} with `{ checkoutId: handle }`.
   * Thin alias for the unified checkout, kept for one version.
   */
  redirectToDelegateCheckout(opts: RedirectDelegateOptions): void
}

/**
 * GoatCheckout creates a drop-in checkout opener for the platform's hosted
 * checkout page. The popup runs the wallet + payment at the top level (best
 * wallet compatibility) and relays only non-sensitive UX events back here.
 *
 * Security model lives on the hosted page (server-pinned amount, term re-check,
 * double-pay guards). This SDK's job: open the right URL, validate the channel
 * (origin + source + nonce), and surface UX outcomes without false success/cancel.
 */
export function GoatCheckout(config: GoatCheckoutConfig, env: BrowserEnv = defaultBrowserEnv()): GoatCheckout {
  const origin = validateOrigin(config.origin)
  const path = validateCheckoutPath(config.checkoutPath ?? DEFAULT_CHECKOUT_PATH)
  // Legacy product/custom QuickPay page. Falls back to checkoutPath — which BEFORE the
  // unified-checkout change defaulted to '/quickpay/checkout' and WAS the knob for these
  // product/custom opens — so existing integrations that customized checkoutPath keep
  // routing product/custom to their page. New integrations should set quickpayCheckoutPath
  // explicitly (checkoutPath now configures the unified `cs` page).
  const quickpayPath = validateCheckoutPath(config.quickpayCheckoutPath ?? config.checkoutPath ?? QUICKPAY_CHECKOUT_PATH)
  // A server-pinned CheckoutSession (params carry `cs`) opens the unified `/checkout`
  // page; a product/custom QuickPay open targets the legacy `/quickpay/checkout` page.
  const pathFor = (params: Record<string, string>): string => (params.cs ? path : quickpayPath)
  const readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const closeGraceMs = config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS

  // This instance's own popup window name. Repeated opens from THIS instance
  // reuse this one window; a different instance uses a different name and so a
  // separate window, which is what keeps generation tracking below correct.
  const popupName = `goat_checkout_${++checkoutInstanceSeq}`

  // At most one checkout popup is observed per instance: this instance's named
  // window is reused, so a second open() (e.g. a double-click) must retire the
  // first's listener/timers, else the stale call could fire
  // onCancel/opener_unavailable after the second call already succeeded.
  // `activeCheckout` supersedes the prior one.
  let activeCheckout: (() => void) | null = null
  // popupGen identifies the latest popup launch for THIS instance's window.
  // Only the handle whose generation is still current may close it — a stale
  // handle must never close a newer checkout's reused window.
  let popupGen = 0

  // launchPopup opens the top-level checkout window (at targetPath) and wires the
  // UX channel. The channel (origin + source + nonce), supersede and teardown logic
  // is identical for every flow — only the target path/params differ.
  function launchPopup(targetPath: string, params: Record<string, string>, opts: CheckoutCallbacks, features: string = POPUP_FEATURES): CheckoutHandle {
    const nonce = env.randomNonce()
    const url = buildUrl(origin, targetPath, params, { o: env.openerOrigin, n: nonce })
    // window.open MUST be called synchronously in the user gesture; callers do so.
    const popup = env.openPopup(url, features, popupName)
    if (!popup) {
      opts.onError?.('popup_blocked')
      return noopHandle()
    }
    // Retire any prior in-flight checkout on this instance (no callback fires for it).
    if (activeCheckout) activeCheckout()
    const myGen = ++popupGen

    let settled = false
    let ready = false
    let pollId: number | undefined
    let readyTimerId: number | undefined
    // Grace before a `closed` popup counts as cancel, measured in poll ticks so the
    // logic is deterministic under fake timers (no wall clock).
    let pollTicks = 0
    const graceTicks = Math.max(1, Math.ceil(closeGraceMs / POLL_INTERVAL_MS))

    const teardown = (): void => {
      env.removeMessageListener(onMessage)
      if (pollId !== undefined) env.clearInterval(pollId)
      if (readyTimerId !== undefined) env.clearTimeout(readyTimerId)
      pollId = undefined
      readyTimerId = undefined
      if (activeCheckout === supersede) activeCheckout = null
    }

    // supersede silently retires this checkout (no callback) when a newer open() takes over.
    const supersede = (): void => {
      if (settled) return
      settled = true
      teardown()
    }

    // finish runs a terminal transition exactly once: terminal messages win over a
    // later popup.closed (so success is never overwritten by a spurious cancel).
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      teardown()
      action()
    }

    const ack = (): void => {
      // Tell the popup the opener received the terminal event so it may close.
      try {
        popup.postMessage({ type: 'goat:ack', n: nonce }, origin)
      } catch {
        /* popup may already be closing / severed — non-fatal */
      }
    }

    const onMessage = (e: IncomingMessage): void => {
      // Triple check: exact platform origin, exact popup window, matching nonce.
      if (e.origin !== origin) return
      if (e.source !== (popup as unknown)) return
      const data = e.data
      if (!data || typeof data !== 'object') return
      const msg = data as {
        type?: unknown
        n?: unknown
        session_id?: unknown
        tx_hash?: unknown
        status?: unknown
        product_key?: unknown
        order_id?: unknown
        handle?: unknown
        client_reference_id?: unknown
        message?: unknown
      }
      if (msg.n !== nonce) return
      switch (msg.type) {
        case 'goat:ready':
          ready = true
          if (readyTimerId !== undefined) {
            env.clearTimeout(readyTimerId)
            readyTimerId = undefined
          }
          break
        case 'goat:success': {
          const result: CheckoutResult = {
            session_id: typeof msg.session_id === 'string' ? msg.session_id : undefined,
            tx_hash: typeof msg.tx_hash === 'string' ? msg.tx_hash : undefined,
            status: typeof msg.status === 'string' ? msg.status : undefined,
            product_key: typeof msg.product_key === 'string' ? msg.product_key : undefined,
            order_id: typeof msg.order_id === 'string' ? msg.order_id : undefined,
            handle: typeof msg.handle === 'string' ? msg.handle : undefined,
            client_reference_id: typeof msg.client_reference_id === 'string' ? msg.client_reference_id : undefined,
          }
          ack()
          finish(() => opts.onSuccess?.(result))
          break
        }
        case 'goat:cancel':
          ack()
          finish(() => opts.onCancel?.())
          break
        case 'goat:error':
          ack()
          finish(() => opts.onError?.('checkout_error', typeof msg.message === 'string' ? msg.message : undefined))
          break
        default:
          break
      }
    }

    env.addMessageListener(onMessage)
    activeCheckout = supersede

    // Poll for the buyer abandoning the popup (closing it). Reading `.closed` can
    // throw or misreport under COOP — read defensively, and only treat a close as
    // cancel after a short grace and only if we are not already settled.
    pollId = env.setInterval(() => {
      if (settled) return
      pollTicks++
      let isClosed = false
      try {
        isClosed = popup.closed
      } catch {
        isClosed = false
      }
      if (isClosed && pollTicks >= graceTicks) {
        finish(() => opts.onCancel?.())
      }
    }, POLL_INTERVAL_MS)

    // If we never hear `goat:ready`, the channel is unusable (typically a strict
    // COOP on the opener or checkout page severing window.opener). The popup may
    // still work for the buyer, but we cannot observe the outcome — report
    // opener_unavailable (NOT cancel) and advise redirect mode. Do not close the popup.
    readyTimerId = env.setTimeout(() => {
      readyTimerId = undefined
      if (settled || ready) return
      let isClosed = false
      try {
        isClosed = popup.closed
      } catch {
        isClosed = false
      }
      if (isClosed) return // the close poll will report cancel
      finish(() => opts.onError?.('opener_unavailable'))
    }, readyTimeoutMs)

    return {
      close() {
        if (!settled) {
          settled = true
          teardown()
        }
        // Only close the shared named window if THIS checkout is still the latest
        // launch; a newer open() reused the same window and owns it now, so a stale
        // handle.close() must stay silent rather than close the active checkout.
        if (myGen === popupGen) {
          try {
            popup.close()
          } catch {
            /* ignore */
          }
        }
      },
    }
  }

  // fulfillableParams resolves a fulfillable intent (cs OR merchant+productKey) into
  // URL params, or returns null when the option set is invalid. Exactly one price
  // source is allowed: a `checkoutId` combined with product fields is rejected so the
  // contract (and the "never a price in the URL" boundary) cannot be muddled. The
  // merchant reference + redirect URLs (clientReferenceId/successUrl/cancelUrl) are
  // NON-price params and therefore allowed alongside any price source.
  function fulfillableParams(opts: {
    merchant?: string
    productKey?: string
    checkoutId?: string
    token?: string
    chain?: number
    clientReferenceId?: string
    successUrl?: string
    cancelUrl?: string
  }): Record<string, string> | null {
    const hasCs = !!opts.checkoutId
    const hasProduct = !!opts.merchant && !!opts.productKey
    if (hasCs && (opts.merchant || opts.productKey)) return null // ambiguous price source
    if (!hasCs && !hasProduct) return null // no price source
    return buildParams({
      merchant: opts.merchant,
      productKey: opts.productKey,
      checkoutId: opts.checkoutId,
      token: opts.token,
      chain: opts.chain,
      clientReferenceId: opts.clientReferenceId,
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
    })
  }

  function open(opts: OpenOptions): CheckoutHandle {
    const params = fulfillableParams(opts)
    if (!params) {
      opts.onError?.('invalid_options')
      return noopHandle()
    }
    const p = pathFor(params)
    if (opts.display === 'redirect') {
      env.navigate(buildUrl(origin, p, params))
      return noopHandle()
    }
    return launchPopup(p, params, opts, opts.display === 'tab' ? TAB_FEATURES : POPUP_FEATURES)
  }

  function openCustom(opts: OpenCustomOptions): CheckoutHandle {
    if (!opts.merchant || !opts.amount) {
      opts.onError?.('invalid_options')
      return noopHandle()
    }
    // Custom amount is a browser-supplied (untrusted) price → always the legacy
    // QuickPay checkout page, never the server-pinned `/checkout` session page.
    const params = buildParams({
      merchant: opts.merchant,
      amount: opts.amount,
      memo: opts.memo,
      token: opts.token,
      chain: opts.chain,
      clientReferenceId: opts.clientReferenceId,
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
    })
    if (opts.display === 'redirect') {
      env.navigate(buildUrl(origin, quickpayPath, params))
      return noopHandle()
    }
    return launchPopup(quickpayPath, params, opts, opts.display === 'tab' ? TAB_FEATURES : POPUP_FEATURES)
  }

  function redirectToCheckout(opts: RedirectOptions): void {
    // Fulfillable only (cs OR merchant+productKey); never carries a price. No
    // callbacks here, so a misuse is a hard programming error → throw.
    const params = fulfillableParams(opts)
    if (!params) {
      throw new Error('goatx402-checkout: redirectToCheckout requires checkoutId OR merchant+productKey (and not both)')
    }
    env.navigate(buildUrl(origin, pathFor(params), params))
  }

  // openDelegate is a DEPRECATED thin alias: a DELEGATE checkout id is now the SAME
  // kind of handle from the same create endpoint and opens the SAME unified page, so it
  // simply forwards to open({ checkoutId: handle }). The page learns DIRECT vs DELEGATE
  // from the server read — no separate path/param.
  /** @deprecated Use open({ checkoutId: handle }). */
  function openDelegate(opts: OpenDelegateOptions): CheckoutHandle {
    return open({
      checkoutId: opts.handle,
      display: opts.display,
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      onSuccess: opts.onSuccess,
      onCancel: opts.onCancel,
      onError: opts.onError,
    })
  }

  /** @deprecated Use redirectToCheckout({ checkoutId: handle }). */
  function redirectToDelegateCheckout(opts: RedirectDelegateOptions): void {
    redirectToCheckout({
      checkoutId: opts.handle,
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
    })
  }

  return { open, openCustom, redirectToCheckout, openDelegate, redirectToDelegateCheckout }
}

// Exposed for unit tests.
export const __test = { validateOrigin, validateCheckoutPath, buildParams, buildUrl }
