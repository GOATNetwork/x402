import { describe, it, expect, vi } from 'vitest'
import { GoatCheckout } from '../src/checkout.js'
import type { BrowserEnv, IncomingMessage, PopupWindow } from '../src/env.js'

const ORIGIN = 'https://pay.goat.network'
const OPENER = 'https://shop.example'
const NONCE = 'nonce-test'

class FakePopup implements PopupWindow {
  closed = false
  posted: { message: unknown; targetOrigin: string }[] = []
  closeCalled = false
  postMessage(message: unknown, targetOrigin: string): void {
    this.posted.push({ message, targetOrigin })
  }
  close(): void {
    this.closeCalled = true
    this.closed = true
  }
}

function fakeEnv(opts: { blockPopup?: boolean; openerOrigin?: string; reusePopup?: boolean } = {}) {
  const listeners = new Set<(e: IncomingMessage) => void>()
  const intervals = new Map<number, () => void>()
  const timeouts = new Map<number, () => void>()
  let idc = 1
  const popups: FakePopup[] = []
  const navigations: string[] = []
  const opened: string[] = []
  // Model real window.open name semantics: one live window per target name.
  const sharedByName = new Map<string, FakePopup>()

  const env: BrowserEnv = {
    openPopup(url, _features, name) {
      opened.push(url)
      if (opts.blockPopup) return null
      // reusePopup mirrors the real browser reusing one window per name — so
      // opens sharing a name get one window, and distinct names get distinct
      // windows (as independent GoatCheckout instances now do).
      if (opts.reusePopup) {
        const key = name ?? ''
        let shared = sharedByName.get(key)
        if (!shared) {
          shared = new FakePopup()
          sharedByName.set(key, shared)
          popups.push(shared)
        }
        return shared
      }
      const p = new FakePopup()
      popups.push(p)
      return p
    },
    navigate(url) {
      navigations.push(url)
    },
    addMessageListener(cb) {
      listeners.add(cb)
    },
    removeMessageListener(cb) {
      listeners.delete(cb)
    },
    setInterval(cb) {
      const id = idc++
      intervals.set(id, cb)
      return id
    },
    clearInterval(id) {
      intervals.delete(id)
    },
    setTimeout(cb) {
      const id = idc++
      timeouts.set(id, cb)
      return id
    },
    clearTimeout(id) {
      timeouts.delete(id)
    },
    openerOrigin: opts.openerOrigin ?? OPENER,
    randomNonce: () => NONCE,
  }

  return {
    env,
    popups,
    navigations,
    opened,
    listeners,
    intervals,
    timeouts,
    fireMessage(e: { origin?: string; source?: unknown; data: unknown }) {
      for (const l of [...listeners]) l({ origin: e.origin ?? ORIGIN, source: e.source, data: e.data } as IncomingMessage)
    },
    tickPoll(n = 1) {
      for (let i = 0; i < n; i++) for (const cb of [...intervals.values()]) cb()
    },
    fireTimeouts() {
      const cbs = [...timeouts.values()]
      timeouts.clear()
      for (const cb of cbs) cb()
    },
  }
}

describe('validateOrigin (via factory)', () => {
  it('rejects http on a non-loopback host', () => {
    expect(() => GoatCheckout({ origin: 'http://pay.goat.network' }, fakeEnv().env)).toThrow(/https/)
  })
  it('rejects an origin with a path', () => {
    expect(() => GoatCheckout({ origin: 'https://pay.goat.network/x' }, fakeEnv().env)).toThrow(/bare/)
  })
  it('rejects credentials in the origin', () => {
    expect(() => GoatCheckout({ origin: 'https://u:p@pay.goat.network' }, fakeEnv().env)).toThrow(/credentials/)
  })
  it('accepts https and http localhost', () => {
    expect(() => GoatCheckout({ origin: 'https://pay.goat.network' }, fakeEnv().env)).not.toThrow()
    expect(() => GoatCheckout({ origin: 'http://localhost:3005' }, fakeEnv().env)).not.toThrow()
  })
})

