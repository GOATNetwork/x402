# GOAT Flow Go MPP middleware

This Go module is distributed as source inside the canonical
[`GOATNetwork/x402`](https://github.com/GOATNetwork/x402) repository. It is not
published from a standalone repository, so a direct `go get` of its logical
module path will not work.

Clone the source next to your application:

```bash
git clone https://github.com/GOATNetwork/x402.git
```

Then add the logical dependency and a local replacement to your application's
`go.mod`:

```go
require github.com/goatnetwork/goatflow-mpp-middleware-go v0.0.0

replace github.com/goatnetwork/goatflow-mpp-middleware-go => ../x402/goatx402-mpp-middleware-go
```

Adjust the relative path for your checkout, run `go mod tidy`, and import the
package normally:

```go
import mppmiddleware "github.com/goatnetwork/goatflow-mpp-middleware-go"
```

The local `replace` directive is required until this module has an independently
published source location.
