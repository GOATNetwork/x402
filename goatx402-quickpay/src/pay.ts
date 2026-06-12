import { endpoints, loadManifest } from './manifest.js'
import { toWei } from './amount.js'
import type { QuickPayManifestToken } from './types.js'

/**
 * PaymentBackend abstracts the on-chain ERC20 transfer so the orchestration is
 * unit-testable without a chain. The default implementation (EthersPaymentBackend)
 * uses ethers; tests inject a mock.
 */
export interface PaymentBackend {
  getAddress(): Promise<string>
  transferErc20(p: { chainId: number; tokenContract: string; to: string; amountWei: string }): Promise<string>
}

/** MppBackend abstracts the MPP challenge→pay→verify flow (default: goatx402-sdk MPPClient). */
export interface MppBackend {
  pay(p: { coreUrl: string; merchantId: string; routeCanonical: string; chainId: number }): Promise<{
    txHash: string
    receiptHeader?: string
    receipt?: unknown
  }>
}

const TERMINAL_STATUSES = new Set(['PAYMENT_CONFIRMED', 'EXPIRED', 'FAILED', 'CANCELLED'])
const FRESH_UNPAID_STATUSES = new Set(['ORDER_CREATED', 'CREATED'])

// assertSameOrigin is defense in depth: redirect:'error' already rejects any
// redirect on a conformant runtime, but if a fetch impl followed one anyway we
// must not process a response served from a different origin than we targeted.
function assertSameOrigin(res: Response, url: string): void {
  if (res.url && new URL(res.url).origin !== new URL(url).origin) {
    throw new Error(`request redirected off-origin to ${res.url}`)
  }
}

async function postJSON(fetchImpl: typeof fetch, url: string, body: unknown): Promise<any> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  })
  assertSameOrigin(res, url)
  const text = await res.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { error: text }
  }
  if (!res.ok) {
    throw new Error(`POST ${url} failed (HTTP ${res.status}): ${parsed.error ?? text}`)
  }
  return parsed
}

async function getJSON(fetchImpl: typeof fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' })
  assertSameOrigin(res, url)
  if (!res.ok) {
    throw new Error(`GET ${url} failed (HTTP ${res.status})`)
  }
  return res.json()
}

