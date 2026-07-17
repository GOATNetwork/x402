module github.com/goatnetwork/goatflow-mpp-middleware-go

go 1.22

// Round-17 codex P2: this module is self-contained and standard-
// library-only so downstream merchants can `go get` it without a
// local `replace` directive. The receiptspec subpackage is a vendored
// mirror of github.com/goatnetwork/goatflow-mpp-receipt-spec — see
// receiptspec/doc.go for the drift-prevention contract.
