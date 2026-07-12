import { inspect, type InspectResult } from './inspect.js'
import { loadManifest } from './manifest.js'
import {
  payMpp,
  payProduct,
  payX402,
  type PayMppOptions,
  type PayMppResult,
  type PayProductOptions,
  type PayX402Options,
  type PayX402Result,
} from './pay.js'
import type { LoadedManifest } from './types.js'

export interface QuickPayClientOptions {
  /** QuickPay web, agent.md, or manifest.json URL. */
  input: string
  /** Injectable fetch for tests or hardened runtimes. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type QuickPayPayX402Options = Omit<PayX402Options, 'input' | 'fetchImpl'> & {
  fetchImpl?: typeof fetch
}

export type QuickPayPayProductOptions = Omit<PayProductOptions, 'input' | 'fetchImpl'> & {
  fetchImpl?: typeof fetch
}

export type QuickPayPayMppOptions = Omit<PayMppOptions, 'input' | 'fetchImpl'> & {
  fetchImpl?: typeof fetch
}

/**
 * Library-first facade for QuickPay public payer/agent flows.
 *
 * The client stores only the trusted input link and optional fetch implementation.
 * Wallet / chain effects stay explicit through the injected PaymentBackend or
 * MppBackend passed to payX402/payMpp.
 */
export class QuickPayClient {
  readonly input: string
  private readonly fetchImpl?: typeof fetch

  constructor(input: string, opts?: Omit<QuickPayClientOptions, 'input'>)
  constructor(opts: QuickPayClientOptions)
  constructor(
    inputOrOpts: string | QuickPayClientOptions,
    opts: Omit<QuickPayClientOptions, 'input'> = {},
  ) {
    if (typeof inputOrOpts === 'string') {
      this.input = inputOrOpts
      this.fetchImpl = opts.fetchImpl
      return
    }
    this.input = inputOrOpts.input
    this.fetchImpl = inputOrOpts.fetchImpl
  }

  loadManifest(fetchImpl: typeof fetch = this.fetchImpl ?? fetch): Promise<LoadedManifest> {
    return loadManifest(this.input, fetchImpl)
  }

  inspect(fetchImpl: typeof fetch = this.fetchImpl ?? fetch): Promise<InspectResult> {
    return inspect(this.input, fetchImpl)
  }

  payX402(opts: QuickPayPayX402Options): Promise<PayX402Result> {
    return payX402({
      ...opts,
      input: this.input,
      fetchImpl: opts.fetchImpl ?? this.fetchImpl,
    })
  }

  payProduct(opts: QuickPayPayProductOptions): Promise<PayX402Result> {
    return payProduct({
      ...opts,
      input: this.input,
      fetchImpl: opts.fetchImpl ?? this.fetchImpl,
    })
  }

  payMpp(opts: QuickPayPayMppOptions): Promise<PayMppResult> {
    return payMpp({
      ...opts,
      input: this.input,
      fetchImpl: opts.fetchImpl ?? this.fetchImpl,
    })
  }
}
