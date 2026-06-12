/**
 * GoatX402 Pay Demo Application
 */

import { useState, useCallback } from 'react'
import { useWallet } from './hooks/useWallet'
import { useGoatX402 } from './hooks/useGoatX402'
import { useConfig } from './hooks/useConfig'
import { useMPP } from './hooks/useMPP'
import { ConnectWallet } from './components/ConnectWallet'
import { PaymentForm } from './components/PaymentForm'
import { PaymentStatus } from './components/PaymentStatus'
import { MPPPanel } from './components/MPPPanel'

type Tab = 'classic' | 'mpp'

function App() {
  const wallet = useWallet()
  const goatx402 = useGoatX402(wallet.signer)
  const { merchantConfig, loading: configLoading, error: configError } = useConfig()
  const mpp = useMPP(wallet.signer)
  const [activeTab, setActiveTab] = useState<Tab>('classic')

  const [balance, setBalance] = useState<string | null>(null)

  // Handle token change to fetch balance
  const handleTokenChange = useCallback(
    async (_chainId: number, tokenContract: string) => {
      if (wallet.isConnected) {
        const bal = await goatx402.getBalance(tokenContract)
        setBalance(bal)
      }
    },
    [wallet.isConnected, goatx402]
  )

  // Handle payment
  const handlePay = useCallback(
    async (chainId: number, tokenContract: string, tokenSymbol: string, amount: string, callbackCalldata?: string) => {
      await goatx402.pay({ chainId, tokenContract, tokenSymbol, amount, callbackCalldata })
    },
    [goatx402]
  )

  return (
    <div className="min-h-screen bg-gray-100 py-8">
      <div className="max-w-md mx-auto px-4 space-y-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800">GoatX402 Pay</h1>
          <p className="text-gray-600 mt-2">Demo Payment Application</p>
          {merchantConfig && (
            <p className="text-sm text-gray-500 mt-1">
              Merchant: {merchantConfig.merchantName}
            </p>
          )}
        </div>

        {/* Config Error */}
        {configError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-600 text-sm">
              Failed to load config: {configError}
            </p>
          </div>
        )}

        {/* Config Loading */}
        {configLoading && (
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <p className="text-gray-500">Loading merchant configuration...</p>
          </div>
        )}

        {/* Wallet Connection */}
        <ConnectWallet
          isConnected={wallet.isConnected}
          address={wallet.address}
          chainId={wallet.chainId}
          loading={wallet.loading}
          error={wallet.error}
          onConnect={wallet.connect}
          onDisconnect={wallet.disconnect}
        />

        {/* Mode tabs — Classic vs MPP. Sticky-default to Classic since
            the demo's classic flow is the default deployment shape. */}
        <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
          <button
            onClick={() => setActiveTab('classic')}
            className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
              activeTab === 'classic'
                ? 'bg-blue-100 text-blue-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Classic
          </button>
          <button
            onClick={() => setActiveTab('mpp')}
            className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
              activeTab === 'mpp'
                ? 'bg-purple-100 text-purple-700 font-medium'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            MPP
          </button>
        </div>

        {activeTab === 'classic' && (
          <>
            {/* Payment Form */}
            {!configLoading && !configError && (
              <PaymentForm
                chains={merchantConfig?.chains || []}
                currentChainId={wallet.chainId}
                isConnected={wallet.isConnected}
                loading={goatx402.loading}
                balance={balance}
                onPay={handlePay}
                onTokenChange={handleTokenChange}
              />
            )}

            {/* Payment Status */}
            <PaymentStatus
              order={goatx402.order}
              result={goatx402.paymentResult}
              status={goatx402.orderStatus}
              error={goatx402.error}
              onReset={goatx402.reset}
            />
          </>
        )}

        {activeTab === 'mpp' && (
          <MPPPanel
            config={mpp.config}
            configError={mpp.configError}
            configLoading={mpp.configLoading}
            ready={mpp.ready}
            walletConnected={wallet.isConnected}
            phase={mpp.phase}
            result={mpp.result}
            protectedResponse={mpp.protectedResponse}
            error={mpp.error}
            selectedRouteOptionId={mpp.selectedRouteOptionId}
            onRouteOptionChange={mpp.setSelectedRouteOptionId}
            running={mpp.running}
            onTry={mpp.tryMPP}
            canRetryVerify={mpp.canRetryVerify}
            onRetryVerify={mpp.retryVerify}
            canRetryFetch={mpp.canRetryFetch}
            onRetryFetch={mpp.retryFetch}
            onReset={mpp.reset}
          />
        )}

        {/* Footer */}
        <div className="text-center text-sm text-gray-500 mt-8">
          <p>Powered by GoatX402 SDK</p>
          <p className="mt-1">
            Chain: {wallet.chainId ? `${wallet.chainId}` : 'Not connected'}
          </p>
        </div>
      </div>
    </div>
  )
}

export default App
