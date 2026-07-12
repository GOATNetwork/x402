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

// Integer-string (base-unit wei) shape. Format-only; the trusted origin is the
// authority on the values themselves.
const WEI_INT_RE = /^\d+$/

// product_key mirrors Core's bound (^[A-Za-z0-9._:~-]{1,64}$); '.'/'..' are
// rejected so the key can never normalize a URL path segment.
const PRODUCT_KEY_RE = /^[A-Za-z0-9._:~-]{1,64}$/
// A token-agnostic decimal price string (e.g. "9.99"). Bounds mirror Core's
// product schema (quickPayPriceRegex: up to 40 integer + 18 fractional digits) so
// the client rejects the same malformed/version-skewed prices Core would, rather
// than admitting them and failing late. Per-token representability (does the price
// fit the CHOSEN token's decimals?) is still enforced at pay time by toWei.
const PRICE_DECIMAL_RE = /^\d{1,40}(\.\d{1,18})?$/

// isValidHttpsImageURL parses the value as a REAL URL (not a prefix check): https
// scheme, a non-empty host, no embedded credentials, within a sane length bound. A
// tampered/skewed manifest must not be able to surface "https://" or "https://"+garbage
// to a UI/agent as if it were a safe, well-formed image link.
function isValidHttpsImageURL(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048) return false
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return false
  }
  return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === ''
}

// validateX402Token fails closed on a malformed x402 token. These fields flow
// straight onto the money path — chain_id selects the network, decimals scales
// the amount, token_contract is the transfer target, min/max bound it — so a
// shape violation must be caught on ingest, not at transfer time. (Address FORMAT
// is intentionally not checked here: the manifest comes from the trusted,
// same-origin merchant core, and the value is cross-checked against the session's
// x402 terms before broadcast.)
function validateX402Token(t: unknown, idx: number): void {
  const where = `rails.x402.tokens[${idx}]`
  if (!t || typeof t !== 'object') throw new Error(`${where} is not an object`)
  const tk = t as Record<string, unknown>
  if (typeof tk.chain_id !== 'number' || !Number.isInteger(tk.chain_id) || tk.chain_id <= 0) {
    throw new Error(`${where}.chain_id must be a positive integer`)
  }
  if (typeof tk.token_symbol !== 'string' || tk.token_symbol.trim() === '') {
    throw new Error(`${where}.token_symbol must be a non-empty string`)
  }
  if (typeof tk.token_contract !== 'string' || tk.token_contract.trim() === '') {
    throw new Error(`${where}.token_contract must be a non-empty string`)
  }
  if (typeof tk.decimals !== 'number' || !Number.isInteger(tk.decimals) || tk.decimals < 0 || tk.decimals > 36) {
    throw new Error(`${where}.decimals must be an integer in [0, 36]`)
  }
  if (typeof tk.min_amount_wei !== 'string' || !WEI_INT_RE.test(tk.min_amount_wei)) {
    throw new Error(`${where}.min_amount_wei must be an integer string`)
  }
  if (tk.max_amount_wei !== undefined) {
    if (typeof tk.max_amount_wei !== 'string' || !WEI_INT_RE.test(tk.max_amount_wei)) {
      throw new Error(`${where}.max_amount_wei must be an integer string when present`)
    }
    // min_amount_wei is a validated integer string above; reject an inverted band
    // so a max<min token can't advertise an impossible range onto the money path.
    if (BigInt(tk.max_amount_wei as string) < BigInt(tk.min_amount_wei as string)) {
      throw new Error(`${where}.max_amount_wei must be >= min_amount_wei`)
    }
  }
}

// validateMPPRoute fails closed on a malformed MPP route. payMpp matches on
// route_canonical and passes route_canonical + chain_id to the backend (which
// selects the network and builds the payment), so a shape violation on those
// money-path fields must be caught on ingest, not at pay time. token_symbol /
// amount_wei are display fields, validated for parity with the x402 token check.
function validateMPPRoute(r: unknown, idx: number): void {
  const where = `rails.mpp.routes[${idx}]`
  if (!r || typeof r !== 'object') throw new Error(`${where} is not an object`)
  const rt = r as Record<string, unknown>
  if (typeof rt.route_canonical !== 'string' || rt.route_canonical.trim() === '') {
    throw new Error(`${where}.route_canonical must be a non-empty string`)
  }
  if (typeof rt.chain_id !== 'number' || !Number.isInteger(rt.chain_id) || rt.chain_id <= 0) {
    throw new Error(`${where}.chain_id must be a positive integer`)
  }
  if (typeof rt.token_symbol !== 'string' || rt.token_symbol.trim() === '') {
    throw new Error(`${where}.token_symbol must be a non-empty string`)
  }
  if (typeof rt.amount_wei !== 'string' || !WEI_INT_RE.test(rt.amount_wei)) {
    throw new Error(`${where}.amount_wei must be an integer string`)
  }
}

