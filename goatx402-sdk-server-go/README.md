# GOAT Flow Go Server SDK

Server-side Go client for authenticated GOAT Flow merchant APIs.

The client coordinates API records and reads reported results. It does not move
or control buyer funds; DIRECT transfers go from the buyer wallet to the
merchant receiving address.

Module:

```text
github.com/goatnetwork/goatflow-sdk-server
```

## Install

This Go module is source-only in this repository, is outside the npm release
runbook, and is not published from a standalone source repository. Clone
`GOATNetwork/x402`, then bind the logical module path to the checked-in
directory:

```bash
go mod edit -require=github.com/goatnetwork/goatflow-sdk-server@v0.0.0
go mod edit -replace=github.com/goatnetwork/goatflow-sdk-server=../x402/goatx402-sdk-server-go
```

Add the import shown below, then run `go mod tidy`. The checked-in module
declares Go 1.25.

## Configure

```go
import goatflow "github.com/goatnetwork/goatflow-sdk-server"

client := goatflow.NewClient(goatflow.Config{
    BaseURL:  os.Getenv("GOATX402_API_URL"),
    APIKey:   os.Getenv("GOATX402_API_KEY"),
    APISecret: os.Getenv("GOATX402_API_SECRET"),
})
```

Keep the API Secret on the server. The client signs authenticated requests with
`X-API-Key`, `X-Timestamp`, `X-Nonce`, and `X-Sign`.

## Create an Order

```go
order, err := client.CreateOrder(ctx, goatflow.CreateOrderParams{
    DappOrderID:  "order-123",
    ChainID:      48816,
    TokenSymbol:  "USDC",
    FromAddress:  "0xPayer",
    AmountWei:    "100000",
})
if err != nil {
    return err
}

fmt.Println(order.OrderID, order.PayToAddress, order.AmountWei)
```

`CreateOrder` accepts the API's normal HTTP `402 Payment Required` response and
normalizes the x402 challenge into `Order`. Use `CreateOrderRaw` when the complete
challenge object is required.

For an explicitly operator-provisioned compatibility flow,
`CallbackCalldata` may return a `CalldataSignRequest` and optional
`SignatureEndpoint`. Submit the browser signature with
`SubmitCalldataSignature`. This is not part of the current public DIRECT
onboarding path; see the API Reference for the complete field contract.

## Hosted Checkout

```go
session, err := client.CreateCheckoutSession(ctx, goatflow.CreateCheckoutSessionParams{
    CheckoutType: "DIRECT",
    Price:         "9.99",
    SuccessURL:    "https://merchant.example/pay/success",
    CancelURL:     "https://merchant.example/pay/cancel",
})
if err != nil {
    return err
}

http.Redirect(w, r, session.URL, http.StatusFound)
```

Nested checkout values are JSON-stringified by the client before HMAC signing.
`CheckoutSession.CheckoutType` is a string; the current public merchant path
uses `DIRECT`. The types retain compatibility-only fields and
`CreateDelegateCheckoutSession` as a deprecated wrapper for explicitly
operator-provisioned deployments. Do not infer merchant availability from these
exports. The complete compatibility field mapping and callback trust boundary
live in the
[API Reference appendix](../docs/goat-flow-api-reference.md#appendix-a-operator-provisioned-callback-compatibility).

## Other Operations

| Method | Purpose |
| --- | --- |
| `GetOrderStatus` | Read the current order state |
| `GetOrderProof` | Retrieve the server-issued payment record |
| `SubmitCalldataSignature` | Submit an operator-provisioned EIP-712 callback signature |
| `CancelOrder` | Request cancellation of an eligible order |
| `GetMerchant` | Public merchant lookup; no HMAC credentials required |
| `SetHTTPClient` | Supply a custom `http.Client` |

`WaitForConfirmation` returns on successful `PAYMENT_CONFIRMED` or `INVOICED`,
and on `FAILED`, `EXPIRED`, or `CANCELLED`. Core can move a DIRECT order from
`PAYMENT_CONFIRMED` to `INVOICED` in one watcher transaction, so a poller may
observe only `INVOICED`. The helper waits one interval before its first read and
suppresses transient `GetOrderStatus` errors until a later poll, timeout, or
context cancellation.

Every request uses the configured HTTP client's deadline; the default client
timeout is 30 seconds. HTTP `402` is accepted as the expected response only for
order creation. Checkout, status, proof, signature, and cancellation fail
closed on an unexpected `402`.

`GetOrderProof` returns a server-issued payment record whose historical
`Signature` field is not a signature or attestation. It is the Keccak256 digest
of `order_id`, `tx_hash`, `log_index`, `from_addr`, `to_addr`, `amount_wei`, and
`from_chain_id`, concatenated in that exact order without separators. It does
not cover `status`. Verify `Payload.TxHash` on-chain when independent proof is
required.

## Runtime Configuration

Do not hardcode chain, token, fee, expiry, or confirmation assumptions. Read the
active API response, x402 challenge, and merchant configuration.

See:

- [API Reference](../docs/goat-flow-api-reference.md)
- [Developer Quick Start](../docs/goat-flow-developer-quickstart.md)
- [Integration Guide](../docs/goat-flow-integration.md)
