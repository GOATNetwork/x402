package canton

// errors.go centralises the §6.2 error-map sentinels the transport layer
// surfaces and the HTTP layer (internal/api) re-classifies into the public
// error envelope.

// InvalidInputError is the sentinel the package emits for InvalidArgument-
// class transport errors (gRPC code InvalidArgument, Daml type-checker
// failures, etc.). The HTTP layer maps this to 400 INVALID_INPUT per the
// PLAN.md §6.2 error map.
type InvalidInputError struct{ Cause error }

func (e *InvalidInputError) Error() string {
	if e == nil || e.Cause == nil {
		return "canton: invalid input"
	}
	return "canton: invalid input: " + e.Cause.Error()
}

func (e *InvalidInputError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}
