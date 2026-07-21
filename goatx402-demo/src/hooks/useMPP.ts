/**
 * useMPP — buyer-side MPP flow driver for the demo.
 *
 * Loads the backend's /api/mpp/config (so the SDK knows where Core
 * lives), instantiates an MPPClient when a wallet signer is present,
 * and exposes a single tryMPP() callback that drives the full
 * challenge → on-chain → verify → protected-resource sequence.
 *
 * Phase + error state flow back to the UI for rendering a step
 * indicator. The hook intentionally does not auto-trigger — the user
 * clicks "Try MPP" because the flow opens the wallet for signature.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import { MPPClient, MPPError, type MPPPhase, type MPPVerifyResult } from 'goatflow-sdk'

export interface MPPConfig {
  coreUrl: string
  merchantId: string
  routeCanonical: string
  routeOptions: MPPRouteOption[]
}

export interface MPPRouteOption {
  id: string
  label: string
  routeCanonical: string
  description?: string
  amount?: string
  amountWei?: string
  token?: string
  tokenContract?: string
  tokenDecimals?: number
  chainId?: number
}

export interface UseMPPResult {
  config: MPPConfig | null
  configError: string | null
  configLoading: boolean
  /**
   * True only when /api/mpp/config returned 200 AND MPPClient was
   * successfully constructed (no coreUrl typo, signer present). Use
   * this to gate any UI affordance that would call tryMPP() — the
   * presence of `config` alone is not sufficient because the client
   * factory can throw on a bad coreUrl.
   */
  ready: boolean
  /** Last phase reported by MPPClient. 'idle' before tryMPP is called. */
  phase: MPPPhase | 'idle'
  result: MPPVerifyResult | null
  protectedResponse: Record<string, unknown> | null
  error: MPPError | null
  selectedRouteOptionId: string
  setSelectedRouteOptionId: (id: string) => void
  /** True between tryMPP() invocation and final phase ('verified' / 'failed'). */
  running: boolean
  tryMPP: () => Promise<void>
  /**
   * True when the last failure happened AFTER the on-chain transfer was
   * broadcast (MPPError.recoverable is populated). The UI must offer a
   * "Retry verify" path instead of "Try MPP" — otherwise the user pays
   * twice. Mirrors the recoverable handle attached by MPPClient.pay().
   */
  canRetryVerify: boolean
  /**
   * Re-runs ONLY the verify + protected-resource fetch using the
   * (challenge, txHash, payerAddr) tuple captured at broadcast time.
   * Safe to call repeatedly while canRetryVerify stays true.
   */
  retryVerify: () => Promise<void>
  /**
   * True when verify already succeeded (a valid receipt is in `result`) but
   * the protected-resource fetch did not — the buyer has PAID and holds a
   * usable receipt; only the resource handoff failed. The UI must offer a
   * "Retry fetch" path (which reuses the existing receipt) instead of "Try
   * MPP" — otherwise the user re-runs pay() and transfers on-chain a second
   * time for the same intent.
   */
  canRetryFetch: boolean
  /**
   * Re-runs ONLY the protected-resource fetch using the receipt already in
   * `result`. No new challenge, no re-verify, no wallet prompt. Safe to call
   * repeatedly while canRetryFetch stays true.
   */
  retryFetch: () => Promise<void>
  reset: () => void
}

