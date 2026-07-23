/**
 * GOAT Flow Demo Backend Server
 *
 * This server handles GOAT Flow API calls securely, keeping API credentials on the backend.
 */

import express from 'express'
import cors from 'cors'
import { GoatFlowClient } from 'goatflow-sdk-server'
import 'dotenv/config'
// `@goatnetwork/mpp-middleware` is loaded LAZILY inside the
// mppConfigured branch below — see the comment in mountMPPProtectedRoute.
// Top-level imports (even when wrapped in `await import('literal')`)
// trigger tsc TS2307 in a fresh checkout because the middleware's
// dist/express.d.ts is gitignored. A runtime-constructed specifier
// avoids both TS resolution and Node module-cache pre-resolve, so
// Classic-only deployments need neither the .d.ts nor the .js
// artefacts present.
type Algorithm = 'ed25519' | 'hmac-sha256'

// Narrow shape we use from the lazy middleware. Declared inline so
// no `import type` makes tsc resolve the package at compile time.
type VerifyConfig = {
  merchantId: string
  routeCanonical: string
  algorithm: Algorithm
  ed25519Public?: Uint8Array
  hmacSecret?: Uint8Array
}
type VerifyResult =
  | { ok: true; receipt: MPPReceiptShape }
  | { ok: false; status: 401 | 402 | 503; reason: string; detail?: string }
type VerifyReceipt = (cfg: VerifyConfig, header: string) => Promise<VerifyResult>
type MPPMiddlewareModule = { verifyReceipt: VerifyReceipt }

// Minimal local shape for the receipt the lazy middleware attaches
// to req. The middleware package itself augments
// express-serve-static-core to add req.mppReceipt globally, but we
// avoid importing the package's .d.ts (see comment near the
// imports). Instead the /api/mpp/protected handler casts req to
// RequestWithReceipt at the single read site below — keeps the
// boundary local without resurrecting the cross-package
// build-time dependency.
interface MPPReceiptShape {
  receipt_id?: string
  payer_addr?: string
  amount_wei?: string
  token_contract?: string
  chain_id?: number
  request_canonical?: string
  block_number?: number
}
type RequestWithReceipt = express.Request & {
  mppReceipt?: MPPReceiptShape
  mppRouteOption?: MPPRouteOption
}

const app = express()
const port = process.env.PORT || 3001

// Middleware. exposedHeaders includes Payment-Receipt so a future
// cross-origin caller of this demo backend (e.g. a third-party host
// embedding the demo) can still read it from /api/mpp/protected
// responses. The current /api/mpp/protected route consumes the header
// but does not emit one — the cross-origin read path that matters most
// is Core's /mpp/v1/verify, where Core's CORS config (Phase 2 B-0)
// handles the expose-headers list directly.
app.use(
  cors({
    origin: true,
    credentials: false,
    exposedHeaders: ['Payment-Receipt'],
  }),
)
app.use(express.json())

const GOATX402_API_URL = process.env.GOATX402_API_URL || 'http://localhost:8286'

// Create GOAT Flow client
const goatx402Client = new GoatFlowClient({
  baseUrl: GOATX402_API_URL,
  apiKey: process.env.GOATX402_API_KEY || '',
  apiSecret: process.env.GOATX402_API_SECRET || '',
})

// Merchant ID from environment
const merchantId = process.env.GOATX402_MERCHANT_ID || 'demo_merchant'

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Get app config (supported chains and tokens from merchant)
app.get('/api/config', async (_req, res) => {
  try {
    const merchant = await goatx402Client.getMerchant(merchantId)

    // Group tokens by chain
    const chains: Record<
      number,
      {
        chainId: number
        name: string
        tokens: Array<{ symbol: string; contract: string }>
      }
    > = {}

    // Chain name mapping
    const chainNames: Record<number, string> = {
      97: 'BSC Testnet',
      56: 'BSC Mainnet',
      48816: 'Goat Testnet',
      1: 'Ethereum',
      137: 'Polygon',
    }

    for (const token of merchant.supportedTokens) {
      if (!chains[token.chainId]) {
        chains[token.chainId] = {
          chainId: token.chainId,
          name: chainNames[token.chainId] || `Chain ${token.chainId}`,
          tokens: [],
        }
      }
      chains[token.chainId].tokens.push({
        symbol: token.symbol,
        contract: token.tokenContract,
      })
    }

    res.json({
      merchantId: merchant.merchantId,
      merchantName: merchant.name,
      receiveType: merchant.receiveType,
      chains: Object.values(chains),
    })
  } catch (error) {
    console.error('Get config error:', error)
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get config',
    })
  }
})

// Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { chainId, tokenSymbol, tokenContract, fromAddress, amountWei, callbackCalldata } =
      req.body

    if (!chainId || !tokenSymbol || !tokenContract || !fromAddress || !amountWei) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const order = await goatx402Client.createOrder({
      dappOrderId: `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
      callbackCalldata,
    })

    // Return order to frontend (includes payment instructions)
    res.json({
      orderId: order.orderId,
      flow: order.flow,
      payToAddress: order.payToAddress,
      expiresAt: order.expiresAt,
      calldataSignRequest: order.calldataSignRequest,
      // Include original params for frontend display
      chainId,
      tokenSymbol,
      tokenContract,
      fromAddress,
      amountWei,
    })
  } catch (error: unknown) {
    console.error('Create order error:', error)
    const errObj = error as { status?: number; responseBody?: unknown }
    const status = errObj.status || 500
    // Include responseBody for debugging
    if (errObj.responseBody) {
      console.error('Response body:', errObj.responseBody)
    }
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to create order',
      details: errObj.responseBody,
    })
  }
})

// Get order status
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params
    const order = await goatx402Client.getOrderStatus(orderId)
    res.json(order)
  } catch (error: unknown) {
    console.error('Get order error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get order',
    })
  }
})

// Submit calldata signature
app.post('/api/orders/:orderId/signature', async (req, res) => {
  try {
    const { orderId } = req.params
    const { signature } = req.body

    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' })
    }

    await goatx402Client.submitCalldataSignature(orderId, signature)
    res.json({ success: true })
  } catch (error: unknown) {
    console.error('Submit signature error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to submit signature',
    })
  }
})

// Get merchant info
app.get('/api/merchants/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params
    const merchant = await goatx402Client.getMerchant(merchantId)
    res.json(merchant)
  } catch (error: unknown) {
    console.error('Get merchant error:', error)
    const status = (error as { status?: number }).status || 500
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to get merchant',
    })
  }
})

// ============================================================================
// DELEGATE hosted-checkout demo wiring — CROSS-CHAIN PRICE MODE (web3-free merchant).
//
// The browser sends ONLY a product_key. The SERVER pins a token-agnostic USD `price`.
// The PLATFORM derives the callback chain (from the merchant's callback contract) and the
// payable (source chain, token) candidates; the buyer picks any listed source chain+token
// on the hosted page; the amount is computed server-side as price*10^decimals; settlement
// /callback stays on the merchant's single callback chain. NO web3 on the merchant side: a
// product may OPTIONALLY declare a callback template (signature + static args) which the
// hosted page ABI-encodes into calldata at bind — signed/executed on the callback chain,
// independent of the source chain. No template → no calldata (buyer just transfers).
// See docs/DELEGATE_CHECKOUT_CROSSCHAIN_PLAN.md.
//
// Gated behind DELEGATE_ENABLED=1 (the demo's GOATX402_* key must be a DELEGATE merchant
// with a callback contract; the callback CHAIN is derived server-side, not configured here):
//   - off → GET /api/delegate-config { enabled:false }; POST create → 501.
//   - on  → the backend mints a unified DELEGATE price session via the server SDK; the
//           merchant is derived from the API key (HMAC), never the request body.
// ============================================================================

const delegateConfigured = (process.env.DELEGATE_ENABLED ?? '').trim() === '1'
const DELEGATE_SUCCESS_URL = process.env.DELEGATE_SUCCESS_URL ?? ''
const DELEGATE_CANCEL_URL = process.env.DELEGATE_CANCEL_URL ?? ''
const DELEGATE_NOT_CONFIGURED_MSG = 'DELEGATE checkout not configured (set DELEGATE_ENABLED=1 for a DELEGATE merchant)'

// Server-side product catalog: the browser picks a product_key; the SERVER owns the USD
// price. The token + source chain are chosen by the buyer on the hosted page from the
// candidates the platform derives; the amount is price*10^decimals(chosen token).
interface DelegateProduct {
  name: string
  description: string
  image: string
  priceUsd: string
  // OPTIONAL merchant callback. When set, the hosted checkout page ABI-encodes it into
  // callback_calldata at bind (the merchant site stays web3-free — it only declares the
  // function signature + static args). The cross-chain order carries it; the calldata is
  // signed + executed on the merchant's CALLBACK chain, independent of the source chain the
  // buyer pays on. `payer` is a zero-address placeholder (the contract uses originalPayer).
  callbackTemplate?: { signature: string; args: unknown[] }
}
const DELEGATE_CATALOG: Record<string, DelegateProduct> = {
  mug: {
    name: 'Coffee Mug',
    description: 'A sturdy ceramic mug. Pay with any listed token on any listed chain.',
    image: 'https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=480&q=60',
    priceUsd: '1.00',
  },
  tee: {
    name: 'Cotton T-Shirt',
    description: 'Soft combed-cotton tee. Cross-chain checkout WITH a callback.',
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=480&q=60',
    priceUsd: '3.50',
    // Demonstrates a calldata callback: MerchantCallback.testCallback fires on settlement (on
    // the merchant's callback chain) and merely `emit`s TestCallbackExecuted(payer,value,message)
    // — none of the args are enforced. payer is a zero-address placeholder (the contract resolves
    // the real buyer via originalPayer). `value` = the on-chain payment amount in the token's
    // smallest unit: 3500000 = $3.50 at 6 decimals, which matches bound_amount_wei for EVERY one
    // of this merchant's candidate tokens (all 6-decimal USDC/USDT stablecoins).
    // CAVEAT: a STATIC template can encode only one decimals assumption. If a non-6-decimal token
    // (e.g. 18-dec DAI) ever became a candidate, this value would diverge from the real transfer;
    // the general fix is for the hosted page to substitute the bind-computed bound_amount_wei.
    callbackTemplate: {
      signature: 'testCallback(address payer, uint256 value, string message)',
      args: ['0x0000000000000000000000000000000000000000', '3500000', 'Cotton T-Shirt ($3.50) — cross-chain DELEGATE checkout'],
    },
  },
}

// Brand shown on the hosted checkout (DELEGATE merchants have no QuickPay discovery, so we
// pass branding via public_metadata).
const DELEGATE_MERCHANT_BRAND = {
  name: 'Acme Store (demo)',
  logo: 'https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=160&q=60',
}

// Frontend asks whether the DELEGATE section should be shown.
app.get('/api/delegate-config', (_req, res) => {
  res.json({ enabled: delegateConfigured })
})

// Catalog for the frontend to render (server owns price + display data).
app.get('/api/delegate-catalog', (_req, res) => {
  if (!delegateConfigured) {
    return res.status(501).json({ error: DELEGATE_NOT_CONFIGURED_MSG })
  }
  res.json({
    merchant: DELEGATE_MERCHANT_BRAND,
    products: Object.entries(DELEGATE_CATALOG).map(([product_key, p]) => ({
      product_key,
      name: p.name,
      description: p.description,
      image: p.image,
      price_usd: p.priceUsd,
    })),
  })
})

// Mint a server-authoritative cross-chain DELEGATE PRICE session. The browser sends ONLY
// product_key; the server pins the USD price + line item + brand. The platform derives the
// callback chain + payable (source chain, token) candidates. NO web3, NO calldata here.
app.post('/api/create-delegate-checkout', async (req, res) => {
  if (!delegateConfigured) {
    return res.status(501).json({ error: DELEGATE_NOT_CONFIGURED_MSG })
  }
  const productKey = typeof req.body?.product_key === 'string' ? req.body.product_key : 'mug'
  const product = DELEGATE_CATALOG[productKey]
  if (!product) {
    return res.status(400).json({ error: `unknown product_key: ${productKey}` })
  }
  try {
    // Correlation reference (echoed back on the webhook / redirect).
    const clientReferenceId = `demo-delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const session = await goatx402Client.createCheckoutSession({
      checkoutType: 'DELEGATE',
      price: product.priceUsd, // cross-chain price mode: no chain/token/amount; calldata (if any) is a template the hosted page encodes
      successUrl: DELEGATE_SUCCESS_URL || undefined,
      cancelUrl: DELEGATE_CANCEL_URL || undefined,
      clientReferenceId,
      lineItems: [
        {
          name: product.name,
          description: product.description,
          image: product.image,
          amount: `$${product.priceUsd}`,
          quantity: 1,
        },
      ],
      publicMetadata: {
        merchant_name: DELEGATE_MERCHANT_BRAND.name,
        merchant_logo: DELEGATE_MERCHANT_BRAND.logo,
        product_key: productKey,
        // OPTIONAL: the hosted page encodes this into callback_calldata at bind (web3-free
        // merchant). Omitted when the product has no callback → plain no-calldata settlement.
        ...(product.callbackTemplate ? { callback_template: product.callbackTemplate } : {}),
      },
    })
    res.json({ checkout_id: session.checkoutId, url: session.url })
  } catch (error: unknown) {
    console.error('Create delegate checkout error:', error)
    const errObj = error as { status?: number; responseBody?: unknown }
    const status = errObj.status || 500
    if (errObj.responseBody) {
      console.error('Response body:', errObj.responseBody)
    }
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to create delegate checkout',
      details: errObj.responseBody,
    })
  }
})

