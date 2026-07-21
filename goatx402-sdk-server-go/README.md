# GOAT Flow Go Server SDK

Server-side Go client for authenticated GOAT Flow merchant APIs.

The client coordinates API records and reads reported results. It does not move
or control buyer funds; DIRECT transfers go from the buyer wallet to the
merchant receiving address.

Module:

```text
github.com/goatnetwork/goatx402-sdk-server
```

## Install

This Go module is source-only in this repository and is outside the npm release
runbook. For a sibling application, bind the module path to the checked-in
directory before resolving it:

```bash
go mod edit -replace=github.com/goatnetwork/goatx402-sdk-server=../goatx402-sdk-server-go
go get github.com/goatnetwork/goatx402-sdk-server
```

The checked-in module declares Go 1.25.

## Configure

```go
client := goatx402.NewClient(goatx402.Config{
    BaseURL:  os.Getenv("GOATX402_API_URL"),
    APIKey:   os.Getenv("GOATX402_API_KEY"),
    APISecret: os.Getenv("GOATX402_API_SECRET"),
})
```

Keep the API Secret on the server. The client signs authenticated requests with
`X-API-Key`, `X-Timestamp`, `X-Nonce`, and `X-Sign`.

## Create an Order

```go
order, err := client.CreateOrder(ctx, goatx402.CreateOrderParams{
    DappOrderID:  "order-123",
    ChainID:      48816,
    TokenSymbol:  "USDC",
    TokenContract: "0xToken",
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
session, err := client.CreateCheckoutSession(ctx, goatx402.CreateCheckoutSessionParams{
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
uses `DIRECT`. The types retain DELEGATE and legacy fixed-wei fields for
operator-provisioned compatibility deployments.
`CreateDelegateCheckoutSession` is a deprecated wrapper. Do not infer merchant
availability from these exports.

## Other Operations

| Method | Purpose |
| --- | --- |
| `GetOrderStatus` | Read the current order state |
| `GetOrderProof` | Retrieve proof after the deployment makes it available |
| `SubmitCalldataSignature` | Submit an operator-provisioned EIP-712 callback signature |
| `CancelOrder` | Request cancellation of an eligible order |
| `GetMerchant` | Public merchant lookup; no HMAC credentials required |
| `SetHTTPClient` | Supply a custom `http.Client` |

`WaitForConfirmation` currently returns on `PAYMENT_CONFIRMED`, `FAILED`,
`EXPIRED`, or `CANCELLED`. It does **not** treat `INVOICED` as terminal;
`INVOICED` semantics are deployment-defined. The helper waits one interval
before its first read and suppresses `GetOrderStatus` errors until a later poll,
timeout, or context cancellation.

Compatibility caveat: the authenticated request helper accepts HTTP `402` for
every method, although only order creation defines `402` as success. Treat an
unexpected `402` from checkout, status, proof, signature, or cancellation as
version skew and validate the response shape.

## Runtime Configuration

Do not hardcode chain, token, fee, expiry, or confirmation assumptions. Read the
active API response, x402 challenge, and merchant configuration.

See:

- [API Reference](../docs/goat-flow-api-reference.md)
- [Developer Quick Start](../docs/goat-flow-developer-quickstart.md)
- [Integration Guide](../docs/goat-flow-integration.md)
