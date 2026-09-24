import { endpoints, loadManifest } from './manifest.js'

const PRODUCT_KEY_RE = /^[A-Za-z0-9._:~-]{1,64}$/

export interface CreateFiatCheckoutLinkOptions {
  /** QuickPay web, agent.md, or manifest.json URL. Its origin is the trust anchor. */
  input: string
  /** Fixed product to buy. Mutually exclusive with `amount`; the server owns its price. */
  productKey?: string
  /** Human decimal custom amount. Mutually exclusive with `productKey`. */
  amount?: string
  /** Optional custom-payment memo. Product payments pin their own memo and reject this field. */
  memo?: string
  /** Injectable fetch for tests or hardened runtimes. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface FiatCheckoutLink {
  ok: true
  rail: 'fiat'
  merchant_id: string
  checkout_id: string
  url: string
  currency: string
  expires_at: number
  product_key?: string
  /** Always true: this SDK creates a hosted link and never handles card credentials. */
  human_action_required: true
}

function assertAmount(amount: string, exponent: number, currency: string): void {
  const match = amount.match(/^(\d{1,40})(?:\.(\d+))?$/)
  if (!match || !/[1-9]/.test(amount)) {
    throw new Error(`amount must be a positive ${currency} decimal string`)
  }
  if ((match[2]?.length ?? 0) > exponent) {
    throw new Error(`${currency} amount supports at most ${exponent} decimal places`)
  }
}

function assertSameOriginResponse(res: Response, requestURL: string): void {
  if (res.url && new URL(res.url).origin !== new URL(requestURL).origin) {
    throw new Error(`request redirected off-origin to ${res.url}`)
  }
}

function assertHostedCheckoutURL(raw: unknown, origin: string, checkoutID: string): string {
  if (typeof raw !== 'string' || raw.length > 4096) {
    throw new Error('card checkout response missing url')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('card checkout response contains an invalid url')
  }
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('card checkout response url is outside the trusted QuickPay origin')
  }
  // Current cores return /paykit/direct. Older cores return /checkout or /checkout/direct.
  if (!/^\/(?:checkout(?:\/direct)?|paykit\/direct)\/?$/.test(url.pathname) || url.searchParams.get('cs') !== checkoutID) {
    throw new Error('card checkout response url is not the expected hosted checkout')
  }
  return url.toString()
}

/**
 * Creates a fiat-only hosted Checkout link for a human payer. This function never
 * accepts card credentials and never completes the Stripe payment itself.
 */
export async function createFiatCheckoutLink(o: CreateFiatCheckoutLinkOptions): Promise<FiatCheckoutLink> {
  const fetchImpl = o.fetchImpl ?? fetch
  const { manifest, origin, merchantId } = await loadManifest(o.input, fetchImpl)
  const rail = manifest.rails.fiat ?? { enabled: false, human_action_required: false, products: [] }
  if (!rail.enabled) {
    throw new Error('card checkout links are not available for this merchant')
  }
  if (rail.human_action_required !== true) {
    throw new Error('card checkout manifest must require a human to complete payment')
  }
  const currency = rail.currency ?? ''
  const exponent = rail.minor_unit_exponent
  if (!currency || exponent === undefined) {
    throw new Error('card checkout manifest is missing currency terms')
  }

  const productKey = o.productKey?.trim() ?? ''
  const amount = o.amount?.trim() ?? ''
  const memo = o.memo?.trim() ?? ''
  if ((productKey === '') === (amount === '')) {
    throw new Error('provide exactly one of productKey or amount')
  }

  const body: { merchant_id: string; product_key?: string; amount?: string; memo?: string } = {
    merchant_id: merchantId,
  }
  if (productKey) {
    if (!PRODUCT_KEY_RE.test(productKey) || productKey === '.' || productKey === '..') {
      throw new Error('invalid productKey')
    }
    if (memo) {
      throw new Error('product card checkout does not accept memo; the server pins product identity')
    }
    if (!(rail.products ?? []).some((p) => p.product_key === productKey)) {
      throw new Error(`product "${productKey}" is not available on the card rail`)
    }
    body.product_key = productKey
  } else {
    if (rail.custom_amount === false) {
      throw new Error('custom-amount card checkout is not available for this merchant')
    }
    assertAmount(amount, exponent, currency)
    if (rail.memo_required && !memo) {
      throw new Error('this merchant requires a memo; pass --memo <reference>')
    }
    if (Buffer.byteLength(memo, 'utf8') > 256) {
      throw new Error('memo is too long (max 256 bytes)')
    }
    body.amount = amount
    if (memo) body.memo = memo
  }

  const requestURL = endpoints(origin).fiatSessionCreate
  let res: Response
  try {
    res = await fetchImpl(requestURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    })
  } catch (err) {
    throw new Error(`failed to create card checkout link: ${(err as Error).message}`)
  }
  assertSameOriginResponse(res, requestURL)
  const text = await res.text()
  let data: Record<string, unknown>
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {}
  } catch {
    throw new Error(`card checkout creation returned invalid JSON (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? `: ${data.error}` : ''
    throw new Error(`card checkout creation failed (HTTP ${res.status})${detail}`)
  }

  const checkoutID = typeof data.checkout_id === 'string' ? data.checkout_id.trim() : ''
  if (!checkoutID || checkoutID.length > 512) {
    throw new Error('card checkout response missing checkout_id')
  }
  if (data.currency !== currency) {
    throw new Error('card checkout response currency does not match the manifest')
  }
  if (typeof data.expires_at !== 'number' || !Number.isSafeInteger(data.expires_at) || data.expires_at <= 0) {
    throw new Error('card checkout response has an invalid expires_at')
  }

  return {
    ok: true,
    rail: 'fiat',
    merchant_id: merchantId,
    checkout_id: checkoutID,
    url: assertHostedCheckoutURL(data.url, origin, checkoutID),
    currency,
    expires_at: data.expires_at,
    product_key: productKey || undefined,
    human_action_required: true,
  }
}