// ============================================================================
// MPP (Machine Payments Protocol) demo wiring.
//
// The MPP mode is OPTIONAL — if MPP_CORE_URL / MPP_MERCHANT_ID /
// MPP_RECEIPT_KEY_HEX are not configured, the /api/mpp/protected route
// is not mounted and /api/mpp/config returns 503. This lets the classic
// demo flow keep working in any deployment that hasn't completed MPP
// bootstrap (see MPP_DEMO_PLAN.md §B-7 + MPP_TEMPO_TESTNET_TESTING.md).
//
// The buyer-side flow runs entirely in the browser via MPPClient from
// goatflow-sdk; this backend's only MPP responsibilities are:
//   - publish core_url / merchant_id / route options to the frontend
//     (so the SDK knows where to send /challenge + /verify);
//   - host Payment-Receipt-protected routes the frontend can hit once
//     verify returns 200, to demonstrate end-to-end receipt consumption.
// ============================================================================

const MPP_CORE_URL = process.env.MPP_CORE_URL ?? ''
const MPP_MERCHANT_ID = process.env.MPP_MERCHANT_ID ?? ''
const MPP_ROUTE_OPTIONS_RAW = process.env.MPP_ROUTE_OPTIONS ?? ''
const MPP_RECEIPT_KEY_HEX = process.env.MPP_RECEIPT_KEY_HEX ?? ''
const MPP_RECEIPT_ALG_RAW = (process.env.MPP_RECEIPT_ALG ?? 'ed25519').trim()

