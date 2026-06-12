/**
 * MPPClient — buyer-side MPP (Machine Payments Protocol) helper for browser dApps.
 *
 * Wraps Core's /mpp/v1/challenge → on-chain ERC-20 transfer → /mpp/v1/verify
 * sequence behind a single MPPClient.pay() call. Designed for the browser:
 * accepts an ethers.Signer + Core URL and runs entirely client-side.
 *
 * SDK fields are camelCase. The wire payload to Core is snake_case
 * (challenge_id, tx_hash, payer_addr, route_canonical, request_canonical,
 * route_pricing_version) and is converted at the boundary in this file.
 *
 * Error model: every public method throws an MPPError (see types.ts) on
 * failure. Callers branch on err.code rather than err.message, since the
 * codes are stable across SDK versions and the messages are not.
 */

import { ethers } from 'ethers'
import { ERC20Token } from './contracts/erc20.js'
import {
  type MPPChallenge,
  type MPPPayParams,
  type MPPPhase,
  type MPPVerifyResult,
  MPPError,
} from './types.js'

interface MPPClientOptions {
  /** Core base URL e.g. "https://core.staging" — no trailing slash. */
  coreUrl: string
  signer: ethers.Signer
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock (epoch ms) for tests. Defaults to Date.now. */
  clock?: () => number
  /**
   * Sleep implementation for tests. Real impl is setTimeout-based; tests
   * pass a noop that drives a virtual clock. Defaults to setTimeout.
   */
  sleep?: (ms: number) => Promise<void>
}

interface RequestChallengeParams {
  merchantId: string
  routeCanonical: string
  requestCanonical: string
  /** Defaults to signer.getAddress(). */
  payerAddr?: string
}

interface VerifyChallengeParams {
  challenge: MPPChallenge
  txHash: string
  payerAddr?: string
  maxAttempts?: number
  onPhase?: (phase: MPPPhase, detail?: unknown) => void
  /**
   * Optional hook consulted at the START of every poll attempt to obtain
   * the tx_hash to verify. Lets pay()'s background replacement watcher
   * redirect polling to a fee-bump / "speed up" replacement hash
   * mid-flight: Core's unbound-Pending model accepts a different tx from
   * the same payer for the same challenge. When it returns undefined / an
   * empty string the loop falls back to the initial `txHash`. The hash
   * actually used for the settling attempt is echoed back in the result.
   */
  currentTxHash?: () => string | undefined
}

/**
 * Max seconds the SDK will sleep between verify-poll attempts even if
 * the server returns a larger Retry-After. Caps the wait so a buggy /
 * malicious server cannot stall the SDK indefinitely. 30s matches the
 * MPP plan docs' guidance for SDK ceiling.
 */
const MAX_RETRY_AFTER_SECONDS = 30

/**
 * Default verify polling attempts. Pinned UNDER Core's server-side
 * per-(tx_hash, order_id) budget — Core's ratelimit.TxOrderBudget
 * defaults to 18 (= max_candidate_count(8) + retry_budget(10)). Every
 * verify call that reaches Phase B burns one non-refundable token
 * against that budget; once exhausted Core returns 429 budget
 * exhausted and no later poll can settle. Pinning the SDK default
 * below the server budget guarantees the buyer never out-polls the
 * server.
 *
 * Why 16, not 18: leaves 2 tokens of slack for the buyer's own
 * retry / recovery (e.g. they could open a second tab and re-poll
 * the same challenge), and absorbs any one-off Phase-B hits the
 * server may charge outside the SDK's polling loop.
 *
 * 16 × Core's typical 5s Retry-After ≈ 80s of polling budget — fast
 * enough for Tempo testnet (3s blocks × 3 confirmations) and most
 * EVM testnets. For chains with slower finality (e.g. Ethereum
 * mainnet 12 confirmations ≈ 144s), operators MUST raise Core's
 * mpp.rate_limit.tx_order_budget AND callers MUST pass an explicit
 * maxVerifyAttempts; bumping the SDK default alone would only hide
 * the eventual 429 budget-exhausted failure mode.
 */
const DEFAULT_VERIFY_ATTEMPTS = 16

