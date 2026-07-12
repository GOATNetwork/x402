/**
 * Checkout SDK demo — the Stripe-style drop-in.
 *
 * The developer renders their OWN product UI (name/image/price) and a single Pay
 * button. `goatx402-checkout` opens the platform-hosted checkout in a top-level
 * popup; the buyer connects a wallet and pays THERE. No wallet code, no order code
 * here. onSuccess is a UX signal only — real fulfillment is confirmed via webhook.
 */
import { useEffect, useMemo, useState } from 'react'
import { GoatCheckout } from 'goatx402-checkout'

// In local dev the hosted checkout (goatx402-quickpay-web) runs on :3005, the
// platform QuickPay origin. In prod this is e.g. https://pay.goat.network.
const CHECKOUT_ORIGIN = (import.meta.env.VITE_CHECKOUT_ORIGIN as string | undefined) ?? 'http://localhost:3005'
const MERCHANT = (import.meta.env.VITE_QUICKPAY_MERCHANT as string | undefined) ?? 'acme'
const PRODUCT_KEY = (import.meta.env.VITE_QUICKPAY_PRODUCT as string | undefined) ?? 'mug'
// The DIRECT (QuickPay product) button targets a SEPARATE, quickpay-enabled DIRECT merchant
// (VITE_QUICKPAY_MERCHANT) — not the DELEGATE merchant the backend HMAC key is for. Gate the
// button on it being explicitly configured, so we never fire a request at the 'acme' default.
const DIRECT_CONFIGURED = Boolean(import.meta.env.VITE_QUICKPAY_MERCHANT)

// The developer's own product display data (the merchant prices it server-side; the
// browser never sets the amount — we only pass the product_key).
const PRODUCT = {
  name: 'Coffee Mug',
  price: '9.99',
  image:
    'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=480&q=60',
  description: 'A sturdy ceramic mug. Priced by the merchant; you pick the token.',
}

// A merchant's own order reference. The browser passes it through to the checkout; Core
// echoes it back on the quickpay.payment.confirmed webhook (and any allowlisted redirect),
// so the developer can tie this payment to their order. It is a correlation hint, NOT a price.
function newDemoReference(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `demo-order-${rand}`
}

// The DELEGATE catalog is served by the demo BACKEND (server owns the price + display);
// the browser only ever sends a product_key. Web3-free on the merchant side.
type DelegateProduct = {
  product_key: string
  name: string
  description: string
  image: string
  price_usd: string
}
type DelegateCatalog = { merchant: { name: string; logo: string }; products: DelegateProduct[] }

