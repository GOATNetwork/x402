// Package mppmiddleware provides a Go HTTP middleware for verifying
// GOAT Flow MPP (Merchant Payment Protocol) Payment-Receipt headers on
// merchant resource servers.
//
// # Purpose
//
// Merchant servers built in Go can wrap their paid handlers with this
// middleware to enforce that every incoming request carries a valid
// Payment-Receipt header. On any validation failure the middleware
// short-circuits the request with a Problem Details JSON response
// (RFC 7807 style); on success the verified receipt is attached to the
// request context for the downstream handler to inspect.
//
// # Validation Surface
//
// For every protected request the middleware performs the following
// checks, in this order, and rejects on the FIRST failure:
//
//  1. Payment-Receipt header is present and well-formed.
//  2. The receipt signature is cryptographically valid under the
//     configured public key (ed25519) or shared secret (HMAC-SHA256).
//  3. The receipt's merchant_id matches the configured MerchantID
//     (audience binding — prevents cross-merchant replay).
//  4. The receipt's request_canonical is bound to the configured
//     RouteCanonical, either exactly or as a "<route>:<...>" prefix
//     (route binding — prevents cross-resource replay within the same
//     merchant).
//  5. The receipt has not expired (now < receipt_expires_at).
//  6. If a ReceiptIDStore is configured, the receipt_id has not been
//     previously consumed (double-spend defense).
//
// # Module Boundary
//
// This module depends ONLY on the Go standard library and its bundled
// receiptspec package. It deliberately does NOT import any
// goatx402-core internal package — merchant servers must be able to
// vendor this middleware without pulling in platform-internal
// dependencies.
//
// # Stability
//
// The exported API (Config, Middleware, FromContext, ReceiptIDStore)
// follows semantic versioning. The Problem Details "error" field
// values (payment_required, invalid_payment_receipt,
// invalid_signature, audience_mismatch, route_mismatch,
// receipt_expired, receipt_already_consumed) are part of the public
// surface — merchants may key alerting/metrics off them.
package mppmiddleware