/** Fallback delay when 202 has no parseable Retry-After header. */
const DEFAULT_RETRY_AFTER_SECONDS = 2

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse RFC 7231 Retry-After: either a non-negative integer seconds
 * value or an HTTP-date. Returns DEFAULT_RETRY_AFTER_SECONDS when
 * missing / unparseable. The result is clamped to
 * [0, MAX_RETRY_AFTER_SECONDS] by the caller.
 */
function parseRetryAfter(header: string | null, now: number): number {
  if (!header) return DEFAULT_RETRY_AFTER_SECONDS
  const trimmed = header.trim()
  if (trimmed === '') return DEFAULT_RETRY_AFTER_SECONDS
  // Integer-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : DEFAULT_RETRY_AFTER_SECONDS
  }
  // HTTP-date form.
  const ts = Date.parse(trimmed)
  if (Number.isNaN(ts)) return DEFAULT_RETRY_AFTER_SECONDS
  const seconds = Math.ceil((ts - now) / 1000)
  return seconds > 0 ? seconds : 0
}

function decodeChallenge(body: unknown): MPPChallenge {
  if (typeof body !== 'object' || body === null) {
    throw new MPPError('challenge response body is not an object', 'parse_error')
  }
  const raw = body as Record<string, unknown>
  const challenge_id = raw.challenge_id
  // Core's ChallengeResponse JSON tag is "expiry" (verified against
  // internal/mpp/handler/challenge_handler.go:94). Earlier drafts of
  // this SDK used "expiry_unix"; accept both for forward / backward
  // tolerance, but prefer "expiry" since that's the wire spec.
  const expiry = raw.expiry !== undefined ? raw.expiry : raw.expiry_unix
  const amount_wei = raw.amount_wei
  const chain_id = raw.chain_id
  const token_contract = raw.token_contract
  const recipient = raw.recipient
  const mac = raw.mac
  const route_pricing_version = raw.route_pricing_version
  if (typeof challenge_id !== 'string' || challenge_id === '') {
    throw new MPPError('challenge.challenge_id missing or not a string', 'parse_error')
  }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
    throw new MPPError('challenge.expiry missing or not a number', 'parse_error')
  }
  if (typeof amount_wei !== 'string' || amount_wei === '') {
    throw new MPPError('challenge.amount_wei missing or not a string', 'parse_error')
  }
  if (typeof chain_id !== 'number' || !Number.isFinite(chain_id)) {
    throw new MPPError('challenge.chain_id missing or not a number', 'parse_error')
  }
  if (typeof token_contract !== 'string' || token_contract === '') {
    throw new MPPError('challenge.token_contract missing or not a string', 'parse_error')
  }
  if (typeof recipient !== 'string' || recipient === '') {
    throw new MPPError('challenge.recipient missing or not a string', 'parse_error')
  }
  if (typeof mac !== 'string' || mac === '') {
    throw new MPPError('challenge.mac missing or not a string', 'parse_error')
  }
  if (typeof route_pricing_version !== 'number' || !Number.isFinite(route_pricing_version)) {
    throw new MPPError(
      'challenge.route_pricing_version missing or not a number',
      'parse_error'
    )
  }
  return {
    challengeId: challenge_id,
    expiryUnix: expiry,
    amountWei: amount_wei,
    chainId: chain_id,
    tokenContract: token_contract,
    recipient,
    mac,
    routePricingVersion: route_pricing_version,
  }
}

/** Base64url-decode the receipt payload segment to its JSON body. */
function decodeReceiptPayload(headerValue: string): {
  segments: string[]
  body: Record<string, unknown>
} {
  const segments = headerValue.split('.')
  if (segments.length !== 3) {
    throw new MPPError(
      `Payment-Receipt header must have 3 segments separated by ".", got ${segments.length}`,
      'receipt_malformed'
    )
  }
  // base64url → standard base64
  const padded =
    segments[0].replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (segments[0].length % 4)) % 4)
  let json: string
  try {
    if (typeof globalThis.atob === 'function') {
      json = globalThis.atob(padded)
    } else {
      // Node.js fallback (tests). Buffer is not always typed here.
      const B = (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }).Buffer
      if (!B) throw new Error('no base64 decoder available')
      json = B.from(padded, 'base64').toString('utf-8')
    }
  } catch (err) {
    throw new MPPError('Payment-Receipt payload is not valid base64url', 'receipt_malformed', undefined, err)
  }
  let body: unknown
  try {
    body = JSON.parse(json)
  } catch (err) {
    throw new MPPError('Payment-Receipt payload is not valid JSON', 'receipt_malformed', undefined, err)
  }
  if (typeof body !== 'object' || body === null) {
    throw new MPPError('Payment-Receipt payload JSON is not an object', 'receipt_malformed')
  }
  return { segments, body: body as Record<string, unknown> }
}