describe('open — URL building', () => {
  it('product mode builds m/product_key + channel o/n and opens a popup', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    goat.open({ merchant: 'acme', productKey: 'mug', token: 'USDC', chain: 4217 })
    expect(f.opened).toHaveLength(1)
    const u = new URL(f.opened[0])
    expect(u.origin).toBe(ORIGIN)
    // product/custom opens target the legacy QuickPay checkout page; only a `cs`
    // CheckoutSession uses the unified /checkout page.
    expect(u.pathname).toBe('/quickpay/checkout')
    expect(u.searchParams.get('m')).toBe('acme')
    expect(u.searchParams.get('product_key')).toBe('mug')
    expect(u.searchParams.get('token')).toBe('USDC')
    expect(u.searchParams.get('chain')).toBe('4217')
    expect(u.searchParams.get('o')).toBe(OPENER)
    expect(u.searchParams.get('n')).toBe(NONCE)
    // never carries a price for a fulfillable purchase
    expect(u.searchParams.get('amount')).toBeNull()
  })

  it('checkoutId mode builds cs (alone; no m/product_key) on the unified /checkout page', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ checkoutId: 'cs_live_1' })
    const u = new URL(f.opened[0])
    expect(u.pathname).toBe('/checkout')
    expect(u.searchParams.get('cs')).toBe('cs_live_1')
    expect(u.searchParams.get('m')).toBeNull()
    expect(u.searchParams.get('product_key')).toBeNull()
  })

  it('missing price source → onError(invalid_options), no popup', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', onError })
    expect(onError).toHaveBeenCalledWith('invalid_options')
    expect(f.opened).toHaveLength(0)
  })

  it('blocked popup → onError(popup_blocked)', () => {
    const f = fakeEnv({ blockPopup: true })
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onError })
    expect(onError).toHaveBeenCalledWith('popup_blocked')
  })
})

describe('open — popup message channel', () => {
  const setup = () => {
    const f = fakeEnv()
    const onSuccess = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onSuccess, onCancel, onError })
    return { f, popup: f.popups[0], onSuccess, onCancel, onError }
  }

  it('success → onSuccess(result) + acks the popup', () => {
    const { f, popup, onSuccess } = setup()
    f.fireMessage({ source: popup, data: { type: 'goat:success', n: NONCE, session_id: 's1', tx_hash: '0xabc', status: 'PAYMENT_CONFIRMED', product_key: 'mug' } })
    expect(onSuccess).toHaveBeenCalledWith({ session_id: 's1', tx_hash: '0xabc', status: 'PAYMENT_CONFIRMED', product_key: 'mug' })
    expect(popup.posted).toContainEqual({ message: { type: 'goat:ack', n: NONCE }, targetOrigin: ORIGIN })
  })

  it('cancel message → onCancel', () => {
    const { f, popup, onCancel } = setup()
    f.fireMessage({ source: popup, data: { type: 'goat:cancel', n: NONCE } })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('error message → onError(checkout_error, message)', () => {
    const { f, popup, onError } = setup()
    f.fireMessage({ source: popup, data: { type: 'goat:error', n: NONCE, message: 'terms mismatch' } })
    expect(onError).toHaveBeenCalledWith('checkout_error', 'terms mismatch')
  })

  it('ignores a message from the WRONG origin', () => {
    const { f, popup, onSuccess } = setup()
    f.fireMessage({ origin: 'https://evil.example', source: popup, data: { type: 'goat:success', n: NONCE } })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('ignores a message from the WRONG source window', () => {
    const { f, onSuccess } = setup()
    f.fireMessage({ source: new FakePopup(), data: { type: 'goat:success', n: NONCE } })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('ignores a message with the WRONG nonce', () => {
    const { f, popup, onSuccess } = setup()
    f.fireMessage({ source: popup, data: { type: 'goat:success', n: 'other' } })
    expect(onSuccess).not.toHaveBeenCalled()
  })
})

describe('open — close / settle races', () => {
  it('closed popup after grace → onCancel', () => {
    const f = fakeEnv()
    const onCancel = vi.fn()
    GoatCheckout({ origin: ORIGIN, closeGraceMs: 600 }, f.env).open({ merchant: 'acme', productKey: 'mug', onCancel })
    f.popups[0].closed = true
    f.tickPoll(1) // graceTicks = ceil(600/400)=2; first tick not enough
    expect(onCancel).not.toHaveBeenCalled()
    f.tickPoll(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('terminal success wins over a subsequent close (no double-callback)', () => {
    const f = fakeEnv()
    const onSuccess = vi.fn()
    const onCancel = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onSuccess, onCancel })
    const popup = f.popups[0]
    f.fireMessage({ source: popup, data: { type: 'goat:success', n: NONCE, session_id: 's1' } })
    popup.closed = true
    f.tickPoll(5)
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('open — opener_unavailable (ready timeout)', () => {
  it('no goat:ready and popup still open → onError(opener_unavailable)', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onError })
    f.fireTimeouts()
    expect(onError).toHaveBeenCalledWith('opener_unavailable')
  })

  it('goat:ready clears the timeout → no opener_unavailable', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onError })
    f.fireMessage({ source: f.popups[0], data: { type: 'goat:ready', n: NONCE } })
    f.fireTimeouts()
    expect(onError).not.toHaveBeenCalled()
  })

  it('popup already closed when timeout fires → no opener_unavailable (poll reports cancel)', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onError })
    f.popups[0].closed = true
    f.fireTimeouts()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('redirect / openCustom', () => {
  it('display:redirect navigates instead of opening a popup', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', display: 'redirect' })
    expect(f.opened).toHaveLength(0)
    expect(f.navigations).toHaveLength(1)
    const u = new URL(f.navigations[0])
    expect(u.searchParams.get('product_key')).toBe('mug')
    expect(u.searchParams.get('o')).toBeNull() // no channel on a full redirect
  })

  it('redirectToCheckout builds the URL and navigates', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).redirectToCheckout({ checkoutId: 'cs_1' })
    expect(new URL(f.navigations[0]).searchParams.get('cs')).toBe('cs_1')
  })

  it('openCustom carries the untrusted amount/memo', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).openCustom({ merchant: 'acme', amount: '12.50', memo: 'tip' })
    const u = new URL(f.opened[0])
    expect(u.searchParams.get('amount')).toBe('12.50')
    expect(u.searchParams.get('memo')).toBe('tip')
    expect(u.searchParams.get('m')).toBe('acme')
  })

  it('openCustom without amount → invalid_options', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).openCustom({ merchant: 'acme', amount: '', onError })
    expect(onError).toHaveBeenCalledWith('invalid_options')
    expect(f.opened).toHaveLength(0)
  })
})

