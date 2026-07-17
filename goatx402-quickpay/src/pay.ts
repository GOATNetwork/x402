import { deriveTarget, endpoints, loadManifest } from './manifest.js'
import { toWei } from './amount.js'
import type { QuickPayManifest, QuickPayManifestToken } from './types.js'

/**
 * PaymentBackend abstracts the on-chain ERC20 transfer so the orchestration is
 * unit-testable without a chain. The default implementation (EthersPaymentBackend)
 * uses ethers; tests inject a mock.
 */
export interface PaymentBackend {
  getAddress(): Promise<string>
  transferErc20(p: { chainId: number; tokenContract: string; to: string; amountWei: string }): Promise<string>
}

/** MppBackend abstracts the MPP challenge→pay→verify flow (default: goatflow-sdk MPPClient). */
export interface MppBackend {
  pay(p: { coreUrl: string; merchantId: string; routeCanonical: string; chainId: number }): Promise<{
    txHash: string
    receiptHeader?: string
    receipt?: unknown
  }>
}

// Public QuickPay session statuses. These mirror the Go state machine in
// goatx402-core (store.deriveQuickPaySessionStatus, pinned by its
// TestDeriveQuickPaySessionStatus contract test) and the web app's App.tsx — keep
// all three in sync. TERMINAL = stop polling; FRESH_UNPAID = safe to broadcast.
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
  /** set when this was a product checkout (the merchant product_key paid for). */
  product_key?: string
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

function parseWei(s: string | undefined): bigint | null {
  if (typeof s !== 'string') return null
  const t = s.trim()
  return /^\d+$/.test(t) ? BigInt(t) : null
}

// assertWithinManifestLimits enforces the manifest's advertised per-token min/max
// CLIENT-SIDE, before a session is created and a transfer broadcast. The server is
// authoritative and also enforces these, but a preflight fails fast (no wasted
// session / fee charge) and defends the agent if a server ever under-validates.
// A non-numeric bound is treated as "unset" (the server still enforces the real one).
function assertWithinManifestLimits(amountWei: string, token: QuickPayManifestToken): void {
  const amt = BigInt(amountWei)
  const min = parseWei(token.min_amount_wei)
  if (min !== null && amt < min) {
    throw new Error(`amount ${amountWei} is below this token's minimum ${token.min_amount_wei}`)
  }
  const max = parseWei(token.max_amount_wei)
  if (max !== null && amt > max) {
    throw new Error(`amount ${amountWei} exceeds this token's maximum ${token.max_amount_wei}`)
  }
}

// SessionIntent is the resolved, validated payment intent that runX402Session
// turns into a session and (when fresh) an on-chain transfer. Both payX402
// (custom amount) and payProduct (fixed-price product) build one of these so the
// delicate reuse / double-pay / poll logic lives in ONE audited place.
interface SessionIntent {
  origin: string
  merchantId: string
  payer: string
  chainId: number
  tokenContract: string
  tokenSymbol: string
  // expectedAmountWei is the amount we computed INDEPENDENTLY (from --amount, or
  // from a product's manifest price). runX402Session refuses to broadcast unless
  // the session's x402 terms match it exactly, so a buggy/malicious/version-skewed
  // server can never make us transfer a different amount than we intended. It is
  // OPTIONAL: a product recovery may have no current quote (the product was repriced
  // to a non-representable value, or removed) yet still recover a prior session — in
  // which case the SERVER's amount is authoritative and we never broadcast. Undefined
  // therefore forbids a fresh/forced broadcast (fail closed) but allows recovery.
  expectedAmountWei?: string
  // createBody carries the request-specific fields of the session POST body
  // (merchant_id + payer_addr are always added). Custom-amount mode sends
  // amount_wei + memo; product mode sends product_key (the server prices it).
  createBody: Record<string, unknown>
  productKey?: string
  force?: boolean
  backend: PaymentBackend
  fetchImpl: typeof fetch
  pollIntervalMs: number
  pollTimeoutMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * runX402Session creates (or idempotently reuses) a QuickPay x402 session on the
 * TRUSTED origin, validates the returned terms against the caller's independently
 * computed expectedAmountWei, transfers to the session's payTo when (and only
 * when) it is a fresh unpaid session, and polls to a terminal status. All
 * endpoints come from the origin, never the manifest body.
 */
