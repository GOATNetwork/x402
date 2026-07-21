/**
 * MPPPanel — buyer-side MPP demo UI.
 *
 * Renders the wallet readiness state, the "Try MPP" trigger, a
 * step-by-step phase indicator while a flow is in progress, and the
 * verified receipt + protected-resource response on success. Failures
 * render the typed MPPError code prominently so demo users see the
 * stable error vocabulary the SDK exposes (challenge_expired,
 * route_not_found, chain_mismatch, etc.).
 */
import type { MPPPhase, MPPVerifyResult, MPPError } from 'goatflow-sdk'
import type { MPPConfig, MPPRouteOption } from '../hooks/useMPP'

// Ordered for the step indicator. 'idle' / 'failed' / 'verify_pending'
// are rendered out-of-band; the linear "happy path" steps are these:
const STEP_ORDER: MPPPhase[] = [
  'requesting_challenge',
  'challenge_received',
  'sending_transaction',
  'transaction_sent',
  'verifying',
  'verified',
]

const STEP_LABELS: Record<MPPPhase, string> = {
  requesting_challenge: 'Requesting challenge',
  challenge_received: 'Challenge received',
  sending_transaction: 'Sending transaction',
  transaction_sent: 'Transaction sent',
  transaction_replaced: 'Transaction sped up',
  verifying: 'Verifying receipt',
  verify_pending: 'Verify pending (server retry)',
  verified: 'Verified',
  failed: 'Failed',
}

function stepIndex(phase: MPPPhase | 'idle'): number {
  if (phase === 'idle') return -1
  if (phase === 'verify_pending') return STEP_ORDER.indexOf('verifying')
  // A wallet "speed up" replaces the tx mid-flight; keep the indicator on
  // the "transaction sent" step (verify polling continues on the new hash).
  if (phase === 'transaction_replaced') return STEP_ORDER.indexOf('transaction_sent')
  if (phase === 'failed') return -1
  const i = STEP_ORDER.indexOf(phase)
  return i
}

interface MPPPanelProps {
  config: MPPConfig | null
  configError: string | null
  configLoading: boolean
  /**
   * Sourced from useMPP.ready. True only when /api/mpp/config returned
   * 200 AND MPPClient was constructed without errors. Gating the Try
   * MPP button on this instead of just `config` prevents the
   * "enabled-but-no-op" button state on a bad MPP_CORE_URL.
   */
  ready: boolean
  walletConnected: boolean
  phase: MPPPhase | 'idle'
  result: MPPVerifyResult | null
  protectedResponse: Record<string, unknown> | null
  error: MPPError | null
  selectedRouteOptionId: string
  onRouteOptionChange: (id: string) => void
  running: boolean
  onTry: () => void
  /**
   * Sourced from useMPP.canRetryVerify. True iff the last failure
   * carries a recoverable handle (broadcast already happened). Drives
   * visibility of the "Retry verify" button — without it the user's
   * only next action is "Try MPP" which would trigger a SECOND
   * on-chain transfer for the same intent.
   */
  canRetryVerify: boolean
  onRetryVerify: () => void
  /**
   * Sourced from useMPP.canRetryFetch. True iff verify already succeeded (a
   * valid receipt exists) but the protected-resource fetch failed. Drives the
   * "Retry fetch" button, which reuses the existing receipt instead of
   * re-running pay() — the latter would trigger a SECOND on-chain transfer.
   */
  canRetryFetch: boolean
  onRetryFetch: () => void
  onReset: () => void
}