describe('handle.close()', () => {
  it('tears down and closes the popup without firing callbacks', () => {
    const f = fakeEnv()
    const onCancel = vi.fn()
    const onSuccess = vi.fn()
    const h = GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug', onCancel, onSuccess })
    h.close()
    expect(f.popups[0].closeCalled).toBe(true)
    expect(f.listeners.size).toBe(0) // listener removed
    // a late success after close is ignored
    f.fireMessage({ source: f.popups[0], data: { type: 'goat:success', n: NONCE } })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('a stale handle from one instance never closes another instance window', () => {
    // Shared browser env (windows reused per name); two independent GoatCheckout
    // instances each get their own unique popup name, so a stale handle from the
    // first must not close the second's active window.
    const f = fakeEnv({ reusePopup: true })
    const hA = GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug' })
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug' })

    // Two distinct windows opened (one per instance name), not a shared one.
    expect(f.popups).toHaveLength(2)
    const [popupA, popupB] = f.popups

    hA.close()
    expect(popupA.closeCalled).toBe(true) // A closes its own window
    expect(popupB.closeCalled).toBe(false) // B's active window is untouched
  })
})

describe('checkoutPath validation', () => {
  it('rejects an absolute/protocol-relative/scheme/query/fragment path', () => {
    for (const p of ['https://evil.example/c', '//evil.example/c', 'javascript:alert(1)', '/c?amount=1', '/c#frag', 'c']) {
      expect(() => GoatCheckout({ origin: ORIGIN, checkoutPath: p }, fakeEnv().env)).toThrow()
    }
  })
  it('accepts a clean root-relative path (checkoutPath overrides the unified cs page)', () => {
    const f = fakeEnv()
    // checkoutPath customizes the unified CheckoutSession page (cs); product/custom
    // always use the fixed /quickpay/checkout page.
    GoatCheckout({ origin: ORIGIN, checkoutPath: '/c2' }, f.env).open({ checkoutId: 'cs_1' })
    expect(new URL(f.opened[0]).pathname).toBe('/c2')
  })
})

describe('price-source / URL-boundary enforcement', () => {
  it('open() rejects checkoutId combined with product fields', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ checkoutId: 'cs_1', merchant: 'acme', productKey: 'mug', onError })
    expect(onError).toHaveBeenCalledWith('invalid_options')
    expect(f.opened).toHaveLength(0)
  })

  it('redirectToCheckout throws on an ambiguous/empty price source, navigates on a valid one', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    expect(() => goat.redirectToCheckout({ checkoutId: 'cs_1', productKey: 'mug' })).toThrow(/checkoutId OR/)
    expect(() => goat.redirectToCheckout({ merchant: 'acme' })).toThrow() // productKey missing
    goat.redirectToCheckout({ merchant: 'acme', productKey: 'mug' })
    expect(new URL(f.navigations[0]).searchParams.get('product_key')).toBe('mug')
    // redirect never carries a price (RedirectOptions has no amount)
    expect(new URL(f.navigations[0]).searchParams.get('amount')).toBeNull()
  })
})

