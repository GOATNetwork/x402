module github.com/goatnetwork/goatflow-mpp-middleware-go

// Source-only module: this path is not published as a standalone repository.
// Consumers must clone GOATNetwork/x402 and use a local replace directive; see README.md.

go 1.22

// The module is self-contained and standard-library-only. The receiptspec
// subpackage carries the stable receipt contract used by the middleware; see
// receiptspec/doc.go for its drift-prevention rules.
