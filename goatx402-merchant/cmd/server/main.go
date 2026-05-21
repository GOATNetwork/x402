// Command merchant runs the x402 demo merchant server.
//
// The server gates a single resource path. On a request without
// X-PAYMENT it returns 402 with a canton-daml accepts envelope; on a
// request with a valid CantonReceipt header it serves the protected
// content. See PLAN.md §5.3 / §6.7 for the full contract.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/goatnetwork/goatx402-merchant/internal/api"
	"github.com/goatnetwork/goatx402-merchant/internal/config"
	"github.com/goatnetwork/goatx402-merchant/internal/replay"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(2)
	}
	if err := cfg.Validate(); err != nil {
		logger.Error("config invalid", "err", err)
		os.Exit(2)
	}

	srv := buildServer(cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("merchant listening", "addr", cfg.Addr, "resource", cfg.Resource)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
	}
}

func buildServer(cfg config.Config, logger *slog.Logger) *http.Server {
	now := time.Now

	issuance := replay.NewIssuedNonces(cfg.NonceLRUSize, 2*cfg.ReceiptMaxAge, now)
	replayCache := replay.NewReceiptReplay(cfg.ReceiptReplayLRUSize)

	verifier := &api.Verifier{
		MaxAge:        cfg.ReceiptMaxAge,
		MaxClockSkew:  cfg.ReceiptMaxClockSkew,
		AcceptKeys:    cfg.AcceptKeys,
		ParticipantPK: cfg.ParticipantPubKey,
		Expected: replay.ChallengeTuple{
			Merchant:      cfg.Merchant,
			Resource:      cfg.Resource,
			Amount:        cfg.Amount,
			Currency:      cfg.Currency,
			TrustedIssuer: cfg.TrustedIssuer,
		},
		Issuance:    issuance,
		ReplayCache: replayCache,
		Now:         now,
	}

	resource := &api.Resource{
		MerchantPartyID: cfg.Merchant,
		ResourcePath:    cfg.Resource,
		Amount:          cfg.Amount,
		Currency:        cfg.Currency,
		TrustedIssuer:   cfg.TrustedIssuer,
		FacilitatorURL:  cfg.FacilitatorURL,
		ReceiptMaxBytes: cfg.ReceiptMaxBytes,
		Verifier:        verifier,
		Issuance:        issuance,
		Body:            cfg.Body,
		Logger:          logger,
		Now:             now,
	}

	router := api.NewRouter(api.RouterDeps{
		Resource:       resource,
		ResourceURL:    cfg.Resource,
		CORSOrigins:    cfg.CORSOrigins,
		RateLimitRPS:   cfg.ResourceRateLimitRPS,
		RateLimitBurst: cfg.ResourceRateBurst,
		Now:            now,
	})

	return &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}
}
