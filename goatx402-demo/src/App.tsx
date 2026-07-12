/**
 * GoatX402 Pay Demo Application.
 *
 * Two integration paths:
 *  - "Checkout SDK (recommended)" — the Stripe-style drop-in (goatx402-checkout):
 *    pass product/display, the SDK opens the hosted checkout. No wallet/order code.
 *  - "Advanced (build your own)" — the original self-built flow (wallet + PaymentHelper
 *    + HMAC backend orders), keeping its Classic + MPP sub-tabs.
 *
 * The mode switch is top-level so the Advanced subtree (and its wallet/config/MPP
 * hooks) only mounts when selected — the Checkout SDK tab needs none of it.
 */
import { useState } from 'react'
import { AdvancedDemo } from './pages/AdvancedDemo'
import { CheckoutSdkDemo } from './pages/CheckoutSdkDemo'

type Mode = 'checkout' | 'advanced'

function App() {
  const [mode, setMode] = useState<Mode>('checkout')

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="max-w-md mx-auto px-4 space-y-4">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-800">GoatX402 Pay</h1>
          <p className="text-gray-600 mt-2">Demo Payment Application</p>
        </div>

        {/* Top-level integration mode */}
        <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
          <button
            onClick={() => setMode('checkout')}
            className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
              mode === 'checkout' ? 'bg-green-100 text-green-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Checkout SDK (recommended)
          </button>
          <button
            onClick={() => setMode('advanced')}
            className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
              mode === 'advanced' ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Advanced (build your own)
          </button>
        </div>

        {mode === 'checkout' ? <CheckoutSdkDemo /> : <AdvancedDemo />}

        {/* Footer */}
        <div className="text-center text-sm text-gray-500 mt-8">
          <p>Powered by GoatX402 SDK</p>
        </div>
      </div>
    </div>
  )
}

export default App