export function useMPP(signer: ethers.Signer | null): UseMPPResult {
  const [config, setConfig] = useState<MPPConfig | null>(null)
  const [selectedRouteOptionId, setSelectedRouteOptionIdState] = useState('')
  const [activeRouteOptionId, setActiveRouteOptionId] = useState('')
  const [configError, setConfigError] = useState<string | null>(null)
  const [configLoading, setConfigLoading] = useState(true)

  const [phase, setPhase] = useState<MPPPhase | 'idle'>('idle')
  const [result, setResult] = useState<MPPVerifyResult | null>(null)
  const [protectedResponse, setProtectedResponse] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<MPPError | null>(null)
  const [running, setRunning] = useState(false)

  // Backend config fetch. The 503 branch carries actionable
  // diagnostic info in the body — `error` is the stable code
  // (mpp_not_ready / mpp_not_configured) and `detail` explains
  // *why* the backend isn't ready (missing middleware build, bad
  // receipt key, invalid algorithm string, etc.). Surface both so
  // the operator doesn't have to log-dive on a misconfiguration.
  useEffect(() => {
    let cancelled = false
    setConfigLoading(true)
    setConfigError(null)
    fetch('/api/mpp/config')
      .then(async (r) => {
        if (cancelled) return
        if (!r.ok) {
          let detail = ''
          let code = ''
          try {
            const body = (await r.json()) as { error?: string; detail?: string }
            if (typeof body.error === 'string') code = body.error
            if (typeof body.detail === 'string') detail = body.detail
          } catch {
            // body wasn't JSON — fall back to bare HTTP code below.
          }
          if (!code && !detail) {
            setConfigError(`/api/mpp/config returned HTTP ${r.status}`)
          } else if (code === 'mpp_not_configured') {
            // Special-case the "operator hasn't set env vars" path
            // with operator-friendly guidance; for any other 503
            // (mpp_not_ready, etc.) prefer the backend detail.
            setConfigError(
              'MPP demo not configured. Set MPP_CORE_URL / MPP_MERCHANT_ID / MPP_RECEIPT_KEY_HEX in the demo .env to enable.',
            )
          } else if (detail) {
            setConfigError(`${code || `HTTP ${r.status}`}: ${detail}`)
          } else {
            setConfigError(code)
          }
          setConfig(null)
          return
        }
        const body = (await r.json()) as MPPConfig
        const routeOptions =
          Array.isArray(body.routeOptions) && body.routeOptions.length > 0
            ? body.routeOptions
            : [
                {
                  id: 'default',
                  label: 'Protected resource',
                  routeCanonical: body.routeCanonical,
                },
              ]
        const normalized = { ...body, routeOptions, routeCanonical: routeOptions[0].routeCanonical }
        setConfig(normalized)
        setSelectedRouteOptionIdState((current) =>
          routeOptions.some((o) => o.id === current) ? current : routeOptions[0].id,
        )
      })
      .catch((err) => {
        if (cancelled) return
        setConfigError(err instanceof Error ? err.message : 'failed to load MPP config')
        setConfig(null)
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // MPPClient construction can throw on a malformed coreUrl (trailing
  // slash is the common typo — by-design strict in the SDK to avoid
  // double-slash 404s). Catching here keeps the host React app from
  // crashing during render: a typo'd MPP_CORE_URL surfaces as a
  // configError on the MPP panel and the rest of the demo (including
  // Classic mode) stays interactive.
  //
  // The memo is kept pure (no setState during render): both branches
  // return a {client, clientError} pair so React 18 strict-mode double
  // invocation does not trigger an extra render cycle.
  const { client, clientError } = useMemo<{
    client: MPPClient | null
    clientError: string | null
  }>(() => {
    if (!signer || !config) return { client: null, clientError: null }
    try {
      return { client: new MPPClient({ coreUrl: config.coreUrl, signer }), clientError: null }
    } catch (err) {
      return {
        client: null,
        clientError:
          err instanceof Error
            ? `MPP client init failed: ${err.message}`
            : 'MPP client init failed',
      }
    }
  }, [signer, config])

  const reset = useCallback(() => {
    setPhase('idle')
    setResult(null)
    setProtectedResponse(null)
    setError(null)
    setRunning(false)
    setActiveRouteOptionId('')
  }, [])

  const setSelectedRouteOptionId = useCallback(
    (id: string) => {
      setSelectedRouteOptionIdState(id)
      reset()
    },
    [reset],
  )

  const selectedRouteOption = useMemo(() => {
    if (!config) return null
    return (
      config.routeOptions.find((o) => o.id === selectedRouteOptionId) ??
      config.routeOptions[0] ??
      null
    )
  }, [config, selectedRouteOptionId])

  const protectedPathFor = useCallback((optionId: string) => {
    return `/api/mpp/protected/${encodeURIComponent(optionId)}`
  }, [])

  // Shared receipt-consumption tail used by both tryMPP (post-pay) and
  // retryVerify (post-recover). Throws an MPPError on non-2xx so the
  // caller's catch records the failure consistently.
  const consumeReceipt = useCallback(
    async (verifyResult: MPPVerifyResult, routeOptionId: string) => {
      const protectedRes = await fetch(protectedPathFor(routeOptionId), {
        headers: { 'Payment-Receipt': verifyResult.receiptHeader },
      })
      const body = (await protectedRes.json()) as Record<string, unknown>
      if (!protectedRes.ok) {
        const code = typeof body.error === 'string' ? body.error : `http_${protectedRes.status}`
        throw new MPPError(`protected resource refused receipt: ${code}`, code, protectedRes.status)
      }
      setProtectedResponse(body)
    },
    [protectedPathFor],
  )

  const tryMPP = useCallback(async () => {
    if (!client || !config || !selectedRouteOption) return
    const option = selectedRouteOption
    setRunning(true)
    setResult(null)
    setProtectedResponse(null)
    setError(null)
    setPhase('requesting_challenge')
    setActiveRouteOptionId(option.id)

    try {
      // requestCanonical is suffixed with a per-attempt timestamp so
      // consecutive clicks of "Try MPP" don't reuse the same challenge
      // key (Core would otherwise return the same challenge from the
      // reuse window).
      const requestCanonical = `${option.routeCanonical}:demo-${Date.now()}`
      const verifyResult = await client.pay({
        merchantId: config.merchantId,
        routeCanonical: option.routeCanonical,
        requestCanonical,
        onPhase: (next: MPPPhase) => setPhase(next),
      })
      setResult(verifyResult)
      await consumeReceipt(verifyResult, option.id)
    } catch (caught) {
      const mppErr =
        caught instanceof MPPError
          ? caught
          : new MPPError(
              caught instanceof Error ? caught.message : 'unknown error',
              'unknown',
              undefined,
              caught,
            )
      setError(mppErr)
      setPhase('failed')
    } finally {
      setRunning(false)
    }
  }, [client, config, selectedRouteOption, consumeReceipt])

  // Re-run only verifyChallenge + the protected-resource fetch using
  // the recoverable handle captured at broadcast time. Without this
  // path the only "next action" after a verify-side failure is the
  // Try MPP button, which would re-issue a challenge and prompt the
  // wallet for a second on-chain transfer — the user pays twice for
  // the same intent. Gate the UI on canRetryVerify so we never call
  // this without a valid recoverable handle.
  const retryVerify = useCallback(async () => {
    if (!client || !activeRouteOptionId) return
    const recoverable = error?.recoverable
    if (!recoverable) return
    setRunning(true)
    setError(null)
    setPhase('verifying')
    try {
      const verifyResult = await client.verifyChallenge({
        challenge: recoverable.challenge,
        txHash: recoverable.txHash,
        payerAddr: recoverable.payerAddr,
        onPhase: (next: MPPPhase) => setPhase(next),
      })
      setResult(verifyResult)
      setPhase('verified')
      await consumeReceipt(verifyResult, activeRouteOptionId)
    } catch (caught) {
      // The recoverable handle MUST survive re-failures, otherwise the
      // UI falls back to "Try MPP" → fresh challenge → second on-chain
      // transfer. verifyChallenge() throws MPPError *without*
      // recoverable populated (only pay()'s post-payment catch sets
      // it), and the protected-resource fetch may throw a plain Error.
      // So in BOTH branches, if the caught error doesn't already carry
      // a recoverable, re-wrap with the snapshotted handle.
      let mppErr: MPPError
      if (caught instanceof MPPError) {
        mppErr = caught.recoverable
          ? caught
          : new MPPError(
              caught.message,
              caught.code,
              caught.httpStatus,
              caught.cause,
              recoverable,
            )
      } else {
        mppErr = new MPPError(
          caught instanceof Error ? caught.message : 'unknown error',
          'unknown',
          undefined,
          caught,
          recoverable,
        )
      }
      setError(mppErr)
      setPhase('failed')
    } finally {
      setRunning(false)
    }
  }, [client, error, consumeReceipt, activeRouteOptionId])

  // Re-run ONLY the protected-resource fetch using the receipt already
  // captured in `result`. This is the recovery path when pay()+verify
  // succeeded (the buyer has paid and holds a valid receiptHeader) but the
  // /api/mpp/protected handoff failed transiently. Without it the only
  // enabled action would be Try MPP, which re-issues a challenge and prompts
  // a SECOND on-chain transfer for the same intent.
  const retryFetch = useCallback(async () => {
    if (!result || !activeRouteOptionId) return
    setRunning(true)
    setError(null)
    // Verify already succeeded (we hold result.receiptHeader), so reflect that
    // in the phase — otherwise a prior 'failed' step indicator lingers behind
    // the success panel once the fetch lands. A fetch failure below flips it
    // back to 'failed'.
    setPhase('verified')
    try {
      await consumeReceipt(result, activeRouteOptionId)
    } catch (caught) {
      const mppErr =
        caught instanceof MPPError
          ? caught
          : new MPPError(
              caught instanceof Error ? caught.message : 'unknown error',
              'unknown',
              undefined,
              caught,
            )
      setError(mppErr)
      setPhase('failed')
    } finally {
      setRunning(false)
    }
  }, [result, consumeReceipt, activeRouteOptionId])

  return {
    config,
    // Surface clientError alongside the upstream configError: both
    // are "MPP can't run as configured" states the UI renders the
    // same way (disabled tryMPP button + warning banner).
    configError: configError ?? clientError,
    configLoading,
    // `ready` is the single boolean the UI should check before
    // enabling the Try MPP button. Returning config without ready
    // would let the user click into a no-op flow.
    ready: !!client && !!selectedRouteOption,
    phase,
    result,
    protectedResponse,
    error,
    selectedRouteOptionId,
    setSelectedRouteOptionId,
    running,
    tryMPP,
    // Drop canRetryVerify once verify has succeeded (result is set): at that
    // point the on-chain tx is settled and a valid receipt exists, so the
    // correct recovery is retryFetch (reuse the receipt), not a re-verify.
    canRetryVerify: !!error?.recoverable && !!client && !result && !running,
    retryVerify,
    canRetryFetch: !!result && !protectedResponse && !!error && !running,
    retryFetch,
    reset,
  }
}