interface MPPRouteOption {
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

interface CoreMPPRoute {
  route_canonical?: unknown
  route_pricing_version?: unknown
  chain_id?: unknown
  token_contract?: unknown
  token_symbol?: unknown
  token_decimals?: unknown
  amount_wei?: unknown
}

const mppRouteCanonicalRegex = /^[A-Za-z0-9._:~-]{1,200}$/
const mppRouteOptionIDRegex = /^[A-Za-z0-9_-]{1,300}$/

function routeOptionIDForRouteCanonical(routeCanonical: string): string {
  return `route-${Buffer.from(routeCanonical, 'utf8').toString('base64url')}`
}

function routeCanonicalFromOptionID(id: string): string | null {
  if (!id.startsWith('route-')) return null
  try {
    const decoded = Buffer.from(id.slice('route-'.length), 'base64url').toString('utf8')
    return mppRouteCanonicalRegex.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

function labelFromRouteCanonical(routeCanonical: string): string {
  const parts = routeCanonical.split(':').filter(Boolean)
  return parts[parts.length - 1] || routeCanonical
}

function formatAtomicAmount(amountWei: string, decimals: number): string {
  if (!/^[0-9]+$/.test(amountWei) || !Number.isInteger(decimals) || decimals < 0) {
    return amountWei
  }
  try {
    const value = BigInt(amountWei)
    if (decimals === 0) return value.toString()
    const divisor = 10n ** BigInt(decimals)
    const whole = value / divisor
    const fraction = value % divisor
    const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
    return fractionText ? `${whole}.${fractionText}` : whole.toString()
  } catch {
    return amountWei
  }
}

function parseMPPRouteOptions(raw: string): { options: MPPRouteOption[]; error?: string } {
  if (raw.trim() === '') {
    return { options: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      options: [],
      error: `MPP_ROUTE_OPTIONS must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!Array.isArray(parsed)) {
    return { options: [], error: 'MPP_ROUTE_OPTIONS must be a JSON array' }
  }

  const ids = new Set<string>()
  const routes = new Set<string>()
  const options: MPPRouteOption[] = []
  for (const [idx, item] of parsed.entries()) {
    if (!item || typeof item !== 'object') {
      return { options: [], error: `MPP_ROUTE_OPTIONS[${idx}] must be an object` }
    }
    const obj = item as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    const label = typeof obj.label === 'string' ? obj.label.trim() : ''
    const routeCanonical =
      typeof obj.routeCanonical === 'string'
        ? obj.routeCanonical.trim()
        : typeof obj.route_canonical === 'string'
        ? obj.route_canonical.trim()
        : ''

    if (!mppRouteOptionIDRegex.test(id)) {
      return { options: [], error: `MPP_ROUTE_OPTIONS[${idx}].id must match ${mppRouteOptionIDRegex.source}` }
    }
    if (ids.has(id)) {
      return { options: [], error: `MPP_ROUTE_OPTIONS has duplicate id "${id}"` }
    }
    if (!label) {
      return { options: [], error: `MPP_ROUTE_OPTIONS[${idx}].label is required` }
    }
    if (!mppRouteCanonicalRegex.test(routeCanonical)) {
      return {
        options: [],
        error: `MPP_ROUTE_OPTIONS[${idx}].routeCanonical must match ${mppRouteCanonicalRegex.source}`,
      }
    }
    if (routes.has(routeCanonical)) {
      return { options: [], error: `MPP_ROUTE_OPTIONS has duplicate routeCanonical "${routeCanonical}"` }
    }

    const option: MPPRouteOption = { id, label, routeCanonical }
    if (typeof obj.description === 'string' && obj.description.trim()) {
      option.description = obj.description.trim()
    }
    if (typeof obj.amount === 'string' && obj.amount.trim()) {
      option.amount = obj.amount.trim()
    }
    if (typeof obj.amountWei === 'string' && obj.amountWei.trim()) {
      option.amountWei = obj.amountWei.trim()
    } else if (typeof obj.amount_wei === 'string' && obj.amount_wei.trim()) {
      option.amountWei = obj.amount_wei.trim()
    }
    if (typeof obj.token === 'string' && obj.token.trim()) {
      option.token = obj.token.trim()
    }
    if (typeof obj.tokenContract === 'string' && obj.tokenContract.trim()) {
      option.tokenContract = obj.tokenContract.trim()
    } else if (typeof obj.token_contract === 'string' && obj.token_contract.trim()) {
      option.tokenContract = obj.token_contract.trim()
    }
    if (typeof obj.tokenDecimals === 'number' && Number.isInteger(obj.tokenDecimals)) {
      option.tokenDecimals = obj.tokenDecimals
    } else if (typeof obj.token_decimals === 'number' && Number.isInteger(obj.token_decimals)) {
      option.tokenDecimals = obj.token_decimals
    }
    if (typeof obj.chainId === 'number' && Number.isFinite(obj.chainId)) {
      option.chainId = obj.chainId
    } else if (typeof obj.chain_id === 'number' && Number.isFinite(obj.chain_id)) {
      option.chainId = obj.chain_id
    }

    ids.add(id)
    routes.add(routeCanonical)
    options.push(option)
  }

  if (options.length === 0) {
    return { options: [], error: 'MPP_ROUTE_OPTIONS must contain at least one option' }
  }
  return { options }
}

const parsedManualMPPRouteOptions = parseMPPRouteOptions(MPP_ROUTE_OPTIONS_RAW)
const rememberedMPPRouteOptions = new Map<string, MPPRouteOption>()

function rememberMPPRouteOptions(options: MPPRouteOption[]): MPPRouteOption[] {
  for (const option of options) {
    rememberedMPPRouteOptions.set(option.id, option)
  }
  return options
}

function coreMPPRouteToOption(route: CoreMPPRoute): MPPRouteOption | null {
  const routeCanonical =
    typeof route.route_canonical === 'string' ? route.route_canonical.trim() : ''
  if (!mppRouteCanonicalRegex.test(routeCanonical)) return null

  const amountWei = typeof route.amount_wei === 'string' ? route.amount_wei.trim() : ''
  const tokenDecimals =
    typeof route.token_decimals === 'number' && Number.isInteger(route.token_decimals)
      ? route.token_decimals
      : undefined
  const token = typeof route.token_symbol === 'string' ? route.token_symbol.trim() : ''
  const chainId =
    typeof route.chain_id === 'number' && Number.isFinite(route.chain_id)
      ? route.chain_id
      : undefined
  const tokenContract =
    typeof route.token_contract === 'string' ? route.token_contract.trim() : ''

  return {
    id: routeOptionIDForRouteCanonical(routeCanonical),
    label: labelFromRouteCanonical(routeCanonical),
    routeCanonical,
    description: 'Merchant configured MPP route',
    amount: amountWei && tokenDecimals != null ? formatAtomicAmount(amountWei, tokenDecimals) : amountWei,
    amountWei,
    token: token || undefined,
    tokenContract: tokenContract || undefined,
    tokenDecimals,
    chainId,
  }
}

async function fetchCoreMPPRouteOptions(): Promise<MPPRouteOption[]> {
  const baseURL = (MPP_CORE_URL || GOATX402_API_URL).replace(/\/$/, '')
  if (!baseURL || !MPP_MERCHANT_ID) return []
  const url = `${baseURL}/merchants/${encodeURIComponent(MPP_MERCHANT_ID)}/mpp/routes`
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      console.warn(`MPP route discovery skipped: GET ${url} returned HTTP ${response.status}`)
      return []
    }
    const body = (await response.json()) as { routes?: CoreMPPRoute[] }
    const routes = Array.isArray(body.routes) ? body.routes : []
    return routes.map(coreMPPRouteToOption).filter((option): option is MPPRouteOption => !!option)
  } catch (err) {
    console.warn(
      `MPP route discovery skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

async function loadMPPRouteOptions(): Promise<MPPRouteOption[]> {
  if (parsedManualMPPRouteOptions.error) {
    throw new Error(parsedManualMPPRouteOptions.error)
  }
  if (parsedManualMPPRouteOptions.options.length > 0) {
    return rememberMPPRouteOptions(parsedManualMPPRouteOptions.options)
  }
  const coreOptions = await fetchCoreMPPRouteOptions()
  if (coreOptions.length > 0) {
    return rememberMPPRouteOptions(coreOptions)
  }
  // No manual override and discovery returned nothing: fail loud instead of
  // advertising a phantom default route that would 404 at the challenge step.
  // Routes are merchant-configured in Core (admin -> Merchants -> MPP).
  throw new Error(
    `no MPP routes configured for merchant "${MPP_MERCHANT_ID}" — create one in the admin MPP page (or set MPP_ROUTE_OPTIONS to override)`,
  )
}

async function loadMPPRouteOptionByID(id: string): Promise<MPPRouteOption | null> {
  const live = await loadMPPRouteOptions()
  const liveOption = live.find((option) => option.id === id)
  if (liveOption) return liveOption

  const decodedRouteCanonical = routeCanonicalFromOptionID(id)
  if (decodedRouteCanonical) {
    const liveRouteOption = live.find((option) => option.routeCanonical === decodedRouteCanonical)
    if (liveRouteOption) return liveRouteOption
  }

  const remembered = rememberedMPPRouteOptions.get(id)
  if (remembered) return remembered

  return null
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/, '')
  if (clean.length === 0) throw new Error('hex key is empty')
  if (clean.length % 2 !== 0) throw new Error('hex key has odd length')
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('hex key contains non-hex characters')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16)
  }
  return bytes
}

const mppConfigured = MPP_CORE_URL !== '' && MPP_MERCHANT_ID !== '' && MPP_RECEIPT_KEY_HEX !== ''

// mppReady is the runtime gate the /api/mpp/config endpoint reads.
// It flips to true ONLY after the protected route is successfully
// mounted (middleware import succeeds + receipt verifier config
// validates). If anything in that pipeline fails, mppReady stays
// false and /api/mpp/config returns 503 — the SDK will not initiate
// a payment that the merchant cannot honour. The mppReadyReason is
// surfaced in the 503 body so operators can see *why* MPP is gated
// off without reading server logs.
let mppReady = false
// Only consulted when mppConfigured is true (the not-configured case
// has its own dedicated 503 code emitted directly in the /api/mpp/config
// handler). Initial value reflects the wiring-in-progress state in case
// /api/mpp/config is somehow hit before the async mount completes —
// although start() awaits the mount before listen, so in practice the
// only times mppReady stays false are mount failures.
let mppReadyReason = 'MPP wiring in progress'

// Frontend asks for the live MPP config rather than baking it into the
// bundle, so a misconfigured deployment surfaces the failure
// declaratively (503) instead of throwing inside the SDK at runtime.
//
// Two distinct 503 codes — the frontend rendered them differently so
// operators get the right diagnosis:
//   - "mpp_not_configured": operator hasn't set the MPP_* env vars at
//     all. UI shows the "set MPP_CORE_URL / … in .env to enable" hint.
//   - "mpp_not_ready": env vars are set but the wiring (middleware
//     import, receipt verifier config) failed. UI shows the
//     actionable detail string verbatim.
app.get('/api/mpp/config', async (_req, res) => {
  if (!mppConfigured) {
    return res.status(503).json({
      error: 'mpp_not_configured',
      detail: 'MPP_CORE_URL / MPP_MERCHANT_ID / MPP_RECEIPT_KEY_HEX env vars not set',
    })
  }
  if (!mppReady) {
    return res.status(503).json({ error: 'mpp_not_ready', detail: mppReadyReason })
  }
  try {
    const routeOptions = await loadMPPRouteOptions()
    const defaultRoute = routeOptions[0]
    res.json({
      coreUrl: MPP_CORE_URL,
      merchantId: MPP_MERCHANT_ID,
      routeCanonical: defaultRoute.routeCanonical,
      routeOptions,
    })
  } catch (err) {
    res.status(503).json({
      error: 'mpp_routes_unavailable',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
})

async function mountMPPProtectedRoute(): Promise<void> {
  if (parsedManualMPPRouteOptions.error) {
    throw new Error(parsedManualMPPRouteOptions.error)
  }
  if (MPP_RECEIPT_ALG_RAW !== 'ed25519' && MPP_RECEIPT_ALG_RAW !== 'hmac-sha256') {
    throw new Error(
      `MPP_RECEIPT_ALG must be "ed25519" or "hmac-sha256", got "${MPP_RECEIPT_ALG_RAW}"`,
    )
  }
  const algorithm = MPP_RECEIPT_ALG_RAW as Algorithm
  let receiptKey: Uint8Array
  try {
    receiptKey = hexToBytes(MPP_RECEIPT_KEY_HEX)
  } catch (err) {
    throw new Error(
      `MPP_RECEIPT_KEY_HEX is invalid: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Fail-fast on the obvious length mistakes BEFORE the middleware
  // validates, so the startup error message points the operator at the
  // env var rather than the middleware internal.
  if (algorithm === 'ed25519' && receiptKey.length !== 32) {
    throw new Error(
      `MPP_RECEIPT_KEY_HEX (ed25519) must decode to 32 bytes, got ${receiptKey.length}. ` +
        'Pass the public key (32 bytes), not the full ed25519 private key (64 bytes).',
    )
  }
  if (algorithm === 'hmac-sha256' && receiptKey.length < 32) {
    throw new Error(
      `MPP_RECEIPT_KEY_HEX (hmac-sha256) must decode to at least 32 bytes, got ${receiptKey.length}.`,
    )
  }

  // Dynamic import with a runtime-constructed specifier. The constant string
  // is assigned to a non-literal variable so neither tsc nor Node's module
  // loader pre-resolves it; the package is only touched when this function
  // actually runs (mppConfigured=true). A missing middleware build then
  // manifests as a clear "build it" warning and 503 on the protected route,
  // NOT a compile error blocking Classic-only builds on fresh checkouts.
  const mppMiddlewareSpec: string = '@goatnetwork/mpp-middleware'
  let verifyReceipt: VerifyReceipt
  try {
    const mod = (await import(mppMiddlewareSpec)) as MPPMiddlewareModule
    verifyReceipt = mod.verifyReceipt
  } catch (err) {
    throw new Error(
      `@goatnetwork/mpp-middleware could not be loaded — build it: cd ../goatx402-mpp-middleware-ts && pnpm build. Underlying: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const verifierConfig =
    algorithm === 'ed25519'
      ? { algorithm: 'ed25519' as const, ed25519Public: receiptKey }
      : { algorithm: 'hmac-sha256' as const, hmacSecret: receiptKey }

  const verifyProtectedReceipt =
    (resolveOption: (req: express.Request) => Promise<MPPRouteOption | null>): express.RequestHandler =>
    async (req, res, next) => {
      let option: MPPRouteOption | null
      try {
        option = await resolveOption(req)
      } catch (err) {
        res.status(503).json({
          error: 'mpp_routes_unavailable',
          detail: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (!option) {
        res.status(404).json({ error: 'mpp_route_option_not_found' })
        return
      }

      const raw = req.headers['payment-receipt']
      if (raw === undefined || raw === '') {
        res.status(401).json({ error: 'payment_required' })
        return
      }
      if (Array.isArray(raw)) {
        res.status(401).json({ error: 'invalid_payment_receipt' })
        return
      }

      try {
        const result = await verifyReceipt(
          {
            merchantId: MPP_MERCHANT_ID,
            routeCanonical: option.routeCanonical,
            ...verifierConfig,
          },
          raw,
        )
        if (!result.ok) {
          res.status(result.status).json({ error: result.reason })
          return
        }
        const reqWithReceipt = req as RequestWithReceipt
        reqWithReceipt.mppReceipt = result.receipt
        reqWithReceipt.mppRouteOption = option
        next()
      } catch (err) {
        console.error('MPP receipt verification failed unexpectedly:', err)
        res.status(500).json({ error: 'internal_error' })
      }
    }

  const protectedHandler: express.RequestHandler = (req, res) => {
    const reqWithReceipt = req as RequestWithReceipt
    const receipt = reqWithReceipt.mppReceipt
    const option = reqWithReceipt.mppRouteOption
    if (!option) {
      // verifyProtectedReceipt always attaches the option before next();
      // reaching here means the middleware chain was bypassed.
      res.status(500).json({ error: 'internal_error' })
      return
    }
    res.json({
      message: 'Protected resource accessed',
      route_option_id: option.id,
      route_label: option.label,
      route_canonical: option.routeCanonical,
      receipt_id: receipt?.receipt_id,
      payer: receipt?.payer_addr,
      amount_wei: receipt?.amount_wei,
      token_contract: receipt?.token_contract,
      chain_id: receipt?.chain_id,
      request_canonical: receipt?.request_canonical,
      block_number: receipt?.block_number,
      protected_at: new Date().toISOString(),
    })
  }

  app.get(
    '/api/mpp/protected',
    verifyProtectedReceipt(async () => {
      const options = await loadMPPRouteOptions()
      return options[0]
    }),
    protectedHandler,
  )

  app.get(
    '/api/mpp/protected/:optionId',
    verifyProtectedReceipt(async (req) => loadMPPRouteOptionByID(req.params.optionId)),
    protectedHandler,
  )
}

async function start(): Promise<void> {
  // Resolve the MPP mount BEFORE binding the listener. mppReady has to
  // settle to its final true/false state before the first
  // /api/mpp/config request can arrive — otherwise the frontend's
  // single-fetch hook latches "MPP not configured" on a transient
  // "MPP wiring in progress" 503 and the operator has to reload the
  // page once the dynamic import resolves. The mount is fast
  // (dynamic import + Express route registration); the small added
  // boot latency is worth eliminating the startup race entirely.
  if (mppConfigured) {
    try {
      await mountMPPProtectedRoute()
      mppReady = true
      mppReadyReason = 'ok'
    } catch (err) {
      mppReadyReason = err instanceof Error ? err.message : String(err)
      console.error('MPP not ready:', mppReadyReason)
    }
  }

  app.listen(port, () => {
    console.log(`Demo server running at http://localhost:${port}`)

    // Warn if credentials are missing
    if (!process.env.GOATX402_API_KEY || !process.env.GOATX402_API_SECRET) {
      console.warn('Warning: GOATX402_API_KEY and/or GOATX402_API_SECRET not set')
      console.warn('Please create a .env file with your credentials')
    }
    if (mppConfigured) {
      if (mppReady) {
        console.log(
          `MPP demo mode ready (core=${MPP_CORE_URL}, merchant=${MPP_MERCHANT_ID}, route discovery=${parsedManualMPPRouteOptions.options.length > 0 ? 'env' : 'core'})`,
        )
      } else {
        console.log(
          `MPP demo mode requested but NOT ready (${mppReadyReason}); /api/mpp/config will 503 until fixed`,
        )
      }
    } else {
      console.log(
        'MPP demo mode disabled (set MPP_CORE_URL, MPP_MERCHANT_ID, MPP_RECEIPT_KEY_HEX to enable)',
      )
    }
  })
}

void start().catch((err) => {
  console.error('Demo server failed to start:', err)
  process.exit(1)
})