describe('merchant reference + redirect URLs (client_reference_id / success_url / cancel_url)', () => {
  const REF = 'demo-order-123'
  const SUCCESS = 'https://shop.example/ok'
  const CANCEL = 'https://shop.example/cancelled'

  it('open() carries client_reference_id/success_url/cancel_url when provided', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).open({
      merchant: 'acme',
      productKey: 'mug',
      clientReferenceId: REF,
      successUrl: SUCCESS,
      cancelUrl: CANCEL,
    })
    const u = new URL(f.opened[0])
    expect(u.searchParams.get('client_reference_id')).toBe(REF)
    expect(u.searchParams.get('success_url')).toBe(SUCCESS)
    expect(u.searchParams.get('cancel_url')).toBe(CANCEL)
    // still NOT a price source — the boundary is unchanged
    expect(u.searchParams.get('amount')).toBeNull()
  })

  it('open() omits the params when absent', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).open({ merchant: 'acme', productKey: 'mug' })
    const u = new URL(f.opened[0])
    expect(u.searchParams.has('client_reference_id')).toBe(false)
    expect(u.searchParams.has('success_url')).toBe(false)
    expect(u.searchParams.has('cancel_url')).toBe(false)
  })

  it('open(checkoutId) also carries the reference + redirect URLs', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).open({
      checkoutId: 'cs_1',
      clientReferenceId: REF,
      successUrl: SUCCESS,
    })
    const u = new URL(f.opened[0])
    expect(u.searchParams.get('cs')).toBe('cs_1')
    expect(u.searchParams.get('client_reference_id')).toBe(REF)
    expect(u.searchParams.get('success_url')).toBe(SUCCESS)
    expect(u.searchParams.has('cancel_url')).toBe(false)
  })

  it('openCustom() carries the reference + redirect URLs when provided, omits when absent', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    goat.openCustom({ merchant: 'acme', amount: '12.50', clientReferenceId: REF, successUrl: SUCCESS, cancelUrl: CANCEL })
    const withParams = new URL(f.opened[0])
    expect(withParams.searchParams.get('client_reference_id')).toBe(REF)
    expect(withParams.searchParams.get('success_url')).toBe(SUCCESS)
    expect(withParams.searchParams.get('cancel_url')).toBe(CANCEL)

    goat.openCustom({ merchant: 'acme', amount: '12.50' })
    const without = new URL(f.opened[1])
    expect(without.searchParams.has('client_reference_id')).toBe(false)
    expect(without.searchParams.has('success_url')).toBe(false)
    expect(without.searchParams.has('cancel_url')).toBe(false)
  })

  it('redirectToCheckout() carries the reference + redirect URLs when provided, omits when absent', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    goat.redirectToCheckout({ checkoutId: 'cs_1', clientReferenceId: REF, successUrl: SUCCESS, cancelUrl: CANCEL })
    const withParams = new URL(f.navigations[0])
    expect(withParams.searchParams.get('client_reference_id')).toBe(REF)
    expect(withParams.searchParams.get('success_url')).toBe(SUCCESS)
    expect(withParams.searchParams.get('cancel_url')).toBe(CANCEL)

    goat.redirectToCheckout({ merchant: 'acme', productKey: 'mug' })
    const without = new URL(f.navigations[1])
    expect(without.searchParams.has('client_reference_id')).toBe(false)
    expect(without.searchParams.has('success_url')).toBe(false)
    expect(without.searchParams.has('cancel_url')).toBe(false)
  })
})

