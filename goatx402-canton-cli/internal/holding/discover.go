// Package holding resolves the source-Holding contract id the CLI submits in
// POST /api/v1/orders. Resolution precedence per PLAN.md §3.2.4:
//
//	(1) explicit --source-holding flag
//	(2) env SOURCE_HOLDING_CID
//	(3) topup-fixture file ${HOME}/.goat-canton/source-holding.json
//	(4) error MISSING_SOURCE_HOLDING
//
// The fixture file is a JSON object mapping partyId -> Canton Holding cid; it
// is materialised by scripts/canton-up.sh whenever the bound payer's Holding
// is re-minted (one entry per party). E2E (scripts/e2e-smoke.sh) writes it
// before the CLI runs so the happy path is zero-config.
package holding

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrMissing is returned when none of the precedence layers yields a cid.
// The CLI maps this to the MISSING_SOURCE_HOLDING runbook exit.
var ErrMissing = errors.New("MISSING_SOURCE_HOLDING")

// ResolveInput bundles the inputs Discover needs. Tests inject HomeDir and
// ReadFile so the precedence ladder can be exercised without touching the
// real filesystem.
type ResolveInput struct {
	// Flag is the value of --source-holding (highest precedence). Empty
	// string means the flag was not set.
	Flag string

	// Env is the value of $SOURCE_HOLDING_CID. Empty means unset.
	Env string

	// Payer is the Canton party id whose Holding we want; the fixture file
	// is a per-party map.
	Payer string

	// HomeDir overrides $HOME for fixture lookup. Empty falls back to
	// os.UserHomeDir().
	HomeDir string

	// ReadFile lets tests inject fixture contents. nil falls back to
	// os.ReadFile.
	ReadFile func(string) ([]byte, error)
}

// Result names which precedence layer satisfied the lookup. Useful for
// machine-readable diagnostics in JSON output.
type Result struct {
	ContractID string
	Source     string // "flag" | "env" | "fixture"
}

// Discover walks the precedence ladder and returns the first non-empty value.
// Returns ErrMissing if none of the layers produced a cid.
func Discover(in ResolveInput) (Result, error) {
	if in.Flag != "" {
		return Result{ContractID: in.Flag, Source: "flag"}, nil
	}
	if in.Env != "" {
		return Result{ContractID: in.Env, Source: "env"}, nil
	}
	if in.Payer == "" {
		return Result{}, ErrMissing
	}
	cid, err := readFixture(in)
	if err != nil {
		return Result{}, ErrMissing
	}
	if cid == "" {
		return Result{}, ErrMissing
	}
	return Result{ContractID: cid, Source: "fixture"}, nil
}

// FixturePath returns the canonical filesystem path the fixture lookup uses
// for a given home directory. Exported for the runbook diagnostic so error
// messages name the same path the operator will look at.
func FixturePath(home string) string {
	return filepath.Join(home, ".goat-canton", "source-holding.json")
}

func readFixture(in ResolveInput) (string, error) {
	home := in.HomeDir
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		home = h
	}
	path := FixturePath(home)
	readFile := in.ReadFile
	if readFile == nil {
		readFile = os.ReadFile
	}
	data, err := readFile(path)
	if err != nil {
		return "", err
	}
	var fixture map[string]string
	if err := json.Unmarshal(data, &fixture); err != nil {
		return "", fmt.Errorf("fixture %s malformed: %w", path, err)
	}
	cid, ok := fixture[in.Payer]
	if !ok {
		return "", nil
	}
	return cid, nil
}
