# GOAT Flow API Compatibility Page

This root-level file is retained so existing repository and package links keep
working. The canonical API documentation now lives under `docs/`.

Use:

- [API Reference](./docs/goat-flow-api-reference.md) for endpoints, HMAC signing,
  request/response shapes, status values, QuickPay, MPP, and error semantics.
- [Developer Quick Start](./docs/goat-flow-developer-quickstart.md) for a first
  working integration.
- [Integration Guide](./docs/goat-flow-integration.md) for SDK boundaries,
  fulfillment, retries, and production guidance.
- [Hosted Checkout](./docs/goat-flow-checkout.md) for product and session checkout.
- [GOAT Flow MPP Integration](./docs/mpp.md) for the independent MPP protocol
  boundary and this deployment's paid-route and receipt profile.

Compatibility notes:

- Published package names, types, JSON fields, and `GOATX402_*` environment
  variables retain their existing `goatx402` naming.
- Merchant API credentials and HMAC signing belong on the backend.
- HTTP `402` is an expected success only for endpoints documented as payment
  challenges, including order creation and the GOAT Flow profile's MPP
  challenge endpoint. This does not redefine the standard MPP HTTP exchange.
- Runtime challenge, manifest, merchant, and portal configuration is
  authoritative for enabled chains, tokens, limits, fees, and capabilities.

Do not copy API schemas from historical revisions of this file. Update the
canonical [API Reference](./docs/goat-flow-api-reference.md) instead.
