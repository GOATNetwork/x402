import { ethers } from 'ethers'
import type { PaymentBackend } from './pay.js'

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]

export type RpcResolver = (chainId: number) => string

/**
 * EthersPaymentBackend executes the on-chain ERC20 transfer for pay-x402. It
 * mirrors goatflow-sdk's PaymentHelper.transfer (transfer tokens to payTo). The
 * RPC URL for each chain is resolved via the provided resolver (flag / env).
 *
 * NOTE: the live on-chain transfer cannot be exercised in unit tests; the
 * orchestration in pay.ts is tested against a mock PaymentBackend instead.
 */
export class EthersPaymentBackend implements PaymentBackend {
  private readonly privateKey: string
  private readonly rpcForChain: RpcResolver

  constructor(privateKey: string, rpcForChain: RpcResolver) {
    this.privateKey = privateKey
    this.rpcForChain = rpcForChain
  }

  async getAddress(): Promise<string> {
    return new ethers.Wallet(this.privateKey).address
  }

  async transferErc20(p: { chainId: number; tokenContract: string; to: string; amountWei: string }): Promise<string> {
    const rpc = this.rpcForChain(p.chainId)
    if (!rpc) throw new Error(`no RPC URL configured for chain ${p.chainId}`)
    const provider = new ethers.JsonRpcProvider(rpc)
    // The RPC URL is operator-supplied — verify it actually serves the expected
    // chain before broadcasting, so a misconfigured RPC cannot send the transfer
    // to the wrong network.
    const network = await provider.getNetwork()
    if (network.chainId !== BigInt(p.chainId)) {
      throw new Error(`RPC for chain ${p.chainId} reports chainId ${network.chainId.toString()}`)
    }
    const wallet = new ethers.Wallet(this.privateKey, provider)
    const token = new ethers.Contract(p.tokenContract, ERC20_ABI, wallet)

    const owner = await wallet.getAddress()
    const balance: bigint = await token.balanceOf(owner)
    const amount = BigInt(p.amountWei)
    if (balance < amount) {
      throw new Error(`insufficient token balance: have ${balance.toString()}, need ${amount.toString()}`)
    }
    const tx: ethers.TransactionResponse = await token.transfer(p.to, amount)
    // The tx is broadcast and its hash is known HERE — return it IMMEDIATELY, without
    // blocking on tx.wait(). A stuck or slow RPC must never strand pay-x402 in an
    // unbounded local wait: payX402 would never reach session polling and never
    // surface the session_id/tx_hash, so the payer would lose the recovery handle and
    // could be pushed into a blind retry (double-pay). Confirmation — and the
    // authoritative, replacement-aware hash — come from session polling instead: the
    // watcher only confirms a SETTLED transfer and the session status returns its
    // tx_hash, so a fee-bump/replacement or a revert is reflected by the server rather
    // than guessed locally (a revert simply never confirms). ethers v6 populates
    // hash on a successful broadcast; guard defensively rather than return an empty.
    if (!tx.hash) {
      throw new Error('transfer broadcast returned no tx hash')
    }
    return tx.hash
  }
}