async function runX402Session(intent: SessionIntent): Promise<PayX402Result> {
  const { origin, merchantId, payer, chainId, tokenContract, tokenSymbol, expectedAmountWei, fetchImpl, sleep, now } =
    intent
  const ep = endpoints(origin)

  const session = await postJSON(fetchImpl, ep.sessionCreate, {
    merchant_id: merchantId,
    payer_addr: payer,
    ...intent.createBody,
  })

  const sessionId: string = session?.session_id
  if (!sessionId) throw new Error('session response missing session_id')

  // Poll session status until terminal. NEVER throws and NEVER discards a known
  // tx hash: a transient status-fetch failure is retried (not propagated), and
  // `knownTx` (a hash we already broadcast) is preserved across the whole loop —
  // losing it would let a retry re-broadcast and double-pay, and would strand a
  // real on-chain payment with no record.
  const pollUntilTerminal = async (
    fromStatus: string,
    knownTx = '',
    // adoptServerHash lets a FRESH broadcast replace its local hash with the
    // server-confirmed one. A wallet fee-bump mines a replacement tx, and the
    // watcher records that replacement as the order's tx_hash; for a fresh
    // session that hash is authoritative for the same payment, so reporting the
    // original pre-replacement hash would be wrong. It is NOT enabled for a
    // forced reused session, where the server may report a DIFFERENT prior tx
    // that must not overwrite the hash we just broadcast.
    adoptServerHash = false,
  ): Promise<{ status: string; txHash: string; serverAmountWei: string; gotSnapshot: boolean }> => {
    let status = fromStatus
    let txHash = knownTx
    // serverAmountWei is the session's AUTHORITATIVE on-chain amount as reported by
    // the status endpoint. We surface it so a reused/recovered session (whose amount
    // may differ from our freshly computed expectedAmountWei — e.g. a product
    // repriced after the session was created) is reported truthfully instead of
    // with the stale quote. Empty until a status fetch succeeds.
    let serverAmountWei = ''
    // gotSnapshot records whether ANY status fetch succeeded. For a recovered session
    // (where the server is the only authority on the amount/tx), reporting a terminal
    // outcome without a single successful snapshot would be a guess — callers use this
    // to fail closed instead.
    let gotSnapshot = false
    const deadline = now() + intent.pollTimeoutMs
    while (now() < deadline) {
      let s: any
      try {
        s = await getJSON(fetchImpl, ep.sessionStatus(sessionId))
      } catch {
        await sleep(intent.pollIntervalMs)
        continue
      }
      gotSnapshot = true
      status = s.status ?? status
      // Adopt the server's tx_hash when we hold none (Cases 1 & 2, which pass
      // knownTx='' and rely on the server for the hash) OR when adoptServerHash
      // is set for a fresh broadcast whose tx may have been fee-bumped into a
      // confirmed replacement. Never overwrite otherwise: on a forced reused
      // session the status may report a DIFFERENT prior tx, and losing the hash
      // we just broadcast would strand it for reconciliation.
      if ((adoptServerHash || !txHash) && typeof s.tx_hash === 'string' && s.tx_hash) {
        txHash = s.tx_hash
      }
      // Accept ONLY a well-formed integer amount; ignore a malformed/garbage value so
      // neither the product (substantiation) nor custom (drift) reporting path can ever
      // surface a non-integer amount instead of the client's authoritative quote.
      if (typeof s.amount_wei === 'string' && /^\d+$/.test(s.amount_wei)) serverAmountWei = s.amount_wei
      if (TERMINAL_STATUSES.has(status)) break
      await sleep(intent.pollIntervalMs)
    }
    return { status, txHash, serverAmountWei, gotSnapshot }
  }

  const reused = session.reused === true
  const initialStatus: string = session.status ?? 'ORDER_CREATED'

  const result = (status: string, txHash: string, opts?: { amountWei?: string; note?: string }): PayX402Result => ({
    ok: status === 'PAYMENT_CONFIRMED',
    rail: 'x402',
    merchant_id: merchantId,
    session_id: sessionId,
    order_id: session.order_id,
    tx_hash: txHash,
    status,
    amount_wei: opts?.amountWei ?? expectedAmountWei ?? '',
    chain_id: chainId,
    token_symbol: tokenSymbol,
    reused,
    ...(intent.productKey ? { product_key: intent.productKey } : {}),
    ...(opts?.note ? { note: opts.note } : {}),
  })

  // reportRecovered builds the result for a session we did NOT validate-and-broadcast
  // ourselves (Cases 1 & 2 — pre-existing / reused / recovered). For these the SERVER
  // is authoritative for the amount.
  //
  // PRODUCTS: core's product idempotency recovers a prior session on
  // (payer, product_key, chain, token), so a product repriced after that session was
  // created yields an OLDER amount; the client's current quote may be stale, missing,
  // or non-representable. We therefore report ONLY a server-substantiated amount: we
  // require a status snapshot that carries a valid integer amount_wei, and report THAT
  // (never the client quote). Without it we cannot tell what was actually paid — fail
  // closed (reconcile by session_id) rather than fabricate a success at the stale quote.
  // A drift note is added when the authoritative amount differs from the current quote.
  //
  // CUSTOM-AMOUNT: the reuse tuple keys on the amount, so expectedAmountWei IS the real
  // amount — report the server's amount when present (with a drift note if it somehow
  // differs) else fall back to expectedAmountWei, and never throw on a missing snapshot.
  const reportRecovered = (
    status: string,
    txHash: string,
    serverAmountWei: string,
    gotSnapshot: boolean,
    baseNote?: string,
  ): PayX402Result => {
    const withDrift = (extra: string): string | undefined => (baseNote ? `${baseNote} ${extra}` : extra)
    if (intent.productKey) {
      if (!gotSnapshot || !/^\d+$/.test(serverAmountWei)) {
        throw new Error(
          `recovered an existing session (session_id ${sessionId}) but could not read its authoritative ` +
            'amount from the server; reconcile via this session_id before retrying — do NOT blindly re-run ' +
            '(it may double-pay)',
        )
      }
      // A CONFIRMED product recovery must also carry the server's tx_hash; without it we
      // cannot point the buyer at the on-chain payment, so don't claim a clean success.
      if (status === 'PAYMENT_CONFIRMED' && !txHash) {
        throw new Error(
          `recovered a CONFIRMED session (session_id ${sessionId}) but the server did not return its ` +
            'transaction hash; reconcile via this session_id before retrying',
        )
      }
      const note =
        expectedAmountWei && serverAmountWei !== expectedAmountWei
          ? withDrift(
              `the existing session's amount (${serverAmountWei}) differs from the current quote ` +
                `(${expectedAmountWei}); the product may have been repriced since this session was created`,
            )
          : baseNote
      return result(status, txHash, { amountWei: serverAmountWei, note })
    }
    // Custom-amount: the reuse tuple keys on the amount, so expectedAmountWei IS the
    // authoritative amount. ALWAYS report it (restoring payX402's original behavior) —
    // never substitute a server value. If the server somehow reports a different
    // (sanitized) amount, surface a drift note but keep the authoritative figure.
    if (serverAmountWei && expectedAmountWei && serverAmountWei !== expectedAmountWei) {
      return result(status, txHash, {
        note: withDrift(`the server reported amount ${serverAmountWei} but this payment's amount is ${expectedAmountWei}`),
      })
    }
    return result(status, txHash, { note: baseNote })
  }

  // Case 1: the session is already past the fresh-unpaid state (possibly
  // terminal). Never broadcast — resolve and report. The create response never
  // carries tx_hash, so fetch the CURRENT status + tx_hash and report THAT, not the
  // stale create-time status: a late watcher bind can move e.g. EXPIRED ->
  // PAYMENT_CONFIRMED between create and this fetch, and we must surface the
  // freshly-observed status (a terminal initialStatus makes pollUntilTerminal return
  // on its first fetch, no sleep).
  if (!isFreshUnpaidStatus(initialStatus)) {
    const { status, txHash, serverAmountWei, gotSnapshot } = await pollUntilTerminal(initialStatus)
    return reportRecovered(status, txHash, serverAmountWei, gotSnapshot)
  }

  // Case 2: a REUSED session that still looks fresh-unpaid. A prior attempt (this
  // CLI re-run, the web page, or another client sharing the idempotency key /
  // tuple) may have ALREADY broadcast a transfer the watcher has not observed yet
  // — orders.tx_hash is only set on confirmation, so "ORDER_CREATED + no tx_hash"
  // does NOT prove unpaid. Broadcasting again would double-pay. So by default we
  // do NOT pay a reused session: we resume/poll. Pass force (CLI: --force) to pay
  // anyway, only when certain no payment was broadcast (e.g. wallet rejection).
  if (reused && !intent.force) {
    const { status, txHash, serverAmountWei, gotSnapshot } = await pollUntilTerminal(initialStatus)
    if (!TERMINAL_STATUSES.has(status) && !txHash) {
      return reportRecovered(
        status,
        txHash,
        serverAmountWei,
        gotSnapshot,
        'Reused session was not re-broadcast (it may already have an in-flight payment). ' +
          'Resume by polling this session_id; only retry with --force if no payment was sent.',
      )
    }
    return reportRecovered(status, txHash, serverAmountWei, gotSnapshot)
  }

  // Case 3: a fresh new session (or a forced reuse). Strictly validate the
  // on-chain terms BEFORE broadcasting so a malformed/malicious session cannot
  // make us transfer the wrong token/amount/chain. The amount check is against
  // expectedAmountWei — for a product that is the manifest price re-denominated in
  // the chosen token, so a server that priced the product differently is rejected.
  //
  // Fail closed if we have no independently computed amount to check against: a fresh
  // broadcast without one would mean trusting the server's amount blind. (Reached only
  // for a product whose current price is missing/non-representable — recovery above
  // does not need a quote, but a fresh purchase cannot proceed without one.)
  if (expectedAmountWei === undefined) {
    throw new Error(
      'cannot verify payment terms for a new session: the product is no longer offered or its ' +
        'price is not representable in the chosen token',
    )
  }
  const accepts = session?.x402?.accepts
  if (!Array.isArray(accepts)) throw new Error('session response missing x402.accepts')
  const wantNetwork = `eip155:${chainId}`
  const wantAsset = tokenContract.toLowerCase()
  const accept = accepts.find(
    (a: any) =>
      a &&
      a.scheme === 'exact' &&
      a.network === wantNetwork &&
      String(a.amount) === expectedAmountWei &&
      typeof a.asset === 'string' &&
      a.asset.toLowerCase() === wantAsset &&
      typeof a.payTo === 'string' &&
      a.payTo.length > 0,
  )
  if (!accept) {
    throw new Error('session payment terms do not match the requested token / amount / chain')
  }

  // Transfer the manifest-selected token (authoritative) to the validated payTo.
  const txHash = await intent.backend.transferErc20({
    chainId,
    tokenContract,
    to: accept.payTo,
    amountWei: expectedAmountWei,
  })

  // Preserve the broadcast tx hash through polling (pollUntilTerminal keeps
  // knownTx even on a status-fetch failure), so a poll error can never lose the
  // record of a real on-chain payment and trigger a re-broadcast on retry. For a
  // FRESH session (reused=false) adopt the server-confirmed hash if the wallet
  // fee-bumped this payment into a replacement; a forced reuse keeps its local
  // hash so a prior server-reported tx cannot overwrite what we just sent.
  const { status, txHash: finalTx } = await pollUntilTerminal(initialStatus, txHash, !reused)
  return result(status, finalTx || txHash)
}

