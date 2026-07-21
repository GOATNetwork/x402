// Package main wires the facilitator binary. It is the only place that opens
// files, dials gRPC, and reads env vars; every other facilitator package
// remains I/O-free.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/goatnetwork/goatx402-facilitator/internal/api"
	"github.com/goatnetwork/goatx402-facilitator/internal/api/middleware"
	"github.com/goatnetwork/goatx402-facilitator/internal/canton"
	"github.com/goatnetwork/goatx402-facilitator/internal/config"
	flog "github.com/goatnetwork/goatx402-facilitator/internal/log"
	"github.com/goatnetwork/goatx402-facilitator/internal/metrics"
	"github.com/goatnetwork/goatx402-facilitator/internal/receipt/sign"
	"github.com/goatnetwork/goatx402-facilitator/internal/signer"
	"github.com/goatnetwork/goatx402-facilitator/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "facilitator: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// Build the redacting JSON logger before anything else. Every package
	// that reads slog.Default() (signer, canton client, sweeper, etc.)
	// inherits the §9.2 rule 4 redaction layer this way.
	logger := flog.New(os.Stdout, flog.Options{})
	slog.SetDefault(logger)

	// Metrics bundle — one registry per process, shared with handlers and
	// the completion-demux.
	m := metrics.New()

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}

	// Open the order store. SQLite is the v0 default; PostgreSQL is a v1
	// driver swap at the same DSN seam.
	st, err := store.Open(store.SQLiteOptions{
		DSN:           os.Getenv("STORE_DSN"),
		MigrateOnOpen: true,
	})
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	// Token bindings.
	tokens, err := config.LoadPayerTokens(cfg.PayerTokenFile)
	if err != nil {
		return fmt.Errorf("load payer tokens: %w", err)
	}
	tokenStore := middleware.MapPayerTokenStore(tokens)

	// Payer-key registry.
	registry, err := signer.NewPayerKeyRegistry(cfg.PayerKeyRegistryPath)
	if err != nil {
		return fmt.Errorf("load payer registry: %w", err)
	}

	// Custodial signer (v0 only; CANTON_PROD rejects CUSTODIAL_KEY_DIR).
	var custodial signer.Signer
	if cfg.CustodialKeyDir != "" {
		cs, err := signer.LoadCustodialSigner(cfg.CustodialKeyDir)
		if err != nil {
			return fmt.Errorf("load custodial signer: %w", err)
		}
		if err := cs.VerifyAgainstRegistry(registry); err != nil {
			return fmt.Errorf("custodial vs registry: %w", err)
		}
		custodial = cs
	}

	// Participant-operator key.
	pub, err := config.LoadParticipantPubKey(cfg.ParticipantPubKeyPath)
	if err != nil {
		return fmt.Errorf("load participant pubkey: %w", err)
	}
	priv, err := config.LoadParticipantSigningKey(cfg.ParticipantSigningKey)
	if err != nil {
		return fmt.Errorf("load participant signing key: %w", err)
	}
	receiptSigner, err := sign.NewSigner(sign.SignerOptions{
		PrivateKey: priv,
		PublicKey:  pub,
	})
	if err != nil {
		return fmt.Errorf("init receipt signer: %w", err)
	}

	// Dial Canton via gRPC and construct the production canton.Client.
	// CANTON_GRPC_ADDR / CANTON_LEDGER_ID override the legacy
	// PARTICIPANT_HOST:PARTICIPANT_PORT / LEDGER_ID pair so an operator can
	// point the binary at a different participant without touching the rest
	// of the env. Defaults match the localnet bootstrap (see
	// canton/bootstrap.canton + scripts/canton-up.sh).
	grpcAddr := os.Getenv("CANTON_GRPC_ADDR")
	if grpcAddr == "" {
		grpcAddr = fmt.Sprintf("%s:%d", cfg.ParticipantHost, cfg.ParticipantPort)
	}
	ledgerID := os.Getenv("CANTON_LEDGER_ID")
	if ledgerID == "" {
		ledgerID = cfg.LedgerID
	}
	facilitatorParty := cfg.ParticipantUser
	if facilitatorParty == "" {
		facilitatorParty = "facilitator"
	}
	cantonCfg := canton.DefaultConfig()
	cantonCfg.GRPCAddr = grpcAddr
	cantonCfg.LedgerID = ledgerID
	cantonCfg.FacilitatorActAs = facilitatorParty
	cantonCfg.CantonProd = cfg.CantonProd
	cantonCfg.CompletionTTL = cfg.CompletionTTL
	cantonCfg.DeduplicationDuration = cfg.CompletionTTL
	cantonCfg.RetryWindowMax = cfg.RetryWindowMax
	cantonCfg.MaxDeduplicationDuration = cfg.MaxDeduplicationDuration
	cantonCfg.MaxDeduplicationDurationFallback = cfg.MaxDeduplicationDurationFallback
	cantonCfg.MaxInflightPay = cfg.MaxInflightPay
	cantonCfg.GRPCKeepaliveTime = cfg.GRPCKeepaliveTime
	cantonCfg.GRPCKeepaliveTimeout = cfg.GRPCKeepaliveTimeout

	transport, err := canton.NewGRPCTransport(cantonCfg)
	if err != nil {
		return fmt.Errorf("dial canton (%s): %w", grpcAddr, err)
	}
	bootCtx, bootCancel := context.WithTimeout(context.Background(), 10*time.Second)
	cantonClient, err := canton.NewClient(bootCtx, cantonCfg, transport, nil)
	bootCancel()
	if err != nil {
		_ = transport.Close()
		return fmt.Errorf("init canton client: %w", err)
	}
	defer cantonClient.Close()

	cantonOps, err := canton.NewOps(cantonClient)
	if err != nil {
		return fmt.Errorf("wire canton ops: %w", err)
	}

	d := api.RouterDeps{
		CreateOrder: api.CreateOrderDeps{
			Store:                 st,
			TokenStore:            tokenStore,
			CurrencyAllowList:     cfg.CurrencyAllowList,
			TrustedIssuerMap:      cfg.TrustedIssuerMap,
			LedgerSkewSafety:      cfg.LedgerSkewSafety,
			X402SupportedVersions: cfg.X402SupportedVersions,
		},
		CustodialSign: api.CustodialSignDeps{
			Store:      st,
			Signer:     custodial,
			TokenStore: tokenStore,
			CantonProd: cfg.CantonProd,
		},
		Signature: api.SignatureDeps{
			Store:            st,
			Registry:         registry,
			TokenStore:       tokenStore,
			Canton:           cantonOps,
			Signer:           receiptSigner,
			ParticipantParty: cfg.ParticipantUser,
			LedgerID:         cfg.LedgerID,
			LedgerSkew:       cfg.LedgerSkewSafety,
			InitialBackoff:   time.Second,
			WaitDefault:      cfg.WaitDefault,
			WaitMax:          cfg.WaitMax,
			Logger:           logger,
		},
		Status: api.StatusDeps{
			Store:        st,
			TokenStore:   tokenStore,
			MaxRetries:   cfg.MaxRetries,
			WaitDefault:  cfg.WaitDefault,
			WaitMax:      cfg.WaitMax,
			PollInterval: 100 * time.Millisecond,
		},
		Proof: api.ProofDeps{
			Store:      st,
			Receipts:   &api.SQLReceiptReader{DB: st.DB()},
			TokenStore: tokenStore,
		},
		DevSourceHolding: api.DevSourceHoldingDeps{
			FixturePath: cfg.SourceHoldingFixturePath,
			TokenStore:  tokenStore,
			CantonProd:  cfg.CantonProd,
		},
		Health: api.HealthDeps{
			CantonHealth: cantonClient.Health,
			StorePing:    func(ctx context.Context) error { return st.DB().PingContext(ctx) },
		},
		CORSOpts: middleware.CORSOptions{
			AllowOrigins: cfg.CORSOrigins,
		},
		BodyLimit: cfg.OrderBodyLimit,
		RateLimit: middleware.RateLimitOptions{
			PerTokenRPS: cfg.RateLimitPerToken,
			PerIPRPS:    cfg.RateLimitPerIP,
			IPMapMax:    cfg.RateLimitIPMapMax,
		},
	}

	apiHandler := api.NewRouter(d)

	// Mount /metrics on a top-level mux so the Prometheus scrape endpoint
	// bypasses the API router's auth/rate-limit middleware (operators must
	// be able to scrape without a payer token). Everything else falls
	// through to the API router unchanged.
	root := http.NewServeMux()
	root.Handle("/metrics", m.Handler())
	root.Handle("/", apiHandler)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
	}
	logger.Info("facilitator listening",
		"addr", cfg.HTTPAddr,
		"canton_prod", cfg.CantonProd,
		"pubkey_fp", sign.Fingerprint(pub))

	errCh := make(chan error, 1)
	go func() {
		err := srv.ListenAndServe()
		if !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case s := <-sig:
		logger.Info("received signal, shutting down", "signal", s.String())
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("server: %w", err)
		}
	}
	return nil
}

