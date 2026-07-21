# GOAT Flow Developer Compatibility Page

This root-level file is retained for existing links. The maintained developer
documentation is:

1. [Developer Quick Start](./docs/goat-flow-developer-quickstart.md) for the shortest
   path to a first DIRECT payment.
2. [Integration Guide](./docs/goat-flow-integration.md) for architecture, SDK usage,
   lifecycle handling, and production checks.
3. [API Reference](./docs/goat-flow-api-reference.md) for the wire contract and HMAC
   authentication.
4. [Hosted Checkout](./docs/goat-flow-checkout.md) for fixed products and dynamic
   checkout sessions.
5. [GOAT Flow MPP Integration](./docs/mpp.md) for the independent MPP protocol
   boundary and GOAT Flow's current agent-paid API adapter.
6. [DApp Integration Skill](./docs/goat-flow-dapp-integration/SKILL.md) for
   repository-aware coding-agent integrations.

Compatibility rules:

- Keep `GOATX402_API_SECRET` and merchant signing on the backend.
- Treat browser callbacks as UX events, not fulfillment proof.
- Read payment terms and supported capabilities from runtime responses.
- Preserve existing `goatx402` package and environment-variable names.

Update the canonical documents above instead of adding detailed integration
instructions to this compatibility page.
