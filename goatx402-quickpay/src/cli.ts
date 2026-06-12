#!/usr/bin/env node
import { inspect } from './inspect.js'
import { payX402, payMpp } from './pay.js'
import { EthersPaymentBackend, type RpcResolver } from './backend-ethers.js'
import { SdkMppBackend } from './backend-mpp-sdk.js'
import { mppRecovery } from './mpp-error.js'

type Flags = Record<string, string | boolean>

function parseArgs(argv: string[]): { command?: string; positional: string[]; flags: Flags } {
  const flags: Flags = {}
  const positional: string[] = []
  let command: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else if (command === undefined) {
      command = a
    } else {
      positional.push(a)
    }
  }
  return { command, positional, flags }
}

function fail(msg: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n')
  process.exit(1)
}

function rpcResolver(flags: Flags): RpcResolver {
  return (chainId: number) => {
    const perChain = process.env[`QUICKPAY_RPC_${chainId}`]
    if (perChain) return perChain
    if (typeof flags.rpc === 'string') return flags.rpc
    return process.env.QUICKPAY_RPC ?? ''
  }
}

function privateKey(flags: Flags): string {
  const raw = (typeof flags.wallet === 'string' ? flags.wallet : '') || process.env.QUICKPAY_PRIVATE_KEY || ''
  if (!raw) fail('a wallet private key is required (--wallet <key> or QUICKPAY_PRIVATE_KEY)')
  // Validate ourselves so a malformed key is never echoed back through an ethers
  // error message (which would leak the secret to stdout/logs).
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    fail('invalid private key (expected a 32-byte hex string)')
  }
  return raw.startsWith('0x') ? raw : '0x' + raw
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  const url = positional[0]

  if (command === 'inspect') {
    if (!url) fail('usage: goatx402-quickpay inspect <agent_md_or_manifest_url>')
    const out = await inspect(url)
    process.stdout.write(JSON.stringify(out, null, flags.json ? 0 : 2) + '\n')
    return
  }

  if (command === 'pay-x402') {
    if (!url) {
      fail('usage: goatx402-quickpay pay-x402 <url> --amount <a> --token-contract <address> --chain <id> --wallet <key>')
    }
    const amount = typeof flags.amount === 'string' ? flags.amount : ''
    const token = typeof flags.token === 'string' ? flags.token : ''
    const tokenContract = typeof flags['token-contract'] === 'string' ? flags['token-contract'] : ''
    // typeof check first: a valueless `--chain` is stored as `true`, and
    // Number(true) === 1 would silently target chain 1.
    const chain = typeof flags.chain === 'string' ? Number(flags.chain) : NaN
    if (!amount || (!token && !tokenContract) || !Number.isSafeInteger(chain) || chain <= 0) {
      fail('pay-x402 requires --amount, --token or --token-contract, and a positive integer --chain')
    }
    const backend = new EthersPaymentBackend(privateKey(flags), rpcResolver(flags))
    const out = await payX402({
      input: url,
      amount,
      tokenSymbol: token || undefined,
      tokenContract: tokenContract || undefined,
      chainId: chain,
      backend,
      memo: typeof flags.memo === 'string' ? flags.memo : undefined,
      idempotencyKey: typeof flags.idempotency === 'string' ? flags.idempotency : undefined,
      // --force broadcasts even for a REUSED session. Default off so an auto-retry
      // cannot double-pay a session that may already have an in-flight transfer.
      force: flags.force === true,
    })
    process.stdout.write(JSON.stringify(out) + '\n')
    process.exit(out.ok ? 0 : 2)
  }

  if (command === 'pay-mpp') {
    if (!url) fail('usage: goatx402-quickpay pay-mpp <url> --route <route> --wallet <key>')
    const route = typeof flags.route === 'string' ? flags.route : ''
    if (!route) fail('pay-mpp requires --route')
    const backend = new SdkMppBackend(privateKey(flags), rpcResolver(flags))
    try {
      const out = await payMpp({ input: url, route, backend })
      process.stdout.write(JSON.stringify(out) + '\n')
      return
    } catch (err) {
      // If MPPClient.pay() already broadcast the on-chain transfer but verify
      // polling failed, the SDK attaches recovery data (challenge + tx hash).
      // Surface it so the caller can RESUME verification instead of paying again;
      // flattening to err.message (the default catch) would lose it and a retry
      // would double-pay.
      const rec = mppRecovery(err)
      if (rec) {
        process.stderr.write(JSON.stringify(rec) + '\n')
        process.exit(2)
      }
      throw err
    }
  }

  fail(`unknown command "${command ?? ''}". Commands: inspect, pay-x402, pay-mpp`)
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