async function readResponseError(
  res: Response
): Promise<{ code: string; message: string }> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { code: 'parse_error', message: `HTTP ${res.status} with non-JSON body` }
  }
  if (typeof body === 'object' && body !== null) {
    const b = body as { error?: unknown; detail?: unknown }
    const code = typeof b.error === 'string' && b.error !== '' ? b.error : `http_${res.status}`
    const detail = typeof b.detail === 'string' ? b.detail : ''
    return { code, message: detail !== '' ? `${code}: ${detail}` : code }
  }
  return { code: `http_${res.status}`, message: `HTTP ${res.status}` }
}

export class MPPClient {
  private readonly coreUrl: string
  private readonly signer: ethers.Signer
  private readonly fetchImpl: typeof fetch
  private readonly clock: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: MPPClientOptions) {
    if (!opts.coreUrl || opts.coreUrl.endsWith('/')) {
      // Trailing slash would double the slash in the constructed URL
      // and Core's strict path matcher returns 404 on /mpp/v1//challenge.
      throw new MPPError(
        'coreUrl must be a non-empty URL without a trailing slash',
        'invalid_request'
      )
    }
    this.coreUrl = opts.coreUrl
    this.signer = opts.signer
    const f = opts.fetchImpl ?? globalThis.fetch
    if (typeof f !== 'function') {
      throw new MPPError('fetch is not available; pass fetchImpl in opts', 'invalid_request')
    }
    this.fetchImpl = f.bind(globalThis)
    this.clock = opts.clock ?? (() => Date.now())
    this.sleep = opts.sleep ?? defaultSleep
  }

  /**
   * Wrap signer.getAddress() with MPPError. Raw ethers / EIP-1193
   * provider failures (account access revoked, wallet disconnected,
   * RPC down) would otherwise bubble out as untyped errors, breaking
   * the MPPClient contract that every rejection is an MPPError with
   * a stable code. Maps to "user_rejected" when ethers identifies the
   * failure as a wallet rejection, "payment_failed" otherwise (the
   * closest existing code for signer/account access failures).
   */
  private async getSignerAddress(): Promise<string> {
    try {
      return await this.signer.getAddress()
    } catch (err) {
      const code = isUserRejection(err) ? 'user_rejected' : 'payment_failed'
      throw new MPPError(
        'failed to read signer address (wallet disconnected, account revoked, or RPC unavailable)',
        code,
        undefined,
        err,
      )
    }
  }

  /**
   * B-2: POST /mpp/v1/challenge. Expects HTTP 402 (the spec response
   * for a "payment required" success — the challenge body is the
   * payment instruction).
   */
  async requestChallenge(p: RequestChallengeParams): Promise<MPPChallenge> {
    const payerAddr = p.payerAddr ?? (await this.getSignerAddress())
    const body = {
      merchant_id: p.merchantId,
      route_canonical: p.routeCanonical,
      request_canonical: p.requestCanonical,
      payer_addr: payerAddr,
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.coreUrl}/mpp/v1/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new MPPError('challenge request failed', 'network_error', undefined, err)
    }

    // 402 is the success path (spec). Anything else is an error.
    if (res.status !== 402) {
      const { code, message } = await readResponseError(res)
      throw new MPPError(message, code, res.status)
    }

    let parsed: unknown
    try {
      parsed = await res.json()
    } catch (err) {
      throw new MPPError('challenge response is not valid JSON', 'parse_error', res.status, err)
    }
    return decodeChallenge(parsed)
  }

  /**
   * B-3: ERC-20 transfer to challenge.recipient for challenge.amountWei
   * on challenge.chainId. Returns the broadcast tx hash IMMEDIATELY —
   * the SDK does not call tx.wait() here.
   *
   * Why no wait: when this method is composed by pay(), waiting locally
   * for `tx.wait(1)` before calling /mpp/v1/verify created a race —
   * a slow RPC could push the wait past challenge.expiryUnix, after
   * which Core rejects the eventual verify as `challenge_expired`
   * even though the buyer broadcast within the TTL. Worst case: paid
   * but unredeemable. Returning the broadcast hash immediately lets
   * pay() call verify before expiry; verify's 202 / Retry-After loop
   * is the authoritative "is it mined yet" gate, and the verifier-side
   * settler validates the on-chain receipt (revert, underpayment,
   * wrong recipient) so the local wait was strictly redundant.
   *
   * Replacement / "speed up" handling: payChallenge still returns the
   * broadcast hash IMMEDIATELY (no tx.wait() here) so pay() can call
   * /mpp/v1/verify before challenge.expiryUnix — reintroducing a blocking
   * wait here would re-open the expiry race round-12 removed. Instead the
   * returned TransactionResponse (`tx`) lets pay() run a NON-blocking
   * replacement watcher CONCURRENTLY with verify polling: if the wallet
   * fee-bumps the payment ("speed up" → a new tx_hash), pay() redirects
   * verify to the replacement hash. This now settles because Core's Pending
   * state is UNBOUND — it accepts any tx from the same payer for the order
   * rather than locking to the first-presented hash (the unbound-Pending
   * redesign). Direct payChallenge callers that want the same behaviour can
   * watch the returned `tx` themselves and feed verifyChallenge's
   * `currentTxHash` hook.
   *
   * Pre-broadcast validation also added (P2 from codex round 12):
   *   - chain mismatch → "chain_mismatch", no wallet popup
   *   - challenge already expired (clock vs expiryUnix) →
   *     "challenge_expired", no wallet popup. Direct callers of
   *     payChallenge get the same protection as pay().
   */
  async payChallenge(
    challenge: MPPChallenge
  ): Promise<{ txHash: string; tx: ethers.TransactionResponse }> {
    const provider = this.signer.provider
    if (!provider) {
      throw new MPPError('signer has no attached provider', 'payment_failed')
    }
    // Expiry pre-check. Use the injected clock for testability; the
    // 1-second slack accommodates clock skew between the SDK and Core
    // — without it a challenge issued at T with expiry T+300 could
    // fail this check at T+299.5 on a slightly fast local clock.
    const nowSeconds = Math.floor(this.clock() / 1000)
    if (challenge.expiryUnix <= nowSeconds) {
      throw new MPPError(
        `challenge expired ${nowSeconds - challenge.expiryUnix}s ago — refusing to broadcast transfer`,
        'challenge_expired'
      )
    }
    let network: ethers.Network
    try {
      network = await provider.getNetwork()
    } catch (err) {
      throw new MPPError('failed to read signer provider network', 'payment_failed', undefined, err)
    }
    if (Number(network.chainId) !== challenge.chainId) {
      throw new MPPError(
        `signer is on chain ${network.chainId}, challenge requires ${challenge.chainId}`,
        'chain_mismatch'
      )
    }

    let tx: ethers.TransactionResponse
    try {
      const token = new ERC20Token(challenge.tokenContract, this.signer)
      tx = await token.transfer(challenge.recipient, BigInt(challenge.amountWei))
    } catch (err) {
      // User-cancelled wallet popups are explicit + worth special-casing
      // so UI can render "user rejected" distinctly from chain errors.
      const code = isUserRejection(err) ? 'user_rejected' : 'payment_failed'
      throw new MPPError('ERC20 transfer failed', code, undefined, err)
    }
    if (!tx.hash) {
      // Defensive: ethers v6 always populates hash on a successful
      // broadcast, but the type permits string | null in some
      // intermediate shapes. Surface a clear error rather than
      // returning an empty txHash to verify.
      throw new MPPError('transfer broadcast returned no tx hash', 'payment_failed')
    }
    return { txHash: tx.hash, tx }
  }

  /**
   * B-4: POST /mpp/v1/verify with retry-after polling for 202 and
   * exponential backoff for 5xx. Stops at maxAttempts
   * (default DEFAULT_VERIFY_ATTEMPTS = 16) or the first 4xx / 200.
   *
   * 401 errors (challenge_expired, challenge_already_consumed,
   * challenge_tx_hash_mismatch, payer_mismatch) are terminal — no
   * retry. 5xx retries with min(2^attempt, MAX_RETRY_AFTER_SECONDS).
   */
  async verifyChallenge(p: VerifyChallengeParams): Promise<MPPVerifyResult> {
    const { challenge, txHash } = p
    const payerAddr = p.payerAddr ?? (await this.getSignerAddress())
    const maxAttempts = p.maxAttempts ?? DEFAULT_VERIFY_ATTEMPTS
    const onPhase = p.onPhase ?? (() => {})
    if (maxAttempts < 1) {
      throw new MPPError('maxAttempts must be >= 1', 'invalid_request')
    }

    let lastNetworkError: unknown = null
    // Tracks the hash actually posted on the latest attempt. Echoed back in
    // the success result and may differ from the initial txHash if the
    // currentTxHash hook redirected polling to a replacement (see pay()).
    let effectiveTxHash = txHash
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Re-read the hash at the start of every attempt so a background
      // replacement watcher can redirect polling to a fee-bump / "speed up"
      // replacement mid-flight without restarting the loop. Core accepts the
      // new hash because Pending is unbound (same payer, same order).
      effectiveTxHash = p.currentTxHash?.() || txHash
      const body = JSON.stringify({
        challenge_id: challenge.challengeId,
        tx_hash: effectiveTxHash,
        payer_addr: payerAddr,
        mac: challenge.mac,
      })
      onPhase('verifying', { attempt, txHash: effectiveTxHash })
      let res: Response
      try {
        res = await this.fetchImpl(`${this.coreUrl}/mpp/v1/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        lastNetworkError = null
      } catch (err) {
        // After payChallenge, the buyer has already sent the ERC-20
        // transfer. A transient network failure here (DNS blip, RPC
        // edge proxy timing out, browser temporarily offline) must NOT
        // discard the binding — the challenge is still Pending against
        // their tx_hash, and the next attempt has a good chance of
        // landing. Treat fetch rejections like 5xx: retry with
        // exponential backoff up to maxAttempts. Only throw
        // network_error when the attempt budget is exhausted.
        lastNetworkError = err
        if (attempt >= maxAttempts) {
          throw new MPPError(
            `verify network request failed after ${attempt} attempts`,
            'network_error',
            undefined,
            err
          )
        }
        const backoff = clampRetryAfter(Math.min(Math.pow(2, attempt), MAX_RETRY_AFTER_SECONDS))
        onPhase('verify_pending', { attempt, networkError: true, backoff })
        await this.sleep(backoff * 1000)
        continue
      }
      void lastNetworkError

      if (res.status === 200) {
        const receiptHeader = res.headers.get('Payment-Receipt') ?? res.headers.get('payment-receipt')
        if (!receiptHeader) {
          throw new MPPError(
            'verify returned 200 but Payment-Receipt header is missing (check Core CORS expose-headers)',
            'receipt_missing',
            200
          )
        }
        const { body: receiptBody } = decodeReceiptPayload(receiptHeader)
        return {
          receiptHeader,
          receiptBody,
          txHash: effectiveTxHash,
          challengeId: challenge.challengeId,
        }
      }

      if (res.status === 202 || res.status === 429) {
        // 202 is the canonical "tx pending finality" branch; 429 is
        // transient rate-limiting on the verify endpoint. Both leave
        // the challenge in a re-pollable state (it's still Pending
        // for the buyer's tx_hash), and both carry Retry-After. After
        // the buyer has already paid on-chain, surfacing 429 as a
        // terminal failure would force them to re-issue a challenge
        // and re-send the tx — far worse than backing off and
        // re-polling. Treat them uniformly.
        const retryAfter = clampRetryAfter(
          parseRetryAfter(res.headers.get('Retry-After'), this.clock())
        )
        onPhase('verify_pending', { attempt, status: res.status, retryAfter })
        if (attempt >= maxAttempts) {
          const reason = res.status === 429 ? 'verify rate-limited' : 'verify still pending'
          throw new MPPError(
            `${reason} after ${attempt} attempts`,
            'verify_timeout',
            res.status
          )
        }
        await this.sleep(retryAfter * 1000)
        continue
      }

      if (res.status >= 400 && res.status < 500) {
        const { code, message } = await readResponseError(res)
        // 4xx is terminal — no retry. Includes 400 bad_request,
        // 401 challenge_*, 404 route_not_found, 413 request_body_too_large.
        // 429 is handled above as a retryable branch.
        throw new MPPError(message, code, res.status)
      }

      if (res.status >= 500) {
        if (attempt >= maxAttempts) {
          const { code, message } = await readResponseError(res)
          throw new MPPError(message, code || 'service_unavailable', res.status)
        }
        // Exponential backoff capped at MAX_RETRY_AFTER_SECONDS. We
        // re-check Retry-After since Core's 503 path also sets it.
        const fromHeader = parseRetryAfter(res.headers.get('Retry-After'), this.clock())
        const backoff = clampRetryAfter(
          Math.max(fromHeader, Math.min(Math.pow(2, attempt), MAX_RETRY_AFTER_SECONDS))
        )
        onPhase('verify_pending', { attempt, status: res.status, backoff })
        await this.sleep(backoff * 1000)
        continue
      }

      // Any other unexpected status — surface a stable code.
      throw new MPPError(
        `verify returned unexpected status ${res.status}`,
        'parse_error',
        res.status
      )
    }

    // Defensive — loop above always either returns or throws.
    throw new MPPError('verify polling exhausted', 'verify_timeout')
  }

  /**
   * Background, non-blocking watcher for wallet fee-bump / "speed up"
   * replacements of the payment tx. ethers v6 surfaces a replacement as a
   * TransactionReplacedError (code 'TRANSACTION_REPLACED') from tx.wait(),
   * carrying the new TransactionResponse on `.replacement` and a `.reason`
   * ('repriced' | 'replaced' | 'cancelled'). On a non-cancel replacement it
   * invokes onReplaced(newHash) and keeps following the chain (a buyer may
   * speed up more than once); a 'cancelled' replacement is NOT a payment, so
   * we stop following it. Any other rejection (RPC error, tx mined) ends the
   * watch quietly — verify polling stays the source of truth.
   *
   * Fire-and-forget: returns a stop() that the caller MUST invoke when it no
   * longer cares (verify finished), which prevents a post-completion
   * onReplaced callback. A tx without a .wait() (e.g. a minimal test stub) is
   * a no-op. Watcher failures are swallowed — this is best-effort
   * convenience, never a failure path for pay().
   */
  private followReplacements(
    tx: ethers.TransactionResponse,
    onReplaced: (newHash: string, reason: string) => void
  ): () => void {
    let stopped = false
    // A genuine fee-bump / "speed up" preserves the payment's destination and
    // calldata — only gas price changes. Capture the original payment's
    // (to, data) so we ONLY follow a replacement that is still THE SAME
    // payment. A same-nonce replacement to a different to/data (the user
    // replaced the payment with an unrelated tx, or a cancel) is NOT followed:
    // doing so would redirect verify polling to a non-payment hash and burn a
    // slot of the challenge's distinct-tx cap.
    const wantTo = (tx.to ?? '').toLowerCase()
    const wantData = tx.data ?? '0x'
    void (async () => {
      let current = tx
      while (!stopped) {
        if (!current || typeof current.wait !== 'function') return
        try {
          await current.wait()
          return // mined (or null receipt) — nothing to follow
        } catch (err) {
          if (stopped) return
          const rep = replacementFrom(err, wantTo, wantData)
          if (!rep) return // not a (followable) same-payment replacement — stop quietly
          onReplaced(rep.hash, rep.reason)
          current = rep.tx // follow further replacements of the same payment
        }
      }
    })().catch(() => {
      /* never surface watcher failures */
    })
    return () => {
      stopped = true
    }
  }

  /**
   * B-5: requestChallenge → payChallenge → verifyChallenge composition.
   * Reports each phase via onPhase so UI can render a step indicator.
   */
  async pay(p: MPPPayParams): Promise<MPPVerifyResult> {
    const requestCanonical = p.requestCanonical ?? p.routeCanonical
    const onPhase = p.onPhase ?? (() => {})
    const payerAddr = await this.getSignerAddress()

    onPhase('requesting_challenge')
    let challenge: MPPChallenge
    try {
      challenge = await this.requestChallenge({
        merchantId: p.merchantId,
        routeCanonical: p.routeCanonical,
        requestCanonical,
        payerAddr,
      })
    } catch (err) {
      onPhase('failed', err)
      throw err
    }
    onPhase('challenge_received', challenge)

    onPhase('sending_transaction', challenge)
    let txHash: string
    let tx: ethers.TransactionResponse
    try {
      const r = await this.payChallenge(challenge)
      txHash = r.txHash
      tx = r.tx
    } catch (err) {
      onPhase('failed', err)
      throw err
    }
    onPhase('transaction_sent', { txHash })

    // Follow a wallet fee-bump / "speed up" replacement in the background and
    // redirect verify polling to the replacement hash. Non-blocking, so the
    // expiry race round-12 removed stays closed; Core's unbound Pending
    // accepts the replacement (same payer, same order). currentTxHash holds
    // the latest hash — read by verifyChallenge each attempt and captured in
    // the recoverable handle so a manual resume targets the right tx.
    let currentTxHash = txHash
    const stopWatch = this.followReplacements(tx, (newHash) => {
      currentTxHash = newHash
      onPhase('transaction_replaced', { from: txHash, txHash: newHash })
    })

    try {
      const result = await this.verifyChallenge({
        challenge,
        txHash,
        payerAddr,
        maxAttempts: p.maxVerifyAttempts,
        onPhase,
        currentTxHash: () => currentTxHash,
      })
      onPhase('verified', result)
      return result
    } catch (err) {
      // Critical post-payment recovery handle. By the time we reach
      // this catch the ERC-20 transfer has been broadcast — losing
      // the (challenge, txHash) pair forces the caller to invoke
      // pay() again, which issues a fresh challenge and prompts the
      // wallet for a second transfer. Re-throw the original error
      // augmented with a `recoverable` payload so callers can resume
      // with verifyChallenge instead of paying twice. Errors that
      // already carry a recoverable handle (verifyChallenge re-throws
      // them) are preserved as-is so the original cause + httpStatus
      // remain intact.
      let rethrown: MPPError
      if (err instanceof MPPError) {
        rethrown = err.recoverable
          ? err
          : new MPPError(err.message, err.code, err.httpStatus, err.cause, {
              challenge,
              txHash: currentTxHash,
              payerAddr,
              tx,
            })
      } else {
        rethrown = new MPPError(
          err instanceof Error ? err.message : String(err),
          'unknown',
          undefined,
          err,
          { challenge, txHash: currentTxHash, payerAddr, tx },
        )
      }
      onPhase('failed', rethrown)
      throw rethrown
    } finally {
      // Stop the replacement watcher so it cannot fire onReplaced (and thus
      // onPhase) after pay() has settled.
      stopWatch()
    }
  }
}

function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
}

function isUserRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  // ethers v6 surfaces user rejection as code "ACTION_REJECTED" and
  // EIP-1193 wallets generally use code 4001. Match either.
  const e = err as { code?: unknown }
  if (typeof e.code === 'string' && e.code === 'ACTION_REJECTED') return true
  if (typeof e.code === 'number' && e.code === 4001) return true
  return false
}

/**
 * Extract a FOLLOWABLE replacement from an ethers v6 tx.wait() rejection.
 * ethers sets err.code = 'TRANSACTION_REPLACED', err.reason ∈
 * {'repriced','cancelled','replaced'} and err.replacement = the new
 * TransactionResponse.
 *
 * Returns null (do not follow) unless the replacement is STILL the same
 * payment — i.e. its (to, data) match the original transfer's (wantTo,
 * wantData). This rejects:
 *   - non-TRANSACTION_REPLACED errors,
 *   - user 'cancelled' replacements (0-value to self),
 *   - same-nonce 'replaced' txs that are a DIFFERENT operation (different to
 *     or calldata) — following those would point verify at a non-payment hash
 *     and waste a challenge distinct-tx slot,
 *   - malformed replacements.
 * The (to, data) check is authoritative rather than trusting err.reason: a
 * genuine fee-bump changes only gas, leaving to/data identical.
 */
function replacementFrom(
  err: unknown,
  wantTo: string,
  wantData: string
): { tx: ethers.TransactionResponse; hash: string; reason: string } | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { code?: unknown; reason?: unknown; replacement?: unknown }
  if (e.code !== 'TRANSACTION_REPLACED') return null
  if (e.reason === 'cancelled') return null
  const rep = e.replacement as ethers.TransactionResponse | undefined
  if (!rep || typeof rep.hash !== 'string' || rep.hash === '') return null
  const repTo = (rep.to ?? '').toLowerCase()
  const repData = rep.data ?? '0x'
  if (repTo !== wantTo || repData !== wantData) return null
  return { tx: rep, hash: rep.hash, reason: typeof e.reason === 'string' ? e.reason : 'replaced' }
}