export function CheckoutSdkDemo() {
  const [outcome, setOutcome] = useState('')
  // Double-submit guard: each DELEGATE click mints a server-side checkout session, so a
  // disabled-while-in-flight button keeps rapid clicks from creating duplicate session rows.
  const [busy, setBusy] = useState(false)
  // DELEGATE hosted checkout is OPTIONAL and config-gated on the backend — the section
  // only renders when GET /api/delegate-config reports { enabled: true } (DELEGATE_CHAIN_ID
  // set). The product list comes from GET /api/delegate-catalog. See server/index.ts.
  const [delegateEnabled, setDelegateEnabled] = useState(false)
  const [delegateCatalog, setDelegateCatalog] = useState<DelegateCatalog | null>(null)
  // quickpayCheckoutPath routes the DIRECT product open to the new /checkout/direct page
  // (the legacy /quickpay/checkout is kept as a back-compat alias on the hosted side).
  const goat = useMemo(() => GoatCheckout({ origin: CHECKOUT_ORIGIN, quickpayCheckoutPath: '/checkout/direct' }), [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/delegate-config')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then(async (d: { enabled?: boolean }) => {
        if (cancelled) return
        setDelegateEnabled(!!d.enabled)
        if (d.enabled) {
          try {
            const res = await fetch('/api/delegate-catalog')
            if (res.ok && !cancelled) setDelegateCatalog((await res.json()) as DelegateCatalog)
          } catch {
            /* catalog is best-effort; the section simply shows nothing if it fails */
          }
        }
      })
      .catch(() => {
        if (!cancelled) setDelegateEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // DELEGATE (TSS/Permit2/EIP-3009) hosted checkout. Unlike the DIRECT product flow above,
  // the session is server-created: the backend mints an opaque `checkout_id`
  // (POST /api/create-delegate-checkout), then the buyer is sent to the hosted
  // /checkout/delegate?cs=<id> page.
  //
  // OPEN IN A NEW TAB (matching DIRECT) despite the async create: the checkout_id is only
  // known AFTER an await, and window.open() after an await is pop-up-blocked. So we open a
  // BLANK tab SYNCHRONOUSLY inside the click gesture, then navigate it once the id resolves.
  // Outcome comes back via the success/cancel redirect + webhook (no popup callback channel).
  async function payDelegate(productKey: string) {
    if (busy) return // ignore rapid double-clicks — each create mints a session row
    setBusy(true)
    // Synchronous, inside the gesture → not blocked. Navigated below after the fetch.
    const tab = window.open('', '_blank')
    if (!tab) {
      setOutcome('⚠️ Allow pop-ups / new tabs to check out.')
      setBusy(false)
      return
    }
    setOutcome('Creating DELEGATE session…')
    try {
      const res = await fetch('/api/create-delegate-checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product_key: productKey }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        checkout_id?: string
        url?: string
        error?: string
      }
      if (!res.ok || !data.checkout_id) {
        tab.close()
        setOutcome(`⚠️ ${data.error ?? `Failed to create DELEGATE session (HTTP ${res.status})`}`)
        setBusy(false) // allow a retry
        return
      }
      // Navigate the already-open tab to the hosted DELEGATE checkout page.
      tab.location.href = `${CHECKOUT_ORIGIN}/checkout/delegate?cs=${encodeURIComponent(data.checkout_id)}`
      setOutcome('Opened checkout in a new tab — complete the payment there.')
      setBusy(false)
    } catch (err) {
      tab.close()
      setOutcome(`⚠️ ${err instanceof Error ? err.message : 'DELEGATE checkout failed'}`)
      setBusy(false)
    }
  }

  function pay() {
    if (busy) return
    // window.open runs synchronously inside this click handler (popup-blocker rule).
    const reference = newDemoReference()
    setBusy(true)
    setOutcome(`Opening checkout… (reference ${reference})`)
    goat.open({
      merchant: MERCHANT,
      productKey: PRODUCT_KEY,
      // Open in a NEW TAB (consistent with the DELEGATE buttons). The tab keeps window.opener,
      // so onSuccess/onCancel still relay back here; success/cancel URLs are omitted.
      display: 'tab',
      clientReferenceId: reference,
      onSuccess: (r) => {
        setBusy(false)
        setOutcome(
          `✅ Payment submitted (status ${r.status ?? '?'}, tx ${r.tx_hash ?? '—'}, reference ${reference}). Confirm fulfillment via webhook.`,
        )
      },
      onCancel: () => {
        setBusy(false)
        setOutcome(`Checkout cancelled. (reference ${reference})`)
      },
      onError: (reason) => {
        setBusy(false)
        setOutcome(`⚠️ ${reason}${reason === 'opener_unavailable' ? ' — this page should use redirect mode.' : ''}`)
      },
    })
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex gap-4">
        <img src={PRODUCT.image} alt="" className="h-20 w-20 rounded object-cover" referrerPolicy="no-referrer" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-800">{PRODUCT.name}</h2>
          <p className="text-sm text-gray-500">{PRODUCT.description}</p>
          <p className="mt-1 text-xl font-bold text-gray-900">${PRODUCT.price}</p>
        </div>
      </div>

      <button
        onClick={pay}
        disabled={busy || !DIRECT_CONFIGURED}
        className="w-full rounded-md bg-blue-600 px-4 py-3 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
      >
        {DIRECT_CONFIGURED ? `Pay with GoatX402 — DIRECT (${MERCHANT})` : 'Pay with GoatX402 — DIRECT'}
      </button>
      {!DIRECT_CONFIGURED && (
        <p className="text-xs text-amber-600">
          DIRECT QuickPay demo not configured — this button targets a separate quickpay-enabled
          DIRECT merchant. Set <code>VITE_QUICKPAY_MERCHANT</code> / <code>VITE_QUICKPAY_PRODUCT</code>{' '}
          (e.g. <code>test-merchant-1</code> / <code>mug</code>) and restart the dev server.
        </p>
      )}

      {delegateEnabled && (
        <div className="space-y-3 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-700">DELEGATE hosted checkout (cross-chain, TSS / Permit2)</p>
          <p className="text-xs text-gray-400">
            Server-authoritative + web3-free: the merchant site sends only a product key + USD
            price. The buyer picks any supported source chain + token on the hosted page; the
            callback/settlement stays on the merchant's single callback chain.
          </p>
          {(delegateCatalog?.products ?? []).map((p) => (
            <div key={p.product_key} className="flex items-center gap-3 rounded-md border border-gray-100 p-3">
              <img src={p.image} alt="" className="h-12 w-12 rounded object-cover" referrerPolicy="no-referrer" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-800">{p.name}</p>
                <p className="text-xs text-gray-500">${p.price_usd} · pick token + chain on the hosted page</p>
              </div>
              <button
                onClick={() => payDelegate(p.product_key)}
                disabled={busy}
                className="shrink-0 rounded-md bg-purple-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-purple-600"
              >
                Pay (DELEGATE)
              </button>
            </div>
          ))}
          {!delegateCatalog && <p className="text-xs text-gray-400">Loading catalog…</p>}
        </div>
      )}

      {outcome && <p className="text-sm text-gray-700">{outcome}</p>}

      <p className="text-xs text-gray-400">
        Integration: <code>GoatCheckout({'{'} origin {'}'}).open({'{'} merchant, productKey {'}'})</code> — no wallet or
        order code in this page.
      </p>
    </div>
  )
}
