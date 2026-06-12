// Express middleware adapter. Keeping framework adapters as separate
// files (and as separate package entry points) means a Fastify-only
// host does not have to install Express types, and vice versa.

import type { RequestHandler, Request } from "express";
import type { Receipt } from "./receipt.js";
import {
  type VerifyConfig,
  type RejectReason,
  validateConfig,
  verifyReceipt,
} from "./verify.js";

// Augment Express' Request so handlers downstream can read req.mppReceipt
// with strong typing. The cast in the middleware below targets this
// augmented shape.
declare module "express-serve-static-core" {
  interface Request {
    mppReceipt?: Receipt;
  }
}

/**
 * Optional callback invoked on rejection. The middleware will still
 * respond with the appropriate status code; this is a hook for logging
 * / metrics. It is intentionally synchronous so it cannot delay the
 * response.
 */
export type ExpressRejectCallback = (
  req: Request,
  reason: RejectReason,
  detail: string | undefined,
) => void;

/** Header name used for the Payment-Receipt value. Case-insensitive in HTTP. */
export const PAYMENT_RECEIPT_HEADER = "payment-receipt";

/**
 * Builds an Express middleware that enforces the 4+1 receipt checks.
 * Use it per-route (so each route's routeCanonical is correct):
 *
 *   app.get("/widget", expressMiddleware({ ...config }), handler);
 *
 * Or stack it with a router that has a constant route prefix. The
 * configured routeCanonical is the value the receipt's request_canonical
 * must match (or prefix-with-colon).
 */
export function expressMiddleware(
  cfg: VerifyConfig & { onReject?: ExpressRejectCallback },
): RequestHandler {
  // Eagerly validate config so misconfiguration surfaces at startup,
  // not on the first request.
  validateConfig(cfg);

  return (req, res, next) => {
    const raw = req.headers[PAYMENT_RECEIPT_HEADER];
    // Express normalises header names to lowercase; the value may be
    // string | string[] | undefined. Reject array-valued headers (a
    // duplicate Payment-Receipt header is a sign of either a buggy
    // client or a confused-deputy attempt).
    if (raw === undefined || raw === "") {
      // Round-16 codex P2: absent header means "no credential sent",
      // which is the `payment_required` case the Go middleware
      // (validate.go:55) and the MPP wire contract use. Returning
      // `invalid_payment_receipt` here would muddle that with the
      // distinct "credential sent but malformed" case below — merchants
      // and clients keying off the reason code would lose the signal
      // that tells them to fetch a fresh receipt vs. fix a broken one.
      if (cfg.onReject) cfg.onReject(req, "payment_required", "missing header");
      res.status(401).json({ error: "payment_required" });
      return;
    }
    if (Array.isArray(raw)) {
      if (cfg.onReject) cfg.onReject(req, "invalid_payment_receipt", "duplicate header");
      res.status(401).json({ error: "invalid_payment_receipt" });
      return;
    }

    verifyReceipt(cfg, raw)
      .then((result) => {
        if (!result.ok) {
          if (cfg.onReject) cfg.onReject(req, result.reason, result.detail);
          // Round-7 codex P2: respond with the stable reason code only.
          // `detail` is the verifier's free-form text — it can echo
          // attacker-supplied bytes (parse errors carrying the bad input)
          // or internal backend state (e.g. ReceiptIDStore connection
          // errors). Neither belongs in a public HTTP response. Operators
          // get the full detail via the onReject callback for logging /
          // metrics; the wire contract is just `{ "error": <reason> }`.
          res.status(result.status).json({ error: result.reason });
          return;
        }
        req.mppReceipt = result.receipt;
        next();
      })
      .catch((err) => {
        // verifyReceipt should not throw under normal conditions —
        // unexpected throws indicate a programming error. Fail closed.
        if (cfg.onReject) cfg.onReject(req, "invalid_payment_receipt", String(err));
        res.status(500).json({ error: "internal_error" });
      });
  };
}