/**
 * payX402 runs the full custom-amount flow: resolve manifest (trust-anchored) ->
 * pick token -> delegate to runX402Session (create on the TRUSTED origin ->
 * transfer to the session's payTo -> poll). All endpoints come from the origin,
 * not the manifest body.
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
  // Enforce the manifest's advertised min/max for a FRESH session only. With an
  // explicit idempotencyKey the caller is retrying/resuming a specific payment
  // intent, which the server recovers BEFORE re-checking mutable limits — so a
  // limit tightened after the original create (lower max / higher min) must not
  // block that retry here. A brand-new explicit-key session is still range-checked
  // server-side; this only preflights the common no-key fresh-create path.
  if (!o.idempotencyKey?.trim()) {
    assertWithinManifestLimits(amountWei, token)
  }
  const payer = await o.backend.getAddress()

  return runX402Session({
    origin,
    merchantId,
    payer,
    chainId: o.chainId,
    tokenContract: token.token_contract,
    tokenSymbol: token.token_symbol,
    expectedAmountWei: amountWei,
    createBody: {
      chain_id: o.chainId,
      token_contract: token.token_contract,
      amount_wei: amountWei,
      memo: o.memo,
      idempotency_key: o.idempotencyKey,
    },
    // Coerce to a strict boolean: a plain-JS caller passing a truthy non-boolean
    // (e.g. the string "false") must never bypass the reused-session double-pay
    // guard. Only a literal true forces a broadcast on a reused session.
    force: o.force === true,
    backend: o.backend,
    fetchImpl,
    pollIntervalMs: pollInterval,
    pollTimeoutMs: pollTimeout,
    sleep,
    now,
  })
}

export interface PayProductOptions {
  input: string
  /** the merchant product_key to buy (from the manifest's rails.x402.products). */
  productKey: string
  /** the token to pay in — by symbol and/or contract (buyer picks). */
  tokenSymbol?: string
  tokenContract?: string
  chainId: number
  backend: PaymentBackend
  idempotencyKey?: string
  /** see PayX402Options.force — broadcast even for a REUSED session. */
  force?: boolean
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  pollTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * payProduct buys a merchant fixed-price product by product_key. It resolves the
 * manifest (trust-anchored), lets the buyer pick the token, and — for a FRESH
 * purchase — INDEPENDENTLY denominates the advertised decimal price in that token
 * (price * 10^decimals) and refuses to broadcast unless the server's x402 terms
 * match it, so the server cannot charge more than the advertised price. No memo is
 * sent (the server pins memo='product:'+key); the merchant's memo_required flag is
 * therefore not preflighted.
 *
 * DURABLE RECOVERY requires an explicit idempotencyKey. Core recovers a prior product
 * session by (merchant, explicit key) BEFORE re-validating mutable product/token/rail
 * config (verified in core's CreateQuickPayX402Session), so when one is supplied we
 * tolerate the CURRENT manifest no longer listing the product/token/rail — and, given an
 * explicit --token-contract, even the manifest being entirely unavailable/invalid (the
 * trust anchor still comes from the URL path). We may then have no quote, and a fresh
 * broadcast fails closed; only the server-recovered session is reported. WITHOUT an explicit key, Core does
 * NOT auto-recover a removed/disabled product (it 404s — core's documented "KNOWN
 * TRADE-OFF"), so we validate against the current manifest and fail fast with a clear
 * client error rather than emit a confusing server 404. (A no-key re-run of an UNCHANGED
 * product still recovers via core's auto-derived key after normal resolution.)
 */
export async function payProduct(o: PayProductOptions): Promise<PayX402Result> {
  const fetchImpl = o.fetchImpl ?? fetch
  const sleep = o.sleep ?? defaultSleep
  const now = o.now ?? Date.now
  const pollInterval = o.pollIntervalMs ?? 3000
  const pollTimeout = o.pollTimeoutMs ?? 180000

  const productKey = o.productKey?.trim()
  if (!productKey) {
    throw new Error('pay-product requires --product <product_key>')
  }
  // Product-specific token preflight: selectX402Token's "requires --token" message is
  // pay-x402-worded, so check here first to give product callers the right guidance.
  if (!o.tokenSymbol?.trim() && !o.tokenContract?.trim()) {
    throw new Error('pay-product requires --token <SYM> or --token-contract <address>')
  }
  // recovering: an explicit idempotency key is the only mechanism Core honors before
  // re-validating mutable config, so it is the only case where tolerating a changed —
  // or entirely unreachable — manifest is meaningful. Without it we treat the call as a
  // fresh purchase and require a valid current manifest.
  const explicitContract = o.tokenContract?.trim()
  const recovering = !!o.idempotencyKey?.trim()

  // The trust anchor (origin + merchant_id) comes from the URL PATH, not the manifest
  // body, so it is available even when the manifest cannot be fetched/validated.
  const { origin, merchantId } = deriveTarget(o.input)
  // Load the manifest for the current product/token metadata. A reachable, VALID manifest
  // is REQUIRED for a fresh purchase (we must independently price the product to verify the
  // server's terms). For an explicit-key RECOVERY with an explicit --token-contract we
  // tolerate the manifest being unavailable/invalid: Core recovers a prior product session
  // by (merchant, explicit key) BEFORE re-validating product/token/rail config, and with no
  // quote a fresh broadcast still fails closed in runX402Session — so resuming an in-flight
  // payment never depends on the merchant's manifest staying up.
  let manifest: QuickPayManifest | undefined
  try {
    manifest = (await loadManifest(o.input, fetchImpl)).manifest
  } catch (err) {
    if (!recovering || !explicitContract) throw err
    manifest = undefined
  }

  const product = manifest
    ? (manifest.rails.x402.products ?? []).find((p) => p.product_key === productKey)
    : undefined
  // Fail fast for a fresh purchase whose product/rail is not currently available — a
  // no-key retry of a removed/disabled product cannot recover server-side anyway, so a
  // clear client error beats a server 404. An explicit-key recovery is allowed through.
  if (!product && !recovering) {
    throw new Error(`product "${productKey}" is not offered by this merchant`)
  }
  if (manifest && !manifest.rails.x402.enabled && !recovering) {
    throw new Error('x402 product payments are not available for this merchant')
  }
  // Resolve the chosen token from the CURRENT manifest. For an explicit-key RECOVERY we
  // tolerate the token no longer being listed (or no manifest at all) AS LONG AS the
  // caller passed an explicit --token-contract that is ABSENT from the manifest: we post
  // that contract for recovery, but without manifest metadata we have no quote, so a fresh
  // broadcast fails closed in runX402Session. A contract that IS present but failed
  // selection (e.g. a conflicting --token symbol, or ambiguity), or any failure without an
  // explicit absent contract, is a fresh-path/input error — fail before POST.
  let token: QuickPayManifestToken | undefined
  if (manifest) {
    try {
      token = selectX402Token(manifest.rails.x402.tokens, o.chainId, o.tokenSymbol, explicitContract)
    } catch (err) {
      const contractAbsent =
        !!explicitContract &&
        !manifest.rails.x402.tokens.some(
          (t) => t.chain_id === o.chainId && t.token_contract.toLowerCase() === explicitContract.toLowerCase(),
        )
      if (!recovering || !contractAbsent) throw err
      token = undefined
    }
  }
  const tokenContract = token ? token.token_contract : explicitContract!
  const tokenSymbol = token?.token_symbol ?? o.tokenSymbol?.trim() ?? ''
  // Compute the expected amount from the CURRENT manifest price WHEN POSSIBLE (requires
  // the product AND token metadata). Required to broadcast a fresh purchase (price
  // integrity, enforced in runX402Session) but only best-effort for a recovery — a
  // missing manifest/product/token or non-representable price leaves it undefined, in which
  // case a fresh/forced broadcast fails closed while an explicit-key recovery reports the
  // server's authoritative amount.
  let expectedAmountWei: string | undefined
  if (product && token) {
    try {
      expectedAmountWei = toWei(product.price, token.decimals)
    } catch {
      expectedAmountWei = undefined
    }
  }
  // A disabled x402 rail is a recovery-ONLY escape hatch, never a fresh-pay surface —
  // even if a version-skewed manifest reports enabled:false while still listing valid
  // token/product entries. Drop any computed quote so a fresh/forced session fails closed
  // in runX402Session (a recovered session still reports the server's authoritative amount).
  if (manifest && !manifest.rails.x402.enabled) {
    expectedAmountWei = undefined
  }
  // No client-side min/max preflight (unlike payX402): Core enforces min/max
  // authoritatively, and an explicit-key recovery must not be blocked by a tightened
  // current limit. A fresh out-of-range purchase is rejected server-side; a fresh
  // broadcast is still amount-verified in runX402Session (Case 3).
  const payer = await o.backend.getAddress()

  return runX402Session({
    origin,
    merchantId,
    payer,
    chainId: o.chainId,
    tokenContract,
    tokenSymbol,
    expectedAmountWei,
    productKey,
    // Product mode sends product_key + the chosen chain/token. We deliberately do
    // NOT send amount_wei/memo: the server prices the product and pins the memo,
    // and (for a fresh purchase) we verify its returned amount against expectedAmountWei.
    createBody: {
      chain_id: o.chainId,
      token_contract: tokenContract,
      product_key: productKey,
      idempotency_key: o.idempotencyKey,
    },
    // Coerce to a strict boolean: a plain-JS caller passing a truthy non-boolean
    // (e.g. the string "false") must never bypass the reused-session double-pay
    // guard. Only a literal true forces a broadcast on a reused session.
    force: o.force === true,
    backend: o.backend,
    fetchImpl,
    pollIntervalMs: pollInterval,
    pollTimeoutMs: pollTimeout,
    sleep,
    now,
  })
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
  // Defense in depth: only report ok:true when the backend produced BOTH an
  // on-chain tx hash AND the receipt artifact the merchant middleware verifies.
  // Returning ok:true unconditionally would tell an agent the payment succeeded
  // even when nothing was broadcast (no hash) or the authorization proof is
  // missing (no receipt) — e.g. if the optional goatflow-sdk shape drifts.
  const txHash = typeof r.txHash === 'string' ? r.txHash.trim() : ''
  // Require the SIGNED Payment-Receipt HEADER specifically — that is the artifact the
  // merchant middleware verifies. A decoded `receipt` BODY alone is NOT sufficient
  // (the caller would have nothing to present to the merchant), so it cannot stand in
  // for the header.
  const receiptHeader = typeof r.receiptHeader === 'string' ? r.receiptHeader.trim() : ''
  if (!txHash) {
    throw new Error('MPP payment did not complete: the backend returned no transaction hash (nothing was broadcast).')
  }
  if (!receiptHeader) {
    // Broadcast but no signed receipt header => the merchant's authorization proof is
    // missing, so we cannot report success. We do NOT have the challenge at this layer
    // (the MppBackend interface does not expose it), so this is deliberately NOT a
    // resumable MPPError: surfacing it as one (see mpp-error.ts / cli.ts) would emit a
    // recovery payload with NO challenge and falsely promise the caller it can resume
    // /mpp/v1/verify — which is impossible without the challenge. Throw a plain,
    // explicit error that records the broadcast tx and warns against a blind retry
    // (which could double-pay). The SDK's own post-broadcast verify failures still
    // throw a real MPPError (with challenge) that cli.ts can resume.
    throw new Error(
      `MPP payment broadcast (tx ${txHash}) but no signed receipt header was returned; verification is incomplete. ` +
        `Do NOT re-run pay-mpp (it may double-pay) — reconcile this tx_hash manually.`,
    )
  }
  return {
    ok: true,
    rail: 'mpp',
    merchant_id: merchantId,
    route_canonical: route.route_canonical,
    tx_hash: txHash,
    receipt_header: receiptHeader,
    receipt: r.receipt,
  }
}