describe('single active checkout (double-open)', () => {
  it('a second open() retires the first; the first never fires a late callback', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    const onCancelA = vi.fn()
    const onSuccessA = vi.fn()
    goat.open({ merchant: 'acme', productKey: 'mug', onCancel: onCancelA, onSuccess: onSuccessA })
    const onSuccessB = vi.fn()
    goat.open({ merchant: 'acme', productKey: 'mug', onSuccess: onSuccessB })
    expect(f.listeners.size).toBe(1) // A's listener was removed when B took over
    // B succeeds
    f.fireMessage({ source: f.popups[1], data: { type: 'goat:success', n: NONCE, session_id: 's' } })
    expect(onSuccessB).toHaveBeenCalledTimes(1)
    // A's popup later closes — A must stay silent (it was superseded)
    f.popups[0].closed = true
    f.tickPoll(5)
    expect(onCancelA).not.toHaveBeenCalled()
    expect(onSuccessA).not.toHaveBeenCalled()
  })

  it('a stale handle.close() does NOT close a newer checkout’s reused window', () => {
    const f = fakeEnv({ reusePopup: true })
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    const onSuccessA = vi.fn()
    const hA = goat.open({ merchant: 'acme', productKey: 'mug', onSuccess: onSuccessA })
    const onSuccessB = vi.fn()
    goat.open({ merchant: 'acme', productKey: 'mug', onSuccess: onSuccessB })
    expect(f.popups).toHaveLength(1) // the same window was reused
    const shared = f.popups[0]
    hA.close() // stale handle — must not touch B's window
    expect(shared.closeCalled).toBe(false)
    // B is still live and callback-capable
    f.fireMessage({ source: shared, data: { type: 'goat:success', n: NONCE, session_id: 's' } })
    expect(onSuccessB).toHaveBeenCalledTimes(1)
    expect(onSuccessA).not.toHaveBeenCalled()
  })
})

