/**
 * GoatX402 Hook - Frontend payment integration
 *
 * This hook communicates with the backend API for order creation
 * and uses the frontend SDK for wallet interactions.
 *
 * The Window.ethereum global declaration lives in useWallet.ts (the
 * canonical, broader shape that includes isMetaMask + on/removeListener).
 * A narrower duplicate here used to collide on TS 5.3+ with a TS2717
 * "must have the same type" error; the import below pulls useWallet.ts
 * into the same program so its augmentation is in scope.
 */

import { useState, useCallback, useMemo } from 'react'
import { ethers } from 'ethers'
import { PaymentHelper, formatUnits } from 'goatx402-sdk'
import type { Order, PaymentResult } from 'goatx402-sdk'
import { config } from '../config'

// Order response from backend
interface OrderResponse {
  orderId: string
  flow: Order['flow']
  payToAddress: string
  expiresAt: number
  calldataSignRequest?: Order['calldataSignRequest']
  chainId: number
  tokenSymbol: string
  tokenContract: string
  fromAddress: string
  amountWei: string
}

// Order proof from backend
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

export interface PaymentParams {
  chainId: number
  tokenContract: string
  tokenSymbol: string
  amount: string // Human readable amount (e.g., "10.5")
  callbackCalldata?: string // Optional hex calldata for DELEGATE merchants (e.g., "0x1234...")
}

const demoCallbackInterface = new ethers.Interface([
  'function testCallback(address payer, uint256 value, string message)',
])

const delegateFlows: readonly Order['flow'][] = ['ERC20_3009', 'ERC20_APPROVE_XFER']

export function encodeDemoCallbackCalldata(payerAddress: string): string {
  return demoCallbackInterface.encodeFunctionData('testCallback', [
    payerAddress,
    12345n,
    'Demo callback',
  ])
}

function isDelegateFlow(flow: Order['flow']): boolean {
  return delegateFlows.includes(flow)
}

function isSuccessfulOrderStatus(status: string): boolean {
  return status === 'PAYMENT_CONFIRMED' || status === 'INVOICED'
}

function isFailedTerminalOrderStatus(status: string): boolean {
  return status === 'FAILED' || status === 'PAYMENT_FAILED' || status === 'EXPIRED' || status === 'CANCELLED'
}

function orderStatusFailureMessage(status: string): string {
  return status === 'EXPIRED' || status === 'CANCELLED'
    ? `Order ${status.toLowerCase()}`
    : 'Transaction failed'
}

