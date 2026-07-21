// Package canton owns every interaction with the Canton participant's Ledger
// API. It is the only package in the facilitator that is allowed to import
// gRPC transport types; everything else (HTTP handlers, store, signer) goes
// through the Client interface in client.go.
//
// Transport model (per PLAN.md §6.2 transport table):
//
//   - Command submission       — gRPC CommandSubmissionService.Submit
//     (non-waiting; Daml 2.10 HTTP JSON API does not document an async submit
//     workflow, so JSON LAPI cannot carry the ?wait=false 202 path).
//   - Command status / errors  — gRPC CommandCompletionService.CompletionStream
//     (success AND failure surface here; TransactionService alone cannot
//     observe failed/rejected commands because they never commit).
//   - Confirmed tx details     — gRPC TransactionService.GetTransactions,
//     filtered by the txId carried in the CompletionEvent.
//   - Health                   — JSON /v1/healthz (single short request).
//   - Party allocation         — JSON Ledger API (idempotent bootstrap-only
//     helper).
//
// # Canton Ledger API authentication
//
// v0 localnet: Canton sandbox runs with auth disabled. The facilitator submits
// as a single "facilitator" participant user that has actAs for every payer
// party allocated in localnet. Payer authority on each submission is bound by
// the app-layer Ed25519 signature the facilitator verifies against
// PayerKeyRegistry BEFORE forwarding the command — the participant trusts the
// facilitator's submission because the facilitator has already proved the
// payer authorised it.
//
// CANTON_PROD=true: facilitator uses Canton's user-management JWT
// (PARTICIPANT_USER, PARTICIPANT_JWT_PATH) with explicit actAs set to
// order.payer for each SubmitCreateAndExercisePay. JWT is rotated by the
// operator; config_prod_test.go asserts the JWT path is set, non-empty, and
// chmod 600.
//
// This is the only ledger-API authentication model; the payer's Ed25519
// signature is purely app-level and never travels into the Ledger API call.
//
// # Mocking discipline (AGENTS.md)
//
// Tests that exercise ledger behaviour must run against a real Canton
// sandbox. DO NOT mock the canton.Client interface in tests that exercise
// ledger semantics. Mock/prod divergence is the highest-risk regression
// class in this project. This file's *_integration_test.go counterparts
// hold the conformance suite; they skip when CANTON_GRPC_ADDR is unset.
//
// # commandId pinning (PLAN.md §6.4 name map)
//
// commandId = order.id (UUIDv7 from §4.2). It is byte-stable across retries —
// rotating commandId per retry would defeat both Canton's deduplicationPeriod
// (allowing a second in-flight submission to settle alongside the first) and
// the demux cache that backs RecoverByCommandID. Every retry path
// (synchronous in-handler, sweeper, post-restart resume) re-reads
// orders.command_id and reuses it byte-for-byte. command.go enforces this.
//
// # Boot-time invariants (PLAN.md §6.2)
//
//   1. RETRY_WINDOW_MAX < COMPLETION_TTL  — so a LEDGER_TIMEOUT-then-retry
//      sequence is guaranteed to find the original completion in the demux
//      cache before TTL eviction.
//   2. Submit.deduplication_duration >= COMPLETION_TTL — so Canton's own
//      idempotency window covers the entire retry window.
//   3. COMPLETION_TTL <= maxDeduplicationDuration (read from participant's
//      domain parameters; falls back to a hard 24h ceiling when the query is
//      unavailable). Boot fails with INVALID_CONFIG if violated.
//
// All three are enforced by Config.Validate() and called from NewClient.
package canton