describe('openDelegate — DELEGATE hosted checkout', () => {
  const HANDLE = 'dcs_live_1'

  it('builds /checkout?cs=...&o=...&n=... and opens a popup (no price)', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).openDelegate({ handle: HANDLE })
    expect(f.opened).toHaveLength(1)
    const u = new URL(f.opened[0])
    expect(u.origin).toBe(ORIGIN)
    expect(u.pathname).toBe('/checkout') // unified page (same as DIRECT)
    expect(u.searchParams.get('cs')).toBe(HANDLE) // delegate handle rides as cs now
    expect(u.searchParams.get('h')).toBeNull() // old `h` param is gone
    expect(u.searchParams.get('o')).toBe(OPENER)
    expect(u.searchParams.get('n')).toBe(NONCE)
    // never carries a price/terms — those are pinned server-side on the session
    expect(u.searchParams.get('amount')).toBeNull()
    expect(u.searchParams.get('m')).toBeNull()
  })

  it('carries success_url/cancel_url when provided, omits when absent', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    goat.openDelegate({ handle: HANDLE, successUrl: 'https://shop.example/ok', cancelUrl: 'https://shop.example/no' })
    const withUrls = new URL(f.opened[0])
    expect(withUrls.searchParams.get('success_url')).toBe('https://shop.example/ok')
    expect(withUrls.searchParams.get('cancel_url')).toBe('https://shop.example/no')
    goat.openDelegate({ handle: HANDLE })
    const without = new URL(f.opened[1])
    expect(without.searchParams.has('success_url')).toBe(false)
    expect(without.searchParams.has('cancel_url')).toBe(false)
  })

  it('honors the unified custom checkoutPath (delegateCheckoutPath is ignored)', () => {
    const f = fakeEnv()
    // openDelegate now forwards to the unified page, so it follows checkoutPath; the
    // legacy delegateCheckoutPath is ignored.
    GoatCheckout({ origin: ORIGIN, checkoutPath: '/d/checkout', delegateCheckoutPath: '/ignored' }, f.env).openDelegate({ handle: HANDLE })
    const u = new URL(f.opened[0])
    expect(u.pathname).toBe('/d/checkout')
    expect(u.searchParams.get('cs')).toBe(HANDLE)
  })

  it('missing/empty handle → onError(invalid_options), no popup', () => {
    const f = fakeEnv()
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).openDelegate({ handle: '', onError })
    expect(onError).toHaveBeenCalledWith('invalid_options')
    expect(f.opened).toHaveLength(0)
  })

  it('display:redirect navigates with cs instead of opening a popup (no channel)', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).openDelegate({ handle: HANDLE, display: 'redirect' })
    expect(f.opened).toHaveLength(0)
    const u = new URL(f.navigations[0])
    expect(u.pathname).toBe('/checkout')
    expect(u.searchParams.get('cs')).toBe(HANDLE)
    expect(u.searchParams.get('o')).toBeNull() // no channel on a full redirect
  })

  it('blocked popup → onError(popup_blocked)', () => {
    const f = fakeEnv({ blockPopup: true })
    const onError = vi.fn()
    GoatCheckout({ origin: ORIGIN }, f.env).openDelegate({ handle: HANDLE, onError })
    expect(onError).toHaveBeenCalledWith('popup_blocked')
  })

  describe('shares the hardened postMessage channel', () => {
    const setup = () => {
      const f = fakeEnv()
      const onSuccess = vi.fn()
      const onCancel = vi.fn()
      const onError = vi.fn()
      GoatCheckout({ origin: ORIGIN }, f.env).openDelegate({ handle: HANDLE, onSuccess, onCancel, onError })
      return { f, popup: f.popups[0], onSuccess, onCancel, onError }
    }

    it('success surfaces order_id/handle/client_reference_id + acks', () => {
      const { f, popup, onSuccess } = setup()
      f.fireMessage({
        source: popup,
        data: {
          type: 'goat:success',
          n: NONCE,
          status: 'PAYMENT_CONFIRMED',
          tx_hash: '0xabc',
          order_id: 'ord_9',
          handle: HANDLE,
          client_reference_id: 'cart-7',
        },
      })
      expect(onSuccess).toHaveBeenCalledWith({
        session_id: undefined,
        tx_hash: '0xabc',
        status: 'PAYMENT_CONFIRMED',
        product_key: undefined,
        order_id: 'ord_9',
        handle: HANDLE,
        client_reference_id: 'cart-7',
      })
      expect(popup.posted).toContainEqual({ message: { type: 'goat:ack', n: NONCE }, targetOrigin: ORIGIN })
    })

    it('cancel message → onCancel', () => {
      const { f, popup, onCancel } = setup()
      f.fireMessage({ source: popup, data: { type: 'goat:cancel', n: NONCE } })
      expect(onCancel).toHaveBeenCalledTimes(1)
    })

    it('ignores wrong origin / wrong source / wrong nonce', () => {
      const { f, popup, onSuccess } = setup()
      f.fireMessage({ origin: 'https://evil.example', source: popup, data: { type: 'goat:success', n: NONCE } })
      f.fireMessage({ source: new FakePopup(), data: { type: 'goat:success', n: NONCE } })
      f.fireMessage({ source: popup, data: { type: 'goat:success', n: 'other' } })
      expect(onSuccess).not.toHaveBeenCalled()
    })
  })

  it('participates in single-active-checkout supersede with open()', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    const onCancelA = vi.fn()
    goat.openDelegate({ handle: HANDLE, onCancel: onCancelA })
    const onSuccessB = vi.fn()
    goat.open({ merchant: 'acme', productKey: 'mug', onSuccess: onSuccessB })
    expect(f.listeners.size).toBe(1) // A's listener retired when B took over
    f.fireMessage({ source: f.popups[1], data: { type: 'goat:success', n: NONCE, session_id: 's' } })
    expect(onSuccessB).toHaveBeenCalledTimes(1)
    f.popups[0].closed = true
    f.tickPoll(5)
    expect(onCancelA).not.toHaveBeenCalled()
  })
})

describe('redirectToDelegateCheckout', () => {
  const HANDLE = 'dcs_live_2'

  it('navigates to /checkout with cs (and optional redirect URLs)', () => {
    const f = fakeEnv()
    GoatCheckout({ origin: ORIGIN }, f.env).redirectToDelegateCheckout({ handle: HANDLE, successUrl: 'https://shop.example/ok' })
    const u = new URL(f.navigations[0])
    expect(u.pathname).toBe('/checkout')
    expect(u.searchParams.get('cs')).toBe(HANDLE)
    expect(u.searchParams.get('h')).toBeNull()
    expect(u.searchParams.get('success_url')).toBe('https://shop.example/ok')
    expect(u.searchParams.get('o')).toBeNull() // no channel on a full redirect
  })

  it('throws on a missing handle (no callbacks)', () => {
    const f = fakeEnv()
    const goat = GoatCheckout({ origin: ORIGIN }, f.env)
    // Forwards to redirectToCheckout, which throws on an empty price source.
    expect(() => goat.redirectToDelegateCheckout({ handle: '' })).toThrow()
    expect(f.navigations).toHaveLength(0)
  })
})
