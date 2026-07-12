/**
 * Payment Form Component
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import type { ChainInfo, TokenInfo } from '../hooks/useConfig'
import { encodeDemoCallbackCalldata } from '../hooks/useGoatX402'

interface PaymentFormProps {
  chains: ChainInfo[]
  currentChainId: number | null
  isConnected: boolean
  connectedWalletAddress: string | null
  receiveType?: string
  loading: boolean
  balance: string | null
  onPay: (chainId: number, tokenContract: string, tokenSymbol: string, amount: string, callbackCalldata?: string) => void
  onTokenChange: (chainId: number, tokenContract: string) => void
}

export function PaymentForm({
  chains,
  currentChainId,
  isConnected,
  connectedWalletAddress,
  receiveType,
  loading,
  balance,
  onPay,
  onTokenChange,
}: PaymentFormProps) {
  const [selectedChainId, setSelectedChainId] = useState<number | null>(null)
  const [selectedToken, setSelectedToken] = useState<TokenInfo | null>(null)
  const [amount, setAmount] = useState('')
  const [callbackCalldata, setCallbackCalldata] = useState('')
  const [showCalldata, setShowCalldata] = useState(false)
  const lastAutoCalldataRef = useRef<string | null>(null)

  // Set default chain when chains are loaded
  useEffect(() => {
    if (chains.length > 0 && selectedChainId === null) {
      setSelectedChainId(chains[0].chainId)
    }
  }, [chains, selectedChainId])

  // Set default token when chain changes
  useEffect(() => {
    if (selectedChainId !== null) {
      const chain = chains.find((c) => c.chainId === selectedChainId)
      if (chain && chain.tokens.length > 0) {
        setSelectedToken(chain.tokens[0])
      } else {
        setSelectedToken(null)
      }
    }
  }, [selectedChainId, chains])

  // Notify parent when token changes
  useEffect(() => {
    if (isConnected && selectedChainId !== null && selectedToken) {
      onTokenChange(selectedChainId, selectedToken.contract)
    }
  }, [selectedChainId, selectedToken, isConnected, onTokenChange])

  const demoCallbackCalldata = useMemo(() => {
    if (receiveType !== 'DELEGATE' || !isConnected || !connectedWalletAddress) {
      return ''
    }
    return encodeDemoCallbackCalldata(connectedWalletAddress)
  }, [connectedWalletAddress, isConnected, receiveType])

  useEffect(() => {
    if (!demoCallbackCalldata) {
      return
    }

    const hasManualCalldata =
      callbackCalldata.trim() !== '' && callbackCalldata !== lastAutoCalldataRef.current
    if (hasManualCalldata) {
      return
    }

    lastAutoCalldataRef.current = demoCallbackCalldata
    if (callbackCalldata !== demoCallbackCalldata) {
      setCallbackCalldata(demoCallbackCalldata)
    }
  }, [callbackCalldata, demoCallbackCalldata])

  const selectedChain = chains.find((c) => c.chainId === selectedChainId)
  const isWrongChain = currentChainId !== null && currentChainId !== selectedChainId

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || parseFloat(amount) <= 0 || !selectedChainId || !selectedToken) return
    const calldata =
      receiveType === 'DELEGATE'
        ? callbackCalldata.trim() || demoCallbackCalldata || undefined
        : callbackCalldata.trim() || undefined
    onPay(selectedChainId, selectedToken.contract, selectedToken.symbol, amount, calldata)
  }

  const handleChainChange = (chainId: number) => {
    setSelectedChainId(chainId)
  }

  const handleTokenChange = (contract: string) => {
    const token = selectedChain?.tokens.find((t) => t.contract === contract)
    if (token) {
      setSelectedToken(token)
    }
  }

  // Shorten address for display
  const shortenAddress = (addr: string) => {
    if (!addr || addr.length < 20) return addr
    return `${addr.slice(0, 10)}...${addr.slice(-8)}`
  }

  if (chains.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Payment</h2>
        <p className="text-gray-500">Loading supported tokens...</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">Payment</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Chain Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Network</label>
          <select
            value={selectedChainId ?? ''}
            onChange={(e) => handleChainChange(Number(e.target.value))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          >
            {chains.map((chain) => (
              <option key={chain.chainId} value={chain.chainId}>
                {chain.name} ({chain.chainId})
              </option>
            ))}
          </select>
          {isWrongChain && (
            <p className="mt-1 text-sm text-orange-600">
              Please switch your wallet to {selectedChain?.name || `chain ${selectedChainId}`}
            </p>
          )}
        </div>

        {/* Token Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Select Token</label>
          {selectedChain && selectedChain.tokens.length > 0 ? (
            <>
              <div className="flex gap-2">
                {selectedChain.tokens.map((token) => (
                  <button
                    key={token.contract}
                    type="button"
                    onClick={() => handleTokenChange(token.contract)}
                    className={`flex-1 py-3 px-4 rounded-lg border-2 transition ${
                      selectedToken?.contract === token.contract
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-semibold">{token.symbol}</div>
                  </button>
                ))}
              </div>

              {/* Token Contract Address */}
              {selectedToken && (
                <div className="mt-2 p-2 bg-gray-50 rounded text-xs">
                  <span className="text-gray-500">Contract: </span>
                  <span className="font-mono text-gray-700">{shortenAddress(selectedToken.contract)}</span>
                </div>
              )}

              {/* Balance */}
              {balance !== null && (
                <p className="mt-2 text-sm text-gray-600">
                  Balance: <span className="font-mono font-semibold">{balance}</span>{' '}
                  {selectedToken?.symbol}
                </p>
              )}
            </>
          ) : (
            <p className="text-gray-500 text-sm">No tokens available for this chain</p>
          )}
        </div>

        {/* Amount Input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Amount</label>
          <div className="relative">
            <input
              type="number"
              step="0.000001"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-16"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
              {selectedToken?.symbol || ''}
            </span>
          </div>
        </div>

        {/* Quick Amount Buttons */}
        <div className="flex gap-2">
          {['1', '5', '10', '50'].map((val) => (
            <button
              key={val}
              type="button"
              onClick={() => setAmount(val)}
              className="flex-1 py-2 px-3 bg-gray-100 hover:bg-gray-200 rounded text-sm transition"
            >
              {val} {selectedToken?.symbol || ''}
            </button>
          ))}
        </div>

        {/* Callback Calldata (Advanced) */}
        <div>
          <button
            type="button"
            onClick={() => setShowCalldata(!showCalldata)}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            {showCalldata ? '▼ Hide' : '▶ Show'} Advanced Options (Calldata)
          </button>
          {showCalldata && (
            <div className="mt-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Callback Calldata (hex)
              </label>
              <textarea
                value={callbackCalldata}
                onChange={(e) => setCallbackCalldata(e.target.value)}
                placeholder="0x... (optional, for DELEGATE merchants)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                rows={3}
              />
              <p className="mt-1 text-xs text-gray-500">
                Sent with the order; DELEGATE merchants may return a callback signature request.
              </p>
            </div>
          )}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={
            !isConnected ||
            loading ||
            !amount ||
            parseFloat(amount) <= 0 ||
            isWrongChain ||
            !selectedToken
          }
          className="w-full py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Processing...
            </span>
          ) : (
            `Pay ${amount || '0'} ${selectedToken?.symbol || ''}`
          )}
        </button>

        {!isConnected && (
          <p className="text-center text-sm text-gray-500">Connect your wallet to make a payment</p>
        )}
      </form>
    </div>
  )
}
