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

      while (Date.now() - startTime < timeout) {
        try {
          const status = await getOrderStatus(orderId)
          setOrderStatus(status)

          if (
            status.status === 'PAYMENT_CONFIRMED' ||
            status.status === 'PAYMENT_FAILED' ||
            status.status === 'EXPIRED'
          ) {
            return status
          }
        } catch {
          // Retry on error
        }

        await new Promise((resolve) => setTimeout(resolve, 3000))
      }

      throw new Error('Timeout waiting for confirmation')
    },
    [getOrderStatus]
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
        const amountWei = ethers.parseUnits(params.amount, decimals).toString()

        // Create order via backend
        const orderResponse = await createOrder({
          chainId: params.chainId,
          tokenSymbol: params.tokenSymbol,
          tokenContract: params.tokenContract,
          fromAddress,
          amountWei,
          callbackCalldata: params.callbackCalldata,
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
        if (newOrder.calldataSignRequest) {
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
        setPaymentResult(result)

        if (result.success) {
          await pollForConfirmation(newOrder.orderId)
        }

        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Payment failed'
        setError(message)
        return { success: false, error: message }
      } finally {
        setLoading(false)
      }
    },
    [paymentHelper, signer, createOrder, submitSignature, pollForConfirmation]
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
  }, [])

  return {
    loading,
    error,
    order,
    paymentResult,
    orderStatus,
    pay,
    getBalance,
    reset,
  }
}
