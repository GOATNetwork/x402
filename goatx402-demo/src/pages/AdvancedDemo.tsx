/**
 * Advanced demo — "build your own order".
 *
 * This is the original self-built integration: the app connects the wallet itself
 * and uses goatflow-sdk's PaymentHelper + a backend that creates orders via the
 * HMAC server SDK. It keeps BOTH the Classic and MPP sub-tabs unchanged. Use this
 * as the reference when you need to construct orders / drive the wallet yourself.
 * For drop-in collection, prefer the Checkout SDK tab.
 */
import { useState, useCallback } from 'react'
import { useWallet } from '../hooks/useWallet'
import { useGoatFlow } from '../hooks/useGoatFlow'
import { useConfig } from '../hooks/useConfig'
import { useMPP } from '../hooks/useMPP'
import { ConnectWallet } from '../components/ConnectWallet'
import { PaymentForm } from '../components/PaymentForm'
import { PaymentStatus } from '../components/PaymentStatus'
import { MPPPanel } from '../components/MPPPanel'

type Tab = 'classic' | 'mpp'

export function AdvancedDemo() {
  const wallet = useWallet()
  const goatx402 = useGoatFlow(wallet.signer)
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
    <div className="space-y-4">
      {/* Config Error */}
      {configError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-600 text-sm">Failed to load config: {configError}</p>
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

      {/* Mode tabs — Classic vs MPP. */}
      <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
        <button
          onClick={() => setActiveTab('classic')}
          className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
            activeTab === 'classic' ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          Classic
        </button>
        <button
          onClick={() => setActiveTab('mpp')}
          className={`flex-1 px-3 py-2 text-sm rounded-md transition ${
            activeTab === 'mpp' ? 'bg-purple-100 text-purple-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
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
              connectedWalletAddress={wallet.address}
              receiveType={merchantConfig?.receiveType}
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
            tokenDecimals={goatx402.tokenDecimals}
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
    </div>
  )
}