// Definitively pre-broadcast PaymentHelper.pay() failures: no tx was ever sent,
// so the backend order stays CHECKOUT_VERIFIED and reconciliation can only stall
// the spinner without ever flipping the result. ethers v6 user rejection surfaces
// as ACTION_REJECTED / "user rejected action"; EIP-1193 wallets use code 4001 /
// "User denied ..."; transfer() throws "Insufficient balance: ..." before sending.
// (PaymentHelper.pay() collapses the error to its message, so match on that.)
function isPreBroadcastFailure(error?: string): boolean {
  if (!error) return false
  return /reject|denied|ACTION_REJECTED|4001|Insufficient balance/i.test(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Helper to switch chain via MetaMask
async function switchChain(chainId: number): Promise<void> {
  if (!window.ethereum) {
    throw new Error('MetaMask is not installed')
  }
  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${chainId.toString(16)}` }],
  })
  // Wait a bit for the provider to update
  await new Promise(resolve => setTimeout(resolve, 500))
}

// Helper to get fresh signer from MetaMask
async function getFreshSigner(): Promise<ethers.Signer> {
  if (!window.ethereum) {
    throw new Error('MetaMask is not installed')
  }
  const provider = new ethers.BrowserProvider(window.ethereum)
  return provider.getSigner()
}

export function useGoatX402(signer: ethers.Signer | null) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null)
  const [orderStatus, setOrderStatus] = useState<OrderProof | null>(null)
  const [tokenDecimals, setTokenDecimals] = useState<number>(18)

  // Create payment helper
  const paymentHelper = useMemo(() => {
    if (!signer) return null
    return new PaymentHelper(signer)
  }, [signer])

  // Create order via backend API
  const createOrder = useCallback(
    async (params: {
      chainId: number
      tokenSymbol: string
      tokenContract: string
      fromAddress: string
      amountWei: string
      callbackCalldata?: string
    }): Promise<OrderResponse> => {
      const response = await fetch(`${config.apiUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || `HTTP ${response.status}`)
      }

      return response.json()
    },
    []
  )

  // Get order status from backend
  const getOrderStatus = useCallback(async (orderId: string): Promise<OrderProof> => {
    const response = await fetch(`${config.apiUrl}/orders/${orderId}`)

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
  }, [])

  const getOrderStatusWithRetry = useCallback(
    async (
      orderId: string,
      options: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number } = {}
    ): Promise<OrderProof> => {
      const attempts = options.attempts ?? 4
      const initialDelayMs = options.initialDelayMs ?? 750
      const maxDelayMs = options.maxDelayMs ?? 5000
      let lastError: unknown

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await getOrderStatus(orderId)
        } catch (err) {
          lastError = err
          if (attempt < attempts) {
            const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1))
            await sleep(delayMs)
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Failed to fetch order status')
    },
    [getOrderStatus]
  )

  // Submit calldata signature via backend
  const submitSignature = useCallback(async (orderId: string, signature: string): Promise<void> => {
    const response = await fetch(`${config.apiUrl}/orders/${orderId}/signature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || `HTTP ${response.status}`)
    }
  }, [])

  // Poll for order confirmation
  const pollForConfirmation = useCallback(
    async (orderId: string) => {
      const startTime = Date.now()
      const timeout = 2 * 60 * 1000 // 2 minutes
      let lastError: unknown

      while (Date.now() - startTime < timeout) {
        try {
          const status = await getOrderStatusWithRetry(orderId, {
            attempts: 3,
            initialDelayMs: 750,
            maxDelayMs: 4000,
          })
          setOrderStatus(status)

          // Terminal states (success or failure). isSuccessfulOrderStatus covers
          // INVOICED — the durable success state DIRECT orders advance to (the watcher
          // takes PAYMENT_CONFIRMED → INVOICED in one tx, so a poll can land on INVOICED
          // directly); without it a confirmed payment would time out as a false failure.
          if (isSuccessfulOrderStatus(status.status) || isFailedTerminalOrderStatus(status.status)) {
            return status
          }
        } catch (err) {
          lastError = err
        }

        await sleep(3000)
      }

      if (lastError instanceof Error) {
        throw new Error(`Timeout waiting for confirmation; last status check failed: ${lastError.message}`)
      }
      throw new Error('Timeout waiting for confirmation')
    },
    [getOrderStatusWithRetry]
  )

  const pollForFailureReconciliation = useCallback(
    async (orderId: string): Promise<OrderProof | null> => {
      const delays = [750, 1250, 2000, 3000, 5000]
      let latestStatus: OrderProof | null = null

      for (let attempt = 0; attempt < delays.length; attempt += 1) {
        try {
          latestStatus = await getOrderStatusWithRetry(orderId, {
            attempts: 2,
            initialDelayMs: 600,
            maxDelayMs: 2500,
          })
          setOrderStatus(latestStatus)

          // Stop only on a genuinely terminal outcome. Intermediate states like
          // PAYMENT_DETECTING / PAYMENT_CONFIRMING mean the transfer was seen but
          // is not yet confirmed and can still fail, so keep polling through them
          // (bounded by the retry budget) instead of treating movement as done.
          if (
            isSuccessfulOrderStatus(latestStatus.status) ||
            isFailedTerminalOrderStatus(latestStatus.status)
          ) {
            return latestStatus
          }
        } catch {
          // Keep retrying transient status API failures before declaring the payment failed.
        }

        if (attempt < delays.length - 1) {
          await sleep(delays[attempt])
        }
      }

      return latestStatus
    },
    [getOrderStatusWithRetry]
  )

  const reconcilePaymentResult = useCallback(
    async (orderId: string, result: PaymentResult): Promise<PaymentResult> => {
      const status = await pollForFailureReconciliation(orderId)
      if (!status) return result

      if (isSuccessfulOrderStatus(status.status)) {
        return {
          success: true,
          txHash: result.txHash ?? status.txHash,
        }
      }

      if (isFailedTerminalOrderStatus(status.status)) {
        return {
          success: false,
          txHash: result.txHash ?? status.txHash,
          error: orderStatusFailureMessage(status.status),
        }
      }

      // Reconciliation did not reach a confirmed-success or failed-terminal
      // status within the retry budget (still CHECKOUT_VERIFIED, PAYMENT_DETECTING,
      // or PAYMENT_CONFIRMING). An unconfirmed transfer can still fail, so do NOT
      // fabricate success — return the SDK's own result unchanged. Preserve any
      // hash the server has surfaced so a later check can resume from it.
      return { ...result, txHash: result.txHash ?? status.txHash }
    },
    [pollForFailureReconciliation]
  )

  // Create order and execute payment
  const pay = useCallback(
    async (params: PaymentParams) => {
      if (!paymentHelper || !signer) {
        setError('Wallet not connected')
        return null
      }

      setLoading(true)
      setError(null)
      setPaymentResult(null)
      setOrderStatus(null)

      try {
        const fromAddress = await signer.getAddress()

        if (!params.tokenContract || params.tokenContract === '0x0000000000000000000000000000000000000000') {
          throw new Error(`Invalid token contract for ${params.tokenSymbol}`)
        }

        // Fetch decimals from token contract
        const tokenContract = new ethers.Contract(
          params.tokenContract,
          ['function decimals() view returns (uint8)'],
          signer
        )
        const decimals = await tokenContract.decimals()
        const tokenDecimals = Number(decimals)
        setTokenDecimals(tokenDecimals)
        const amountWei = ethers.parseUnits(params.amount, tokenDecimals).toString()
        const callbackCalldata = params.callbackCalldata?.trim() || undefined

        // Create order via backend
        const orderResponse = await createOrder({
          chainId: params.chainId,
          tokenSymbol: params.tokenSymbol,
          tokenContract: params.tokenContract,
          fromAddress,
          amountWei,
          callbackCalldata,
        })

        // Convert to Order format for PaymentHelper
        const newOrder: Order = {
          orderId: orderResponse.orderId,
          flow: orderResponse.flow,
          tokenSymbol: orderResponse.tokenSymbol,
          tokenContract: orderResponse.tokenContract,
          fromAddress: orderResponse.fromAddress,
          payToAddress: orderResponse.payToAddress,
          chainId: orderResponse.chainId,
          amountWei: orderResponse.amountWei,
          expiresAt: orderResponse.expiresAt,
          calldataSignRequest: orderResponse.calldataSignRequest,
        }

        setOrder(newOrder)

        // Track if we need to switch networks
        let needsNetworkSwitch = false
        const sourceChainId = newOrder.chainId

        // If order requires calldata signature, sign and submit it
        if (isDelegateFlow(newOrder.flow) && newOrder.calldataSignRequest) {
          const calldataDomainChainId = newOrder.calldataSignRequest.domain.chainId

          // For cross-chain orders, we need to switch to the target chain to sign calldata
          // because MetaMask validates that the EIP-712 domain chainId matches the active chain
          if (calldataDomainChainId !== sourceChainId) {
            needsNetworkSwitch = true

            // Switch to target chain for calldata signing
            await switchChain(calldataDomainChainId)

            // Get fresh signer for the target chain
            const targetSigner = await getFreshSigner()

            // Verify the signer address matches the order's fromAddress
            const targetSignerAddress = await targetSigner.getAddress()
            if (targetSignerAddress.toLowerCase() !== fromAddress.toLowerCase()) {
              throw new Error(
                `Account mismatch after network switch. Expected ${fromAddress}, got ${targetSignerAddress}. Please ensure you're using the same account on both networks.`
              )
            }

            const targetPaymentHelper = new PaymentHelper(targetSigner)

            // Sign calldata on target chain
            const signature = await targetPaymentHelper.signCalldata(newOrder)
            await submitSignature(newOrder.orderId, signature)

            // Switch back to source chain for payment
            await switchChain(sourceChainId)
          } else {
            // Same chain, sign directly
            const signature = await paymentHelper.signCalldata(newOrder)
            await submitSignature(newOrder.orderId, signature)
          }
        }

        // Get the payment helper to use
        // If we switched networks, we need a fresh signer
        let activePaymentHelper = paymentHelper
        if (needsNetworkSwitch) {
          const freshSigner = await getFreshSigner()

          // Verify address after switching back
          const freshSignerAddress = await freshSigner.getAddress()
          if (freshSignerAddress.toLowerCase() !== fromAddress.toLowerCase()) {
            throw new Error(
              `Account mismatch after returning to source network. Expected ${fromAddress}, got ${freshSignerAddress}.`
            )
          }

          activePaymentHelper = new PaymentHelper(freshSigner)
        }

        // Execute payment
        const result = await activePaymentHelper.pay(newOrder)

        if (result.success) {
          setPaymentResult(result)
          try {
            const status = await pollForConfirmation(newOrder.orderId)
            if (isSuccessfulOrderStatus(status.status)) {
              const successResult = {
                success: true,
                txHash: result.txHash ?? status.txHash,
              }
              setPaymentResult(successResult)
              setError(null)
              return successResult
            }
            if (isFailedTerminalOrderStatus(status.status)) {
              const failedResult = {
                success: false,
                txHash: result.txHash ?? status.txHash,
                error: orderStatusFailureMessage(status.status),
              }
              setPaymentResult(failedResult)
              setError(failedResult.error)
              return failedResult
            }
          } catch {
            const reconciledResult = await reconcilePaymentResult(newOrder.orderId, result)
            setPaymentResult(reconciledResult)

            if (!reconciledResult.success) {
              const message = reconciledResult.error || 'Payment failed'
              setError(message)
              return { ...reconciledResult, error: message }
            }

            setError(null)
            return reconciledResult
          }

          setError(null)
          return result
        }

        // Pre-broadcast failures (wallet rejection / insufficient balance) can never
        // be a false negative, so surface them immediately instead of polling for ~7s.
        // Reconcile only failures that could be post-broadcast (e.g. tx.wait() RPC errors).
        if (isPreBroadcastFailure(result.error)) {
          setPaymentResult(result)
          setError(result.error ?? 'Payment failed')
          return result
        }

        const reconciledResult = await reconcilePaymentResult(newOrder.orderId, result)
        setPaymentResult(reconciledResult)

        if (reconciledResult.success) {
          setError(null)
          return reconciledResult
        }

        const message = reconciledResult.error || result.error || 'Payment failed'
        setError(message)
        return { ...reconciledResult, error: message }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Payment failed'
        setError(message)
        return { success: false, error: message }
      } finally {
        setLoading(false)
      }
    },
    [paymentHelper, signer, createOrder, submitSignature, pollForConfirmation, reconcilePaymentResult]
  )

  // Get token balance by contract address
  const getBalance = useCallback(
    async (tokenContract: string): Promise<string | null> => {
      if (!paymentHelper || !signer) return null

      try {
        if (!tokenContract || tokenContract === '0x0000000000000000000000000000000000000000') {
          return null
        }

        // Fetch decimals from token contract
        const contract = new ethers.Contract(
          tokenContract,
          ['function decimals() view returns (uint8)'],
          signer
        )
        const decimals = await contract.decimals()

        const balance = await paymentHelper.getTokenBalance(tokenContract)
        return formatUnits(balance, decimals)
      } catch {
        return null
      }
    },
    [paymentHelper, signer]
  )

  // Reset state
  const reset = useCallback(() => {
    setOrder(null)
    setPaymentResult(null)
    setOrderStatus(null)
    setError(null)
    setTokenDecimals(18)
  }, [])

  return {
    loading,
    error,
    order,
    paymentResult,
    orderStatus,
    tokenDecimals,
    pay,
    getBalance,
    reset,
  }
}
