// Browser IIFE entry: attaches a global `GoatCheckout` factory so the SDK can be
// dropped in with a plain <script src=".../checkout.js"> tag (no bundler, no
// framework). `GoatCheckout({ origin }).open({ ... })`.
import { GoatCheckout } from './checkout.js'

declare global {
  interface Window {
    GoatCheckout: typeof GoatCheckout
  }
}

if (typeof window !== 'undefined') {
  window.GoatCheckout = GoatCheckout
}

export { GoatCheckout }
