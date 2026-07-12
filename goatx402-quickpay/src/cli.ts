#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { inspect } from './inspect.js'
import { payX402, payProduct, payMpp } from './pay.js'
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
  // Key-source precedence: --wallet-file > --wallet > QUICKPAY_PRIVATE_KEY.
  // A raw key passed via --wallet on the command line leaks through process
  // listings (`ps`), shell history, CI logs, and — since this is an agent-facing
  // CLI — agent transcripts. It is still accepted (back-compat) but warns;
  // prefer the env var or a permission-restricted --wallet-file.
  let raw = ''
  if (typeof flags['wallet-file'] === 'string') {
    const path = flags['wallet-file']
    try {
      // Human-only hint; gate to a TTY so it never prepends the structured JSON
      // that fail()/pay-mpp recovery write to stderr for automation to parse.
      if ((statSync(path).mode & 0o077) !== 0 && process.stderr.isTTY) {
        process.stderr.write(
          `warning: ${path} is readable by other users; restrict it with \`chmod 600\`.\n`,
        )
      }
      raw = readFileSync(path, 'utf8').trim()
    } catch {
      // Never include the underlying error (it can echo file contents/paths).
      fail('could not read --wallet-file')
    }
  } else if (typeof flags.wallet === 'string') {
    raw = flags.wallet
    // Human-only hint; gate to a TTY so it never prepends the structured JSON
    // that fail()/pay-mpp recovery write to stderr for automation to parse.
    if (process.stderr.isTTY) {
      process.stderr.write(
        'warning: passing a private key via --wallet exposes it to process listings, ' +
          'shell history, and logs. Prefer QUICKPAY_PRIVATE_KEY or --wallet-file <path>.\n',
      )
    }
  } else if (process.env.QUICKPAY_PRIVATE_KEY) {
    raw = process.env.QUICKPAY_PRIVATE_KEY
  }
  if (!raw) {
    fail('a wallet private key is required (set QUICKPAY_PRIVATE_KEY, or pass --wallet-file <path> / --wallet <key>)')
  }
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
      fail(
        'usage: goatx402-quickpay pay-x402 <url> --amount <a> --token-contract <address> --chain <id> [--memo <m>] [--idempotency-key <k>]\n' +
          '  wallet key: set QUICKPAY_PRIVATE_KEY (preferred) or pass --wallet-file <path> / --wallet <key>',
      )
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
      // Accept the natural --idempotency-key (matching the API's idempotency_key
      // field), keeping --idempotency as a back-compat alias. Previously only
      // --idempotency was read, so the documented-looking --idempotency-key was
      // silently dropped, defeating retry-safety.
      idempotencyKey:
        typeof flags['idempotency-key'] === 'string'
          ? flags['idempotency-key']
          : typeof flags.idempotency === 'string'
            ? flags.idempotency
            : undefined,
      // --force broadcasts even for a REUSED session. Default off so an auto-retry
      // cannot double-pay a session that may already have an in-flight transfer.
      force: flags.force === true,
    })
    process.stdout.write(JSON.stringify(out) + '\n')
    process.exit(out.ok ? 0 : 2)
  }

  if (command === 'pay-product') {
    if (!url) {
      fail(
        'usage: goatx402-quickpay pay-product <url> --product <key> --token-contract <address> --chain <id> [--idempotency-key <k>] [--force]\n' +
          '  the merchant prices the product; the buyer only picks the token + chain\n' +
          '  wallet key: set QUICKPAY_PRIVATE_KEY (preferred) or pass --wallet-file <path> / --wallet <key>',
      )
    }
    // --amount / --memo are meaningless for a product (the merchant sets the price
    // and pins the memo). Reject them explicitly rather than silently ignoring, so a
    // caller is never misled into thinking a custom amount/memo took effect.
    if (flags.amount !== undefined) {
      fail('pay-product does not take --amount (the merchant prices the product); use pay-x402 for a custom amount')
    }
    if (flags.memo !== undefined) {
      fail('pay-product does not take --memo (the server pins memo=product:<key>)')
    }
    const product = typeof flags.product === 'string' ? flags.product : ''
    const token = typeof flags.token === 'string' ? flags.token : ''
    const tokenContract = typeof flags['token-contract'] === 'string' ? flags['token-contract'] : ''
    // typeof check first: a valueless `--chain` is stored as `true`, and
    // Number(true) === 1 would silently target chain 1.
    const chain = typeof flags.chain === 'string' ? Number(flags.chain) : NaN
    if (!product || (!token && !tokenContract) || !Number.isSafeInteger(chain) || chain <= 0) {
      fail('pay-product requires --product, --token or --token-contract, and a positive integer --chain')
    }
    const backend = new EthersPaymentBackend(privateKey(flags), rpcResolver(flags))
    const out = await payProduct({
      input: url,
      productKey: product,
      tokenSymbol: token || undefined,
      tokenContract: tokenContract || undefined,
      chainId: chain,
      backend,
      idempotencyKey:
        typeof flags['idempotency-key'] === 'string'
          ? flags['idempotency-key']
          : typeof flags.idempotency === 'string'
            ? flags.idempotency
            : undefined,
      force: flags.force === true,
    })
    process.stdout.write(JSON.stringify(out) + '\n')
    process.exit(out.ok ? 0 : 2)
  }

  if (command === 'pay-mpp') {
    if (!url) {
      fail(
        'usage: goatx402-quickpay pay-mpp <url> --route <route>\n' +
          '  wallet key: set QUICKPAY_PRIVATE_KEY (preferred) or pass --wallet-file <path> / --wallet <key>',
      )
    }
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

  fail(`unknown command "${command ?? ''}". Commands: inspect, pay-x402, pay-product, pay-mpp`)
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
