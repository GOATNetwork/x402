import { ethers } from 'ethers'
import type { MppBackend } from './pay.js'
import type { RpcResolver } from './backend-ethers.js'

/**
 * SdkMppBackend runs the MPP challenge→pay→verify flow by delegating to
 * goatx402-sdk's MPPClient (the canonical, already-tested MPP buyer client).
 * goatx402-sdk is an OPTIONAL dependency loaded at runtime — pay-mpp only works
 * when it is installed alongside this CLI.
 *
 * The coreUrl passed to MPPClient is the TRUSTED origin from the QuickPay link;
 * MPPClient appends /mpp/v1/challenge and /mpp/v1/verify, keeping every request
 * same-origin with the manifest.
 *
 * NOTE: the live MPP flow cannot be exercised in unit tests; pay.ts's payMpp
 * orchestration is tested against a mock MppBackend instead.
 */
export class SdkMppBackend implements MppBackend {
  private readonly privateKey: string
  private readonly rpcForChain: RpcResolver

  constructor(privateKey: string, rpcForChain: RpcResolver) {
    this.privateKey = privateKey
    this.rpcForChain = rpcForChain
  }

  async pay(p: { coreUrl: string; merchantId: string; routeCanonical: string; chainId: number }): Promise<{
    txHash: string
    receiptHeader?: string
    receipt?: unknown
  }> {
    // Variable specifier so the optional dependency is not a hard build/import
    // requirement; if absent at runtime, surface a clear message.
    const specifier = 'goatx402-sdk'
    let sdk: any
    try {
      sdk = await import(specifier)
    } catch {
      throw new Error('pay-mpp requires the optional dependency "goatx402-sdk" to be installed alongside goatx402-quickpay')
    }
    const rpc = this.rpcForChain(p.chainId)
    if (!rpc) throw new Error(`no RPC URL configured for chain ${p.chainId}`)
    const provider = new ethers.JsonRpcProvider(rpc)
    // The RPC URL is operator-supplied — verify it actually serves the expected
    // chain before the signer is used, so a misconfigured/compromised RPC cannot
    // route the MPP payment to the wrong network. Mirrors EthersPaymentBackend
    // (pay-x402, backend-ethers.ts) and the web app's freshSignerForChain.
    const network = await provider.getNetwork()
    if (network.chainId !== BigInt(p.chainId)) {
      throw new Error(`RPC for chain ${p.chainId} reports chainId ${network.chainId.toString()}`)
    }
    const signer = new ethers.Wallet(this.privateKey, provider)

    // Harden the MPP rail's transport the same way the x402 path is hardened: the
    // origin is the trust anchor, so the SDK's challenge/verify fetches must NOT
    // follow an off-origin redirect (which could swap the challenge recipient and
    // redirect funds). Force redirect:'error' and assert the final response stays
    // same-origin.
    const trustedOrigin = new URL(p.coreUrl).origin
    const hardenedFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as Parameters<typeof fetch>[0], { ...(init as RequestInit), redirect: 'error' })
      if (res.url && new URL(res.url).origin !== trustedOrigin) {
        throw new Error(`MPP request redirected off-origin to ${res.url}`)
      }
      return res
    }

    const client = new sdk.MPPClient({ coreUrl: p.coreUrl, signer, fetchImpl: hardenedFetch })
    const res = await client.pay({ merchantId: p.merchantId, routeCanonical: p.routeCanonical })
    return {
      txHash: res.txHash ?? res.tx_hash,
      receiptHeader: res.receiptHeader ?? res.receipt_header,
      receipt: res.receiptBody ?? res.receipt,
    }
  }
}
