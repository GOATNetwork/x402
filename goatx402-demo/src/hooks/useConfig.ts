/**
 * Config Hook - Fetch supported chains and tokens from merchant API
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { config } from '../config'

export interface TokenInfo {
  symbol: string
  contract: string
}

export interface ChainInfo {
  chainId: number
  name: string
  tokens: TokenInfo[]
}

export interface MerchantConfig {
  merchantId: string
  merchantName: string
  receiveType: string
  chains: ChainInfo[]
}

export function useConfig() {
  const [merchantConfig, setMerchantConfig] = useState<MerchantConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchedRef = useRef(false)

  // Fetch config on mount (only once)
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true

    const fetchConfig = async () => {
      try {
        setLoading(true)
        setError(null)

        const response = await fetch(`${config.apiUrl}/config`)
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${response.status}`)
        }

        const data = await response.json()
        setMerchantConfig(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load config')
      } finally {
        setLoading(false)
      }
    }

    fetchConfig()
  }, [])

  // Helper to get token contract by chain and symbol
  const getTokenContract = useCallback(
    (chainId: number, symbol: string): string | null => {
      if (!merchantConfig) return null
      const chain = merchantConfig.chains.find((c) => c.chainId === chainId)
      if (!chain) return null
      const token = chain.tokens.find((t) => t.symbol === symbol)
      return token?.contract || null
    },
    [merchantConfig]
  )

  // Helper to get chain info
  const getChain = useCallback(
    (chainId: number): ChainInfo | null => {
      if (!merchantConfig) return null
      return merchantConfig.chains.find((c) => c.chainId === chainId) || null
    },
    [merchantConfig]
  )

  return {
    merchantConfig,
    loading,
    error,
    getTokenContract,
    getChain,
  }
}
