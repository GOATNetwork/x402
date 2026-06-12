// Fastify plugin adapter. Exposed as a preHandler-style hook factory so
// callers can register it on a route or routeContext without pulling in
// fastify-plugin (which would require a hard dep).

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from "fastify";
import type { Receipt } from "./receipt.js";
import {
  type VerifyConfig,
  type RejectReason,
  validateConfig,
  verifyReceipt,
} from "./verify.js";

declare module "fastify" {
  interface FastifyRequest {
    mppReceipt?: Receipt;
  }
}

/** Header name used for the Payment-Receipt value. */
export const PAYMENT_RECEIPT_HEADER = "payment-receipt";

/** Optional rejection-hook callback for logging / metrics. */
export type FastifyRejectCallback = (
  req: FastifyRequest,
  reason: RejectReason,
  detail: string | undefined,
) => void;

export type FastifyMppPluginOptions = VerifyConfig & {
  onReject?: FastifyRejectCallback;
};

/**
 * Returns a preHandler hook that enforces the receipt checks. This is
 * usually the right granularity for Fastify — register per-route so
 * each route has its own routeCanonical:
 *
 *   app.get("/widget", { preHandler: fastifyPreHandler({ ...cfg }) }, h);
 */
export function fastifyPreHandler(
  cfg: FastifyMppPluginOptions,
): preHandlerHookHandler {
  validateConfig(cfg);
  return async function preHandler(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const raw = req.headers[PAYMENT_RECEIPT_HEADER];
    if (raw === undefined || raw === "") {
      // Round-16 codex P2: absent header is the `payment_required`
      // case in the Go middleware and the MPP wire contract — see
      // middleware-express.ts for the full rationale.
      if (cfg.onReject) cfg.onReject(req, "payment_required", "missing header");
      reply.code(401).send({ error: "payment_required" });
      return;
    }
    if (Array.isArray(raw)) {
      if (cfg.onReject) cfg.onReject(req, "invalid_payment_receipt", "duplicate header");
      reply.code(401).send({ error: "invalid_payment_receipt" });
      return;
    }
    const result = await verifyReceipt(cfg, raw);
    if (!result.ok) {
      if (cfg.onReject) cfg.onReject(req, result.reason, result.detail);
      reply.code(result.status).send({ error: result.reason });
      return;
    }
    req.mppReceipt = result.receipt;
  };
}

/**
 * Fastify plugin form. Registers a global preHandler hook that enforces
 * the receipt checks on every route in the encapsulated scope. For
 * per-route configuration prefer fastifyPreHandler.
 *
 * Usage with encapsulation:
 *   app.register(fastifyPlugin, { merchantId, routeCanonical, ... });
 *
 * NOTE: Without `fastify-plugin`, this plugin is encapsulated — its
 * hook is scoped to the registering app/instance, not parent scopes.
 * That is the safer default for a security middleware: it cannot leak
 * into routes the operator did not intend to protect.
 */
export const fastifyPlugin: FastifyPluginAsync<FastifyMppPluginOptions> =
  async (app: FastifyInstance, opts: FastifyMppPluginOptions) => {
    const handler = fastifyPreHandler(opts);
    app.addHook("preHandler", handler);
  };
