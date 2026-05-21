package api

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
)

// DevSourceHoldingDeps wires the v0-only fixture-file fallback the SPA + CLI
// can call when neither `--source-holding` nor the env var is set
// (PLAN.md §3.2.5). The endpoint is registered always but returns
// 410 ENDPOINT_RETIRED under CANTON_PROD=true so SDKs can distinguish "v0-
// only endpoint retired" from "no such route".
type DevSourceHoldingDeps struct {
	FixturePath string
	TokenStore  middleware.PayerTokenStore
	CantonProd  bool
	// ReadFile lets tests inject a deterministic fixture without touching the
	// filesystem.
	ReadFile func(path string) ([]byte, error)
}

type sourceHoldingResponse struct {
	Payer                   string `json:"payer"`
	SourceHoldingContractID string `json:"sourceHoldingContractId"`
}

// DevSourceHoldingHandler returns GET /api/v1/dev/source-holding.
func DevSourceHoldingHandler(d DevSourceHoldingDeps) http.HandlerFunc {
	if d.ReadFile == nil {
		d.ReadFile = os.ReadFile
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, ErrInvalidInput, "method not allowed")
			return
		}
		if d.CantonProd {
			writeError(w, http.StatusGone, ErrEndpointRetired,
				"dev source-holding retired under CANTON_PROD=true")
			return
		}
		payer := r.URL.Query().Get("payer")
		if payer == "" {
			writeError(w, http.StatusBadRequest, ErrInvalidInput, "payer query param required")
			return
		}
		tok := r.Header.Get(middleware.HeaderXPayerToken)
		ok, code := middleware.AssertBoundToParty(tok, payer, d.TokenStore)
		if !ok {
			status := http.StatusUnauthorized
			ec := ErrUnauthenticated
			if code == "PAYER_NOT_BOUND" {
				status = http.StatusForbidden
				ec = ErrPayerNotBound
			}
			writeError(w, status, ec, "X-Payer-Token check failed")
			return
		}
		data, err := d.ReadFile(d.FixturePath)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, ErrLedgerUnavailable, "fixture not available")
			return
		}
		var fixture map[string]string
		if err := json.Unmarshal(data, &fixture); err != nil {
			writeError(w, http.StatusServiceUnavailable, ErrLedgerUnavailable, "fixture malformed")
			return
		}
		cid, ok2 := fixture[payer]
		if !ok2 || cid == "" {
			writeError(w, http.StatusNotFound, ErrOrderNotFound, "no source holding for payer")
			return
		}
		writeJSON(w, http.StatusOK, sourceHoldingResponse{
			Payer:                   payer,
			SourceHoldingContractID: cid,
		})
	}
}