export function MPPPanel(props: MPPPanelProps) {
  const {
    config,
    configError,
    configLoading,
    ready,
    walletConnected,
    phase,
    result,
    protectedResponse,
    error,
    selectedRouteOptionId,
    onRouteOptionChange,
    running,
    onTry,
    canRetryVerify,
    onRetryVerify,
    canRetryFetch,
    onRetryFetch,
    onReset,
  } = props

  const activeIndex = stepIndex(phase)
  const routeOptions: MPPRouteOption[] = config?.routeOptions ?? []
  const selectedRouteOption =
    routeOptions.find((option) => option.id === selectedRouteOptionId) ?? routeOptions[0]
  const routeSelectionLocked = running || !!result || !!error
  // Try MPP is enabled only when the full readiness chain is green:
  // backend reported config 200, MPPClient constructed, wallet
  // connected, no flow already in progress, AND no recoverable
  // failure pending. The last condition is critical: after a
  // post-broadcast verify failure the correct next action is
  // "Retry verify" (no new on-chain tx). If we leave Try MPP enabled
  // here, clicking it would re-run pay() → fresh challenge → wallet
  // popup → second on-chain transfer for the same intent. Force the
  // user through Retry verify or Reset to make that decision explicit.
  const canTry = ready && walletConnected && !!selectedRouteOption && !running && !canRetryVerify && !canRetryFetch

  return (
    <div className="bg-white rounded-lg shadow p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">MPP Demo</h2>
        <p className="text-sm text-gray-600">
          One click = HTTP-402 challenge → on-chain transfer → receipt → protected-resource
          fetch. Buyer-side flow uses <code>MPPClient</code> from <code>goatflow-sdk</code>.
        </p>
      </div>

      {configLoading && <p className="text-sm text-gray-500">Loading MPP config…</p>}
      {configError && (
        <div className="bg-orange-50 border border-orange-200 text-orange-700 rounded p-3 text-sm">
          {configError}
        </div>
      )}

      {config && (
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-700">
          <div>
            <span className="font-medium">Core URL:</span>{' '}
            <code className="break-all">{config.coreUrl}</code>
          </div>
          <div>
            <span className="font-medium">Merchant:</span>{' '}
            <code>{config.merchantId}</code>
          </div>
          <div>
            <span className="font-medium">Route:</span>{' '}
            <code>{selectedRouteOption?.routeCanonical ?? config.routeCanonical}</code>
          </div>
        </div>
      )}

      {config && routeOptions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-800">Payment option</h3>
            {routeSelectionLocked && (
              <button
                type="button"
                onClick={onReset}
                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              >
                Reset to change
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {routeOptions.map((option) => {
              const selected = option.id === selectedRouteOption?.id
              const price = [option.amount, option.token].filter(Boolean).join(' ')
              return (
                <label
                  key={option.id}
                  className={`border rounded-md p-3 cursor-pointer transition ${
                    selected
                      ? 'border-purple-500 bg-purple-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  } ${routeSelectionLocked ? 'cursor-not-allowed opacity-75' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="mpp-route-option"
                      className="mt-1"
                      checked={selected}
                      disabled={routeSelectionLocked}
                      onChange={() => onRouteOptionChange(option.id)}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900">{option.label}</span>
                        {price && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                            {price}
                          </span>
                        )}
                        {option.chainId != null && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                            chain {option.chainId}
                          </span>
                        )}
                      </div>
                      {option.description && (
                        <p className="text-xs text-gray-600 mt-1">{option.description}</p>
                      )}
                      <code className="block text-xs text-gray-500 break-all mt-1">
                        {option.routeCanonical}
                      </code>
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <button
          onClick={onTry}
          disabled={!canTry}
          className="px-4 py-2 bg-purple-600 text-white rounded-md text-sm hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          title={
            !ready
              ? configError ?? 'MPP is not ready'
              : !walletConnected
              ? 'Connect your wallet first'
              : running
              ? 'A flow is already in progress'
              : canRetryVerify
              ? 'A previous transaction is awaiting verification — click Retry verify, or Reset to abandon and start fresh'
              : canRetryFetch
              ? 'Payment verified and the receipt is valid — only the protected fetch failed. Click Retry fetch (no new payment), or Reset.'
              : !selectedRouteOption
              ? 'Select a payment option'
              : ''
          }
        >
          {running ? 'Running…' : 'Pay selected option'}
        </button>
        {canRetryVerify && (
          <button
            onClick={onRetryVerify}
            disabled={running}
            className="ml-2 px-4 py-2 bg-amber-600 text-white rounded-md text-sm hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            title="Re-verify the already-broadcast transaction. Click this instead of Try MPP to avoid paying twice."
          >
            Retry verify
          </button>
        )}
        {canRetryFetch && (
          <button
            onClick={onRetryFetch}
            disabled={running}
            className="ml-2 px-4 py-2 bg-amber-600 text-white rounded-md text-sm hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            title="Re-fetch the protected resource with the receipt you already paid for. No new on-chain payment."
          >
            Retry fetch
          </button>
        )}
        {(result || error) && (
          <button
            onClick={onReset}
            className="ml-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200"
          >
            Reset
          </button>
        )}
      </div>

      {phase !== 'idle' && (
        <ol className="space-y-1 text-sm">
          {STEP_ORDER.map((step, i) => {
            const reached = activeIndex >= i || (phase === 'verified' && step !== 'failed')
            const isCurrent = i === activeIndex && phase !== 'verified' && phase !== 'failed'
            const isFailedHere = phase === 'failed' && i === activeIndex + 1
            const dot = reached ? '✓' : isCurrent ? '●' : isFailedHere ? '✕' : '○'
            const color = isFailedHere
              ? 'text-red-600'
              : reached
              ? 'text-green-600'
              : isCurrent
              ? 'text-blue-600'
              : 'text-gray-400'
            return (
              <li key={step} className={`flex items-center gap-2 ${color}`}>
                <span className="w-4 inline-block text-center">{dot}</span>
                <span>
                  {STEP_LABELS[step]}
                  {step === 'verifying' && phase === 'verify_pending' && (
                    <span className="ml-2 text-orange-600 text-xs">
                      (server returned 202, retrying)
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm">
          <p className="text-red-700 font-semibold">
            {STEP_LABELS.failed} — <code>{error.code}</code>
            {typeof error.httpStatus === 'number' && (
              <span className="text-red-600 font-normal"> (HTTP {error.httpStatus})</span>
            )}
          </p>
          <p className="text-red-600 mt-1 break-all">{error.message}</p>
        </div>
      )}

      {result && protectedResponse && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm space-y-2">
          <p className="text-green-700 font-semibold">✅ Protected access OK</p>
          <div className="text-xs text-gray-700">
            <div>
              <span className="font-medium">route:</span>{' '}
              <code className="break-all">
                {String(protectedResponse.route_label ?? protectedResponse.route_canonical ?? '—')}
              </code>
            </div>
            <div>
              <span className="font-medium">receipt_id:</span>{' '}
              <code className="break-all">{String(protectedResponse.receipt_id ?? '—')}</code>
            </div>
            <div>
              <span className="font-medium">payer:</span>{' '}
              <code className="break-all">{String(protectedResponse.payer ?? '—')}</code>
            </div>
            <div>
              <span className="font-medium">amount_wei:</span>{' '}
              <code>{String(protectedResponse.amount_wei ?? '—')}</code>
            </div>
            <div>
              <span className="font-medium">chain_id:</span>{' '}
              <code>{String(protectedResponse.chain_id ?? '—')}</code>
            </div>
            <div>
              <span className="font-medium">tx_hash:</span>{' '}
              <code className="break-all">{result.txHash}</code>
            </div>
            <div>
              <span className="font-medium">protected_at:</span>{' '}
              <code>{String(protectedResponse.protected_at ?? '—')}</code>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
