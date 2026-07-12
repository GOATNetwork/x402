/**
 * Payment Status Component
 */

import { formatUnits, type Order, type PaymentResult } from 'goatx402-sdk'
import { config } from '../config'

// Order proof from backend API
interface OrderProof {
  orderId: string
  merchantId: string
  dappOrderId: string
  chainId: number
  tokenContract: string
  tokenSymbol: string
  fromAddress: string
  amountWei: string
  status: string
  txHash?: string
  confirmedAt?: string
}

interface PaymentStatusProps {
  order: Order | null
  result: PaymentResult | null
  status: OrderProof | null
  tokenDecimals?: number
  error: string | null
  onReset: () => void
}

export function PaymentStatus({
  order,
  result,
  status,
  tokenDecimals = 18,
  error,
  onReset,
}: PaymentStatusProps) {
  if (!order && !result && !error && !status) {
    return null
  }

  const hasSuccessfulStatus =
    status?.status === 'PAYMENT_CONFIRMED' || status?.status === 'INVOICED'
  const visibleError = hasSuccessfulStatus ? null : error

  const getStatusColor = (s: string) => {
    switch (s) {
      case 'PAYMENT_CONFIRMED':
      case 'INVOICED':
        return 'bg-green-100 text-green-800'
      case 'PAYMENT_FAILED':
      case 'FAILED':
      case 'EXPIRED':
      case 'CANCELLED':
        return 'bg-red-100 text-red-800'
      case 'CHECKOUT_VERIFIED':
      case 'PAYMENT_DETECTING':
      case 'PAYMENT_CONFIRMING':
        return 'bg-yellow-100 text-yellow-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getExplorerUrl = (chainId: number, txHash: string) => {
    const chain = config.chains?.[chainId]
    if (chain?.explorerUrl) {
      return `${chain.explorerUrl}/tx/${txHash}`
    }
    return null
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800">Payment Status</h2>
        <button
          onClick={onReset}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          New Payment
        </button>
      </div>

      {/* Error */}
      {visibleError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <p className="text-red-700">{visibleError}</p>
        </div>
      )}

      {/* Order Info */}
      {order && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Order ID</span>
              <p className="font-mono text-xs break-all">{order.orderId}</p>
            </div>
            <div>
              <span className="text-gray-500">Flow</span>
              <p className="font-medium">{order.flow}</p>
            </div>
            <div>
              <span className="text-gray-500">Amount</span>
              <p className="font-medium">
                {Number(formatUnits(BigInt(order.amountWei), tokenDecimals)).toFixed(2)} {order.tokenSymbol}
              </p>
            </div>
            <div>
              <span className="text-gray-500">Recipient</span>
              <p className="font-mono text-xs truncate" title={order.payToAddress}>
                {order.payToAddress.slice(0, 10)}...{order.payToAddress.slice(-8)}
              </p>
            </div>
          </div>

          {/* Transaction Result */}
          {result && (
            <div className="border-t pt-3 mt-3">
              {result.success || hasSuccessfulStatus ? (
                <div className="flex items-center gap-2 text-green-700">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Transaction submitted</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-700">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span>Transaction failed</span>
                </div>
              )}

              {result.txHash && (
                <div className="mt-2">
                  <span className="text-gray-500 text-sm">Transaction Hash</span>
                  <p className="font-mono text-xs break-all">
                    {getExplorerUrl(order.chainId, result.txHash) ? (
                      <a
                        href={getExplorerUrl(order.chainId, result.txHash)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {result.txHash}
                      </a>
                    ) : (
                      result.txHash
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Order Status */}
          {status && (
            <div className="border-t pt-3 mt-3">
              <div className="flex items-center gap-2">
                <span className="text-gray-500 text-sm">Status:</span>
                <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(status.status)}`}>
                  {status.status}
                </span>
              </div>

              {status.txHash && (
                <div className="mt-2">
                  <span className="text-gray-500 text-sm">Confirmed TX</span>
                  <p className="font-mono text-xs break-all">
                    {getExplorerUrl(status.chainId, status.txHash) ? (
                      <a
                        href={getExplorerUrl(status.chainId, status.txHash)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {status.txHash}
                      </a>
                    ) : (
                      status.txHash
                    )}
                  </p>
                </div>
              )}

              {status.confirmedAt && (
                <p className="text-sm text-gray-500 mt-2">
                  Confirmed at: {new Date(status.confirmedAt).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
