// Package output formats CLI run results either as a JSON document (default,
// AI-agent flavour: PLAN.md §3.2.4) or as a short human-readable block.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/goatnetwork/goatx402-receipt"
)

// Mode selects the wire format. JSON is the AI-agent default; Human prints a
// concise multi-line block intended for a developer's terminal.
type Mode string

const (
	ModeJSON  Mode = "json"
	ModeHuman Mode = "human"
)

// Result is the machine-readable summary the CLI prints on success. Every
// field here is stable across runs; the JSON output is keyed alphabetically
// because pkg/receipt.CanonicalReceipt is the contract surface, not this
// document.
type Result struct {
	// Outcome is "ok" on success and the runbook code (e.g.
	// MISSING_PAYER_TOKEN) on a non-zero exit.
	Outcome string `json:"outcome"`

	// OrderID is the facilitator's server-side order id.
	OrderID string `json:"orderId,omitempty"`

	// MerchantRequestID is the 402 challenge nonce echoed back.
	MerchantRequestID string `json:"merchantRequestId,omitempty"`

	// SourceHolding describes which precedence layer satisfied the
	// --source-holding discovery (flag / env / fixture).
	SourceHolding *SourceHoldingInfo `json:"sourceHolding,omitempty"`

	// Receipt is the final CantonReceipt the facilitator emitted.
	Receipt *receipt.CantonReceipt `json:"receipt,omitempty"`

	// ResponseBody is the merchant resource body returned on the final
	// 200 (verbatim, UTF-8). Truncated to 4 KiB in JSON mode to keep
	// agent output bounded.
	ResponseBody string `json:"responseBody,omitempty"`

	// ErrorMessage is set for non-ok outcomes; never includes secrets.
	ErrorMessage string `json:"errorMessage,omitempty"`

	// Runbook is the operator-facing single line pointing at the script
	// that fixes the failure (PLAN.md §5.5 format).
	Runbook string `json:"runbook,omitempty"`
}

// SourceHoldingInfo describes which precedence layer satisfied --source-holding.
type SourceHoldingInfo struct {
	ContractID string `json:"contractId"`
	Source     string `json:"source"`
}

// Write renders r to w in the requested mode.
func Write(w io.Writer, mode Mode, r Result) error {
	switch mode {
	case ModeJSON, "":
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(r)
	case ModeHuman:
		return writeHuman(w, r)
	default:
		return fmt.Errorf("output: unknown mode %q", mode)
	}
}

func writeHuman(w io.Writer, r Result) error {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("outcome: %s\n", r.Outcome))
	if r.OrderID != "" {
		b.WriteString(fmt.Sprintf("orderId: %s\n", r.OrderID))
	}
	if r.SourceHolding != nil {
		b.WriteString(fmt.Sprintf("sourceHolding: %s (%s)\n",
			r.SourceHolding.ContractID, r.SourceHolding.Source))
	}
	if r.Receipt != nil {
		b.WriteString(fmt.Sprintf("receipt.transactionId: %s\n", r.Receipt.TransactionID))
		b.WriteString(fmt.Sprintf("receipt.contractId:    %s\n", r.Receipt.ContractID))
		b.WriteString(fmt.Sprintf("receipt.signature:     %s…\n", short(r.Receipt.Signature, 32)))
	}
	if r.ResponseBody != "" {
		b.WriteString("body:\n")
		b.WriteString(r.ResponseBody)
		if !strings.HasSuffix(r.ResponseBody, "\n") {
			b.WriteString("\n")
		}
	}
	if r.ErrorMessage != "" {
		b.WriteString(fmt.Sprintf("error: %s\n", r.ErrorMessage))
	}
	if r.Runbook != "" {
		b.WriteString(fmt.Sprintf("runbook: %s\n", r.Runbook))
	}
	_, err := io.WriteString(w, b.String())
	return err
}

func short(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