// validateX402Product fails closed on a malformed product. product_key + price
// flow onto the money path (payProduct sends product_key and INDEPENDENTLY
// recomputes price * 10^decimals to verify the server's terms), so a shape
// violation must be caught on ingest, not at pay time. name/image_url are display
// fields, but image_url is constrained to https so a tampered manifest can't point
// a UI at an attacker resource.
function validateX402Product(p: unknown, idx: number): void {
  const where = `rails.x402.products[${idx}]`
  if (!p || typeof p !== 'object') throw new Error(`${where} is not an object`)
  const pr = p as Record<string, unknown>
  if (typeof pr.product_key !== 'string' || !PRODUCT_KEY_RE.test(pr.product_key) || pr.product_key === '.' || pr.product_key === '..') {
    throw new Error(`${where}.product_key must match ^[A-Za-z0-9._:~-]{1,64}$ and not be '.'/'..'`)
  }
  if (typeof pr.name !== 'string' || pr.name.trim() === '') {
    throw new Error(`${where}.name must be a non-empty string`)
  }
  // description is optional but, when present, must be a string within Core's bound
  // (<=2000 runes) — reject a non-string / oversized value rather than passing it
  // through to callers that the public type promises a string.
  if (pr.description !== undefined && (typeof pr.description !== 'string' || [...pr.description].length > 2000)) {
    throw new Error(`${where}.description must be a string of at most 2000 characters when present`)
  }
  // Positivity without float parsing: the price matched the digits-and-dot shape
  // above, so it is > 0 iff it contains a non-zero digit ("0"/"0.00" are rejected).
  if (typeof pr.price !== 'string' || !PRICE_DECIMAL_RE.test(pr.price) || !/[1-9]/.test(pr.price)) {
    throw new Error(`${where}.price must be a positive decimal string (<=40 integer, <=18 fractional digits)`)
  }
  if (pr.image_url !== undefined && !isValidHttpsImageURL(pr.image_url)) {
    throw new Error(`${where}.image_url must be a valid https:// URL (real host, no credentials, <=2048 chars) when present`)
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
  const x402Tokens = Array.isArray(x402.tokens) ? x402.tokens : []
  // A present-but-non-array `products` (e.g. an object or string) is malformed manifest
  // data, NOT "no products" — reject it (fail closed) rather than silently coerce to [].
  // Otherwise an invalid manifest would be classified as valid and slip past both the
  // per-product validation below and the "tolerate an invalid manifest only for
  // explicit-key recovery" rule in payProduct.
  if (x402.products !== undefined && !Array.isArray(x402.products)) {
    throw new Error('rails.x402.products must be an array when present')
  }
  const x402Products = x402.products ?? []
  const mppRoutes = Array.isArray(mpp.routes) ? mpp.routes : []
  // Validate token rail entries on ingest when that rail is enabled (the only case
  // those entries are used to build a payment).
  if (x402.enabled) {
    x402Tokens.forEach((t: unknown, i: number) => validateX402Token(t, i))
  }
  // Products are validated whenever PRESENT, regardless of x402.enabled: inspect
  // surfaces them and payProduct's explicit-key recovery path reads them even on a
  // disabled rail, so a malformed product must fail closed on ingest rather than be
  // handed to a caller (or agent) typed as a valid string.
  x402Products.forEach((p: unknown, i: number) => validateX402Product(p, i))
  if (mpp.enabled) {
    mppRoutes.forEach((r: unknown, i: number) => validateMPPRoute(r, i))
  }
  return {
    schema: m.schema,
    merchant: {
      merchant_id: m.merchant.merchant_id,
      display_name: m.merchant.display_name,
      logo_url: m.merchant.logo_url,
    },
    links: m.links,
    rails: {
      x402: { enabled: !!x402.enabled, custom_amount: x402.custom_amount, memo_required: !!x402.memo_required, session_endpoint: x402.session_endpoint, tokens: x402Tokens, products: x402Products },
      mpp: { enabled: !!mpp.enabled, challenge_endpoint: mpp.challenge_endpoint, verify_endpoint: mpp.verify_endpoint, routes: mppRoutes },
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
