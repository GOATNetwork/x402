// x402-canton is the headless x402 CLI client described in PLAN.md §3.2.4.
// One invocation completes the full round trip and prints the receipt + final
// merchant body in either JSON (default) or human-readable form.
//
// Flags (per PLAN.md Task 12):
//
//	--merchant         merchant base URL (required)
//	--facilitator      facilitator base URL (defaults to the 402 envelope's value)
//	--payer            Canton party id of payer (required)
//	--amount           override the 402 envelope amount
//	--source-holding   Canton Holding cid (flag > $SOURCE_HOLDING_CID > fixture)
//	--payer-token      X-Payer-Token (flag > $PAYER_TOKEN > exit MISSING_PAYER_TOKEN)
//	--resource         path on the merchant to fetch (default /resource)
//	--output           json | human (default json)
//
// Exit codes (machine-readable so e2e-smoke.sh and CI can branch on them):
//
//	0   round trip OK
//	2   MISSING_PAYER_TOKEN     — no --payer-token or PAYER_TOKEN env
//	3   MISSING_SOURCE_HOLDING  — no --source-holding, no env, no fixture
//	1   any other failure (the JSON body carries the upstream error code)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/goatnetwork/goatx402-canton-cli/internal/flow"
	"github.com/goatnetwork/goatx402-canton-cli/internal/holding"
	"github.com/goatnetwork/goatx402-canton-cli/internal/output"
)

const (
	exitGeneric              = 1
	exitMissingPayerToken    = 2
	exitMissingSourceHolding = 3
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		os.Exit(translateExitCode(err))
	}
}

// runError carries an exit-code hint so main() can map it to os.Exit() while
// keeping run() testable.
type runError struct {
	code int
	msg  string
}

func (e *runError) Error() string { return e.msg }

func translateExitCode(err error) int {
	var re *runError
	if errors.As(err, &re) {
		return re.code
	}
	return exitGeneric
}

func run(argv []string, stdout, stderr *os.File) error {
	fs := flag.NewFlagSet("x402-canton", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		merchantURL    = fs.String("merchant", "", "merchant base URL (required)")
		facilitatorURL = fs.String("facilitator", "", "facilitator base URL (defaults to the 402 envelope value)")
		payer          = fs.String("payer", "", "Canton party id of payer (required)")
		amount         = fs.String("amount", "", "amount override (defaults to the 402 envelope amount)")
		sourceHolding  = fs.String("source-holding", "", "Canton Holding cid; falls back to $SOURCE_HOLDING_CID then ~/.goat-canton/source-holding.json")
		payerToken     = fs.String("payer-token", "", "X-Payer-Token for facilitator auth; falls back to $PAYER_TOKEN")
		resourcePath   = fs.String("resource", "/resource", "merchant resource path to fetch")
		outputMode     = fs.String("output", "json", "json | human")
		timeout        = fs.Duration("timeout", 30*time.Second, "max wall-clock for the whole round trip")
		expiresIn      = fs.Int("expires-in", 120, "order TTL in seconds (max 600)")
	)
	if err := fs.Parse(argv); err != nil {
		return err
	}

	// Resolve payer-token precedence: flag > env > error. We run this BEFORE
	// any HTTP call so the "no token" path never reaches the facilitator
	// (PLAN.md Task 12 acceptance).
	token := *payerToken
	if token == "" {
		token = os.Getenv("PAYER_TOKEN")
	}
	if token == "" {
		writeMissing(stdout, *outputMode,
			"MISSING_PAYER_TOKEN", flow.MissingPayerTokenRunbook,
			"--payer-token not set and $PAYER_TOKEN is empty",
		)
		return &runError{code: exitMissingPayerToken, msg: "MISSING_PAYER_TOKEN"}
	}

	// Resolve source-holding precedence: flag > env > fixture > error.
	sourceRes, err := holding.Discover(holding.ResolveInput{
		Flag:  *sourceHolding,
		Env:   os.Getenv("SOURCE_HOLDING_CID"),
		Payer: *payer,
	})
	if err != nil {
		writeMissing(stdout, *outputMode,
			"MISSING_SOURCE_HOLDING", flow.MissingSourceHoldingRunbook,
			err.Error(),
		)
		return &runError{code: exitMissingSourceHolding, msg: "MISSING_SOURCE_HOLDING"}
	}

	if *merchantURL == "" {
		fmt.Fprintln(stderr, "--merchant is required")
		return &runError{code: exitGeneric, msg: "missing --merchant"}
	}
	if *payer == "" {
		fmt.Fprintln(stderr, "--payer is required")
		return &runError{code: exitGeneric, msg: "missing --payer"}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	cfg := flow.Config{
		MerchantURL:         *merchantURL,
		FacilitatorURL:      *facilitatorURL,
		Payer:               *payer,
		Amount:              *amount,
		SourceHolding:       sourceRes.ContractID,
		SourceHoldingOrigin: sourceRes.Source,
		PayerToken:          token,
		ResourcePath:        *resourcePath,
		X402Version:         1,
		ExpiresIn:           *expiresIn,
		HTTPClient:          &http.Client{Timeout: *timeout},
		Clock:               time.Now,
		PollInterval:        250 * time.Millisecond,
		MaxWait:             *timeout,
	}
	res, runErr := flow.Run(ctx, cfg)
	_ = output.Write(stdout, output.Mode(*outputMode), res)
	if runErr != nil {
		return &runError{code: exitGeneric, msg: runErr.Error()}
	}
	return nil
}

// writeMissing prints an output.Result describing a pre-HTTP miss
// (MISSING_PAYER_TOKEN / MISSING_SOURCE_HOLDING) in the configured mode so
// e2e-smoke.sh can grep the JSON for outcome / runbook.
func writeMissing(stdout *os.File, mode, outcome, runbookText, errMessage string) {
	res := output.Result{
		Outcome:      outcome,
		ErrorMessage: errMessage,
		Runbook:      runbookText,
	}
	_ = output.Write(stdout, output.Mode(mode), res)
}
