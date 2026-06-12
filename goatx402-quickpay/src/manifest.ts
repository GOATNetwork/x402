import type { LoadedManifest, QuickPayManifest, Target } from './types.js'

/**
 * deriveTarget parses a QuickPay link (web page, agent.md, or manifest.json URL)
 * and extracts:
 *   - origin: scheme://host — the TRUST ANCHOR. Every endpoint the CLI calls is
 *     derived from this origin; absolute URLs embedded in the manifest are never
 *     trusted (a malicious manifest could otherwise redirect payments to an
 *     attacker host).
 *   - merchantId: from the trusted URL PATH (not the manifest body).
 *   - manifestUrl: the manifest.json URL on the same origin.
 */
const MERCHANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Canonical QuickPay link path: /quickpay/<merchant_id>[/agent.md|/manifest.json]
const QUICKPAY_PATH_RE = /^\/quickpay\/([^/]+)(?:\/(?:agent\.md|manifest\.json))?$/

export function deriveTarget(input: string): Target {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw new Error(`not a valid URL: ${input}`)
  }
  // The origin is the trust anchor for every endpoint (incl. the session payTo we
  // transfer to), so it must be authenticated transport. Require https; allow
  // plaintext http ONLY for loopback hosts (local dev), never for a remote host
  // where an on-path attacker could MITM the session response and redirect funds.
  const isLoopback =
    u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]'
  if (u.protocol === 'http:') {
    if (!isLoopback) {
      throw new Error(`URL must be https (http is only allowed for localhost): ${input}`)
    }
  } else if (u.protocol !== 'https:') {
    throw new Error(`URL must be https: ${input}`)
  }
  if (u.username || u.password) {
    throw new Error('URL must not contain a userinfo component')
  }
  const origin = u.origin
  // Only accept canonical /quickpay/<merchant_id>[/agent.md|/manifest.json]
  // shapes — never an arbitrary path that merely contains "quickpay".
  const m = u.pathname.match(QUICKPAY_PATH_RE)
  if (!m) {
    throw new Error(`URL must be a /quickpay/<merchant_id>[/agent.md|/manifest.json] link: ${input}`)
  }
  let merchantId: string
  try {
    merchantId = decodeURIComponent(m[1])
  } catch {
    // A malformed percent-escape (e.g. %E0%A4%A) makes decodeURIComponent throw a
    // raw 'URI malformed'; surface a clear, consistent error instead.
    throw new Error(`invalid merchant_id in URL: ${m[1]}`)
  }
  if (!MERCHANT_ID_RE.test(merchantId)) {
    throw new Error(`invalid merchant_id in URL: ${merchantId}`)
  }
  // The manifest URL is ALWAYS the canonical same-origin path, regardless of the
  // exact link the merchant shared.
  const manifestUrl = `${origin}/quickpay/${merchantId}/manifest.json`
  return { manifestUrl, origin, merchantId }
}

/**
 * endpoints returns the canonical QuickPay/MPP endpoints for a trusted origin.
 * These are ALWAYS derived from the origin — the CLI ignores any absolute URLs
 * in the manifest so a tampered manifest cannot redirect requests off-host.
 */
export function endpoints(origin: string) {
  return {
    sessionCreate: `${origin}/quickpay/v1/x402/sessions`,
    sessionStatus: (id: string) => `${origin}/quickpay/v1/x402/sessions/${encodeURIComponent(id)}`,
    discovery: (id: string) => `${origin}/quickpay/v1/merchants/${encodeURIComponent(id)}`,
    // MPPClient appends /mpp/v1/challenge and /mpp/v1/verify to coreUrl.
    mppCoreUrl: origin,
    web: (id: string) => `${origin}/quickpay/${encodeURIComponent(id)}`,
  }
}

/** validateManifest checks the schema tag + required shape and normalizes rails. */
export function validateManifest(obj: unknown): QuickPayManifest {
  if (!obj || typeof obj !== 'object') throw new Error('manifest is not a JSON object')
  const m = obj as Record<string, any>
  if (m.schema !== 'goatx402.quickpay.v1') {
    throw new Error(`unsupported manifest schema: ${String(m.schema)}`)
  }
  if (!m.merchant || typeof m.merchant.merchant_id !== 'string') {
    throw new Error('manifest missing merchant.merchant_id')
  }
  if (!m.rails || typeof m.rails !== 'object') throw new Error('manifest missing rails')
  const x402 = m.rails.x402 ?? { enabled: false, tokens: [] }
  const mpp = m.rails.mpp ?? { enabled: false, routes: [] }
  return {
    schema: m.schema,
    merchant: {
      merchant_id: m.merchant.merchant_id,
      display_name: m.merchant.display_name,
      logo_url: m.merchant.logo_url,
    },
    links: m.links,
    rails: {
      x402: { enabled: !!x402.enabled, custom_amount: x402.custom_amount, memo_required: !!x402.memo_required, session_endpoint: x402.session_endpoint, tokens: Array.isArray(x402.tokens) ? x402.tokens : [] },
      mpp: { enabled: !!mpp.enabled, challenge_endpoint: mpp.challenge_endpoint, verify_endpoint: mpp.verify_endpoint, routes: Array.isArray(mpp.routes) ? mpp.routes : [] },
    },
  }
}

/**
 * loadManifest fetches + validates the manifest for a QuickPay link and enforces
 * the trust anchor: the manifest must self-identify (merchant.merchant_id) as the
 * SAME merchant as the trusted URL path, or the load fails closed.
 */
export async function loadManifest(input: string, fetchImpl: typeof fetch = fetch): Promise<LoadedManifest> {
  const t = deriveTarget(input)
  let res: Response
  try {
    // redirect: 'error' so a same-origin open redirect cannot serve the manifest
    // body from another origin while later calls stay on the trusted origin.
    res = await fetchImpl(t.manifestUrl, { headers: { accept: 'application/json' }, redirect: 'error' })
  } catch (err) {
    throw new Error(`failed to fetch manifest from ${t.manifestUrl}: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new Error(`failed to fetch manifest (HTTP ${res.status}) from ${t.manifestUrl}`)
  }
  // Defense in depth: if the runtime fetch followed a redirect anyway, ensure the
  // final response is still same-origin.
  if (res.url && new URL(res.url).origin !== t.origin) {
    throw new Error(`manifest redirected off-origin to ${res.url}`)
  }
  const manifest = validateManifest(await res.json())
  if (manifest.merchant.merchant_id !== t.merchantId) {
    throw new Error(
      `trust anchor violation: manifest merchant_id "${manifest.merchant.merchant_id}" ` +
        `does not match URL merchant_id "${t.merchantId}"`,
    )
  }
  return { manifest, origin: t.origin, merchantId: t.merchantId }
}