export interface PayX402Options {
  input: string
  amount: string
  tokenSymbol?: string
  tokenContract?: string
  chainId: number
  backend: PaymentBackend
  memo?: string
  idempotencyKey?: string
  /**
   * Broadcast even when the server returns a REUSED session. Off by default:
   * a reused session may already have an in-flight transfer the watcher has not
   * observed yet, so re-broadcasting would double-pay. Set only when the caller
   * is certain no payment was broadcast (e.g. the wallet rejected the first try).
   */
  force?: boolean
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  pollTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface PayX402Result {
  ok: boolean
  rail: 'x402'
  merchant_id: string
  session_id: string
  order_id?: string
  tx_hash: string
  status: string
  amount_wei: string
  chain_id: number
  token_symbol: string
  /** true when the backend returned an existing QuickPay session/order. */
  reused: boolean
  /** human-readable note for agents/operators (e.g. why no payment was sent). */
  note?: string
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function sameTokenContract(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function selectX402Token(
  tokens: QuickPayManifestToken[],
  chainId: number,
  tokenSymbol?: string,
  tokenContract?: string,
): QuickPayManifestToken {
  const symbol = tokenSymbol?.trim()
  const contract = tokenContract?.trim()
  if (!symbol && !contract) {
    throw new Error('pay-x402 requires --token <SYM> or --token-contract <address>')
  }

  let candidates = tokens.filter((t) => t.chain_id === chainId)
  if (symbol) {
    candidates = candidates.filter((t) => t.token_symbol.toUpperCase() === symbol.toUpperCase())
  }
  if (contract) {
    candidates = candidates.filter((t) => sameTokenContract(t.token_contract, contract))
  }

  if (candidates.length === 1) return candidates[0]

  if (candidates.length > 1 && symbol && !contract) {
    throw new Error(`token ${symbol} on chain ${chainId} is ambiguous; pass --token-contract <address>`)
  }

  const requested = contract ? `token contract ${contract}` : `token ${symbol}`
  throw new Error(`${requested} on chain ${chainId} is not supported by this merchant`)
}

function isFreshUnpaidStatus(status: string): boolean {
  return FRESH_UNPAID_STATUSES.has(status)
}

/**
 * payX402 runs the full custom-amount flow: resolve manifest (trust-anchored) ->
 * pick token -> create session on the TRUSTED origin -> on-chain transfer to the
 * session's payTo -> poll session status. All endpoints come from the origin, not
 * the manifest body.
 */
export async function payX402(o: PayX402Options): Promise<PayX402Result> {
  const fetchImpl = o.fetchImpl ?? fetch
  const sleep = o.sleep ?? defaultSleep
  const now = o.now ?? Date.now
  const pollInterval = o.pollIntervalMs ?? 3000
  const pollTimeout = o.pollTimeoutMs ?? 180000

  const { manifest, origin, merchantId } = await loadManifest(o.input, fetchImpl)
  if (!manifest.rails.x402.enabled) {
    throw new Error('x402 custom-amount payments are not available for this merchant')
  }
  // Preflight the merchant's memo requirement (advertised in the manifest) so the
  // agent gets a clear, actionable error instead of a server 400 after building
  // the request.
  if (manifest.rails.x402.memo_required && !o.memo?.trim()) {
    throw new Error('this merchant requires a memo; pass --memo <reference>')
  }
  const token = selectX402Token(manifest.rails.x402.tokens, o.chainId, o.tokenSymbol, o.tokenContract)
  const amountWei = toWei(o.amount, token.decimals)
  const payer = await o.backend.getAddress()
  const ep = endpoints(origin)

  const session = await postJSON(fetchImpl, ep.sessionCreate, {
    merchant_id: merchantId,
    payer_addr: payer,
    chain_id: o.chainId,
    token_contract: token.token_contract,
    amount_wei: amountWei,
    memo: o.memo,
    idempotency_key: o.idempotencyKey,
  })

  const sessionId: string = session?.session_id
  if (!sessionId) throw new Error('session response missing session_id')

  // Poll session status until terminal. NEVER throws and NEVER discards a known
  // tx hash: a transient status-fetch failure is retried (not propagated), and
  // `knownTx` (a hash we already broadcast) is preserved across the whole loop —
  // losing it would let a retry re-broadcast and double-pay, and would strand a
  // real on-chain payment with no record.
  const pollUntilTerminal = async (fromStatus: string, knownTx = ''): Promise<{ status: string; txHash: string }> => {
    let status = fromStatus
    let txHash = knownTx
    const deadline = now() + pollTimeout
    while (now() < deadline) {
      let s: any
      try {
        s = await getJSON(fetchImpl, ep.sessionStatus(sessionId))
      } catch {
        await sleep(pollInterval)
        continue
      }
      status = s.status ?? status
      if (typeof s.tx_hash === 'string' && s.tx_hash) txHash = s.tx_hash
      if (TERMINAL_STATUSES.has(status)) break
      await sleep(pollInterval)
    }
    return { status, txHash }
  }

  const reused = session.reused === true
  const initialStatus: string = session.status ?? 'ORDER_CREATED'

  const result = (status: string, txHash: string, note?: string): PayX402Result => ({
    ok: status === 'PAYMENT_CONFIRMED',
    rail: 'x402',
    merchant_id: merchantId,
    session_id: sessionId,
    order_id: session.order_id,
    tx_hash: txHash,
    status,
    amount_wei: amountWei,
    chain_id: o.chainId,
    token_symbol: token.token_symbol,
    reused,
    ...(note ? { note } : {}),
  })

  // Case 1: the session is already past the fresh-unpaid state (possibly
  // terminal). Never broadcast — resolve and report. The create response never
  // carries tx_hash, so fetch the CURRENT status + tx_hash and report THAT, not the
  // stale create-time status: a late watcher bind can move e.g. EXPIRED ->
  // PAYMENT_CONFIRMED between create and this fetch, and we must surface the
  // freshly-observed status (a terminal initialStatus makes pollUntilTerminal return
  // on its first fetch, no sleep).
  if (!isFreshUnpaidStatus(initialStatus)) {
    const { status, txHash } = await pollUntilTerminal(initialStatus)
    return result(status, txHash)
  }

  // Case 2: a REUSED session that still looks fresh-unpaid. A prior attempt (this
  // CLI re-run, the web page, or another client sharing the idempotency key /
  // tuple) may have ALREADY broadcast a transfer the watcher has not observed yet
  // — orders.tx_hash is only set on confirmation, so "ORDER_CREATED + no tx_hash"
  // does NOT prove unpaid. Broadcasting again would double-pay. So by default we
  // do NOT pay a reused session: we resume/poll. Pass force (CLI: --force) to pay
  // anyway, only when certain no payment was broadcast (e.g. wallet rejection).
  if (reused && !o.force) {
    const { status, txHash } = await pollUntilTerminal(initialStatus)
    if (!TERMINAL_STATUSES.has(status) && !txHash) {
      return result(
        status,
        txHash,
        'Reused session was not re-broadcast (it may already have an in-flight payment). ' +
          'Resume by polling this session_id; only retry with --force if no payment was sent.',
      )
    }
    return result(status, txHash)
  }

  // Case 3: a fresh new session (or a forced reuse). Strictly validate the
  // on-chain terms BEFORE broadcasting so a malformed/malicious session cannot
  // make us transfer the wrong token/amount/chain.
  const accepts = session?.x402?.accepts
  if (!Array.isArray(accepts)) throw new Error('session response missing x402.accepts')
  const wantNetwork = `eip155:${o.chainId}`
  const wantAsset = token.token_contract.toLowerCase()
  const accept = accepts.find(
    (a: any) =>
      a &&
      a.scheme === 'exact' &&
      a.network === wantNetwork &&
      String(a.amount) === amountWei &&
      typeof a.asset === 'string' &&
      a.asset.toLowerCase() === wantAsset &&
      typeof a.payTo === 'string' &&
      a.payTo.length > 0,
  )
  if (!accept) {
    throw new Error('session payment terms do not match the requested token / amount / chain')
  }

  // Transfer the manifest-selected token (authoritative) to the validated payTo.
  const txHash = await o.backend.transferErc20({
    chainId: o.chainId,
    tokenContract: token.token_contract,
    to: accept.payTo,
    amountWei,
  })

  // Preserve the broadcast tx hash through polling (pollUntilTerminal keeps
  // knownTx even on a status-fetch failure), so a poll error can never lose the
  // record of a real on-chain payment and trigger a re-broadcast on retry.
  const { status, txHash: finalTx } = await pollUntilTerminal(initialStatus, txHash)
  return result(status, finalTx || txHash)
}

export interface PayMppOptions {
  input: string
  route: string
  backend: MppBackend
  fetchImpl?: typeof fetch
}

export interface PayMppResult {
  ok: boolean
  rail: 'mpp'
  merchant_id: string
  route_canonical: string
  tx_hash: string
  receipt_header?: string
  receipt?: unknown
}

/**
 * payMpp resolves the manifest (trust-anchored), finds the fixed route, and runs
 * the MPP challenge→pay→verify flow against the TRUSTED origin via the backend.
 */
export async function payMpp(o: PayMppOptions): Promise<PayMppResult> {
  const fetchImpl = o.fetchImpl ?? fetch
  const { manifest, origin, merchantId } = await loadManifest(o.input, fetchImpl)
  if (!manifest.rails.mpp.enabled) {
    throw new Error('MPP fixed-route payments are not available for this merchant')
  }
  const route = manifest.rails.mpp.routes.find((r) => r.route_canonical === o.route)
  if (!route) {
    throw new Error(`MPP route "${o.route}" is not offered by this merchant`)
  }
  const r = await o.backend.pay({
    coreUrl: origin,
    merchantId,
    routeCanonical: route.route_canonical,
    chainId: route.chain_id,
  })
  return {
    ok: true,
    rail: 'mpp',
    merchant_id: merchantId,
    route_canonical: route.route_canonical,
    tx_hash: r.txHash,
    receipt_header: r.receiptHeader,
    receipt: r.receipt,
  }
}
