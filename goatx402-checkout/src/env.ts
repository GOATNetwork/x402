// Browser-environment abstraction so the popup/postMessage orchestration is
// unit-testable without a real DOM. The default implementation binds to the real
// window; tests inject a fake.

/** Minimal view of a popup window the SDK drives. */
export interface PopupWindow {
  /** May throw or stay false when COOP severs the WindowProxy — read defensively. */
  readonly closed: boolean
  postMessage(message: unknown, targetOrigin: string): void
  close(): void
}

/** Minimal view of a `message` event the SDK validates. */
export interface IncomingMessage {
  readonly origin: string
  readonly source: unknown
  readonly data: unknown
}

export interface BrowserEnv {
  /**
   * window.open; returns null when the browser blocks the popup. `name` is the
   * window target name — each GoatCheckout instance passes its own unique name
   * so independent instances never share (and fight over) one OS window. When
   * omitted, a constant fallback name is used.
   */
  openPopup(url: string, features: string, name?: string): PopupWindow | null
  /** Full-page navigation (window.location.assign). */
  navigate(url: string): void
  addMessageListener(cb: (e: IncomingMessage) => void): void
  removeMessageListener(cb: (e: IncomingMessage) => void): void
  setInterval(cb: () => void, ms: number): number
  clearInterval(id: number): void
  setTimeout(cb: () => void, ms: number): number
  clearTimeout(id: number): void
  /** The opener page's own origin (sent as `o` so the popup can target it). */
  readonly openerOrigin: string
  /** Cryptographically-strong nonce for the postMessage channel. */
  randomNonce(): string
}

/** True when running in a browser with the APIs the default env needs. */
export function hasBrowserEnv(): boolean {
  return typeof window !== 'undefined' && typeof window.open === 'function'
}

/** Fallback window name used only when a caller does not supply one. */
const POPUP_NAME = 'goat_checkout'

/** defaultBrowserEnv binds the SDK to the real window. */
export function defaultBrowserEnv(): BrowserEnv {
  return {
    openPopup(url, features, name) {
      // The caller (GoatCheckout) supplies a per-instance unique name, so
      // repeated opens from one instance reuse its window while separate
      // instances get separate windows.
      return window.open(url, name || POPUP_NAME, features) as unknown as PopupWindow | null
    },
    navigate(url) {
      window.location.assign(url)
    },
    addMessageListener(cb) {
      // A real MessageEvent carries origin/source/data, matching IncomingMessage at
      // runtime; the cast bridges the DOM Event type. Same reference is used for
      // removal below so removeEventListener actually unsubscribes.
      window.addEventListener('message', cb as unknown as EventListener)
    },
    removeMessageListener(cb) {
      window.removeEventListener('message', cb as unknown as EventListener)
    },
    setInterval: (cb, ms) => window.setInterval(cb, ms),
    clearInterval: (id) => window.clearInterval(id),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    openerOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    randomNonce() {
      const g: any = globalThis
      if (g.crypto?.getRandomValues) {
        const buf = new Uint8Array(16)
        g.crypto.getRandomValues(buf)
        return Array.from(buf, (b: number) => b.toString(16).padStart(2, '0')).join('')
      }
      // No secure RNG: refuse rather than emit a guessable channel nonce.
      throw new Error('goatx402-checkout: a secure crypto RNG is required (window.crypto.getRandomValues)')
    },
  }
}
