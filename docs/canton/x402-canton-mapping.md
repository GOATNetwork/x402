# x402 ⇆ Canton Conceptual Mapping

> **Audience**: integrators familiar with the GOAT Network x402 spec who need to
> reason about how the same wire shapes are backed by Canton primitives in this
> reference implementation.
> **Source of truth**: `PLAN.md` §1–§6 and `docs/canton-receipt.schema.json`.
> This document is conceptual; the schema and Go types are normative.

---

## 1. One-screen summary

```
x402 wire concept                     Canton primitive in this repo
─────────────────────────────────     ────────────────────────────────────────
402 Payment Required + accepts[]      Merchant HTTP 402 envelope with a single
                                      `canton-daml` accept entry that names a
                                      Daml template + choice + sourceHolding cid
scheme = "canton-daml"                Daml package: Payment.daml (Holding +
                                      PaymentRequest + Pay)
payTo                                 PaymentRequest.merchant (Canton party id)
amount + currency                     PaymentRequest.amount + .currency
                                      (Decimal as string + allowlisted text)
trustedIssuer                         PaymentRequest.trustedIssuer (Canton
                                      party id; equality-asserted in Pay
                                      against sourceHolding.issuer)
merchantRequestId                     PaymentRequest.merchantRequestId — binds
                                      receipt to the issuing 402 challenge so a
                                      stolen receipt cannot be replayed off-session
expiresAt                             PaymentRequest.expires (Daml-form =
                                      HTTP-form + LEDGER_SKEW_SAFETY)
payment authorisation signature       Ed25519 signature over CanonicalSubmission
                                      (PureEdDSA); verified app-side by the
                                      facilitator; NEVER travels into the
                                      Ledger API
settlement                            Atomic createAndExercise PaymentRequest +
                                      Pay (single transaction, single
                                      commandId) submitted via gRPC
                                      CommandSubmissionService.Submit
proof of payment                      CantonReceipt (participant-operator-signed,
                                      offline-verifiable; schema in
                                      docs/canton-receipt.schema.json)
X-PAYMENT header (replay)             base64 of CantonReceipt JSON; merchant
                                      runs goatx402-receipt/verify offline,
                                      one-time-use LRU rejects replays
```

---

## 2. Authority model (the part that surprises EVM-flavoured readers)

The EVM mental model is "owner signs, network executes". Canton's authority
model is **explicit**: every contract names its `signatory` parties, and any
choice that creates a new contract must do so under the authority of those
parties. In this repo we therefore split authority across three Daml templates
in a way that has no EVM analogue:

| Template / choice    | Signatory  | Observer  | Controller | Why                                                                                                                       |
| -------------------- | ---------- | --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Holding`            | `issuer`   | `owner`   | —          | Issuer-signed fungible asset. Creating a new `Holding` requires issuer authority, which is propagated through `Transfer`. |
| `Holding.Transfer`   | —          | —         | `owner`    | Owner authorises the transfer. The choice consequence creates the new `Holding` under propagated issuer authority.        |
| `PaymentRequest`     | `payer`    | merchant  | —          | Payer's offer. Merchant is observer so it sees but does not co-sign.                                                      |
| `PaymentRequest.Pay` | —          | —         | `payer`    | Payer's authority to spend `sourceHolding`. Internally exercises `sourceHolding.Transfer`.                                |

Three invariants this model gives us:

1. **Merchant never signs.** Receiving payment requires no merchant action.
2. **Issuer never signs at the API boundary.** Issuer authority is propagated
   through `Transfer`'s choice consequence; no off-Daml authorisation token is
   needed for the issuer.
3. **`sourceHolding.issuer == PaymentRequest.trustedIssuer`** is asserted inside
   `Pay`. A same-currency `Holding` signed by some other issuer cannot satisfy
   the request — this is what closes the "untrusted asset" attack on a
   currency-only check.

The `PaymentTest.daml` script pins this with a 3-party case where
`issuer ≠ payer ≠ merchant`. See `PLAN.md` §6.1.

---

## 3. x402 → HTTP flow ↔ Daml transaction

The x402 spec's verify/settle split maps to two HTTP calls on the facilitator,
which together produce **one** Daml transaction:

```
x402 client                facilitator                     Canton participant
────────────                ────────────                     ─────────────────
                                │
POST /api/v1/orders     ────►   │ persist order, derive
                                │ submissionPayloadHash;
                                │ NO ledger I/O at this stage
   ◄──── 201 + accepts[]        │
                                │
POST .../calldata-signature ──► │ verify Ed25519(payer pubkey
                                │   from registry) over canonical
                                │   submission bytes;
                                │ gRPC CommandSubmissionService.Submit
                                │   with commandId = order.id,
                                │   deduplication_duration ≥ COMPLETION_TTL,
                                │   actAs = order.payer
                                │                                ─────────►
                                │                                createAndExercise:
                                │                                  create PaymentRequest
                                │                                  exercise Pay
                                │                                  ↳ fetch Holding
                                │                                  ↳ check issuer/currency/owner/expiry
                                │                                  ↳ exercise Transfer
                                │                                  ↳ archive request
                                │ CommandCompletionService stream ◄────
                                │   (success → txId populated;
                                │    failure → gRPC code mapped
                                │     to HTTP status per §6.2)
                                │ TransactionService.GetTransactions(txId)
                                │   ─► events used to build receipt
                                │
                                │ sign CanonicalReceipt with
                                │   participant-operator key;
                                │ self-verify via goatx402-receipt/verify;
                                │ SaveReceiptAndConfirm (single SQL tx)
   ◄──── 202 (default) or 200   │
        (if ?wait=true)         │

GET .../proof          ────►    │ returns CantonReceipt
   ◄──── CantonReceipt JSON     │

POST /resource (X-PAYMENT)  ──► merchant
                                │ goatx402-receipt/verify.Verify (offline)
                                │ assert amount/payee/resource/
                                │   trustedIssuer/merchantRequestId match
                                │ one-time-use replay cache
                                │
   ◄──── 200 + resource body
```

The single atomic `createAndExercise` is what eliminates the "created but
un-exercised" state EVM-style two-step flows have. Retries are safe because
Canton's Ledger-API `deduplicationPeriod` (`≥ COMPLETION_TTL`) rejects a
duplicate `(actAs, commandId)` submission inside the dedup window, and the
facilitator's demux cache (`canton/tx_stream.go`) returns the original
completion via `RecoverByCommandID` — the order's `commandId` is pinned to the
order id and never rotates. See `PLAN.md` §6.2.

---

## 4. Signatures and what they actually sign

Three Ed25519 signatures appear in the protocol. They are independent and
operate on **different byte strings** — confusing them is the most common
review finding.

| Signature                  | Signer                                            | Bytes signed (PureEdDSA — raw bytes, no pre-hash)                                                                                                  | Verifier                                                                                | Where to look          |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| Payer authorisation        | Payer (v0: custodial signer; F10: BYO)            | `goatx402-receipt.CanonicalSubmission(SignInput)` bytes. Inputs: `payer, merchant, amount, currency, trustedIssuer, expires_at (HTTP-form), resource, sourceHoldingContractId, merchantRequestId, dedupKey, orderId, nonce` | Facilitator at `POST /calldata-signature`, against `PayerKeyRegistry[order.payer]`      | `PLAN.md` §6.4         |
| Participant-operator stamp | Facilitator's `internal/receipt/sign`             | `goatx402-receipt.CanonicalReceipt(receipt)` bytes — the full receipt minus `signature` and `receiptPayloadHash`                                        | Merchant (and any third party) via `goatx402-receipt/verify.Verify` — offline, no network I/O | `PLAN.md` §6.4         |
| Participant→ledger auth    | Canton participant (TLS / JWT, not Ed25519 here)  | Out of scope of x402 — internal to Canton                                                                                                          | Sequencer / mediator                                                                    | Canton docs            |

> `submissionPayloadHash` (in `POST /orders` response) and `receiptPayloadHash`
> (in `CantonReceipt`) are **display-only digests** — base64 of the sha256
> of the canonical bytes. **No signer ever feeds these into
> `ed25519.Sign`.** They exist as a client-side canonical-ness diff aid and as
> a defence-in-depth integrity check inside the facilitator (DB-corruption /
> canonicaliser-drift detection). The wire field name is uniformly
> `submissionPayloadHash` / `receiptPayloadHash` across schemas, redaction
> rules, and golden fixtures.

---

## 5. Idempotency and dedup — three knobs, three reasons

| Layer                | Knob                                                          | What it prevents                                                                                            | Failure surface                                            |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| HTTP                 | `orders.dedup_id` UNIQUE index (`idx_orders_dedup`)            | Two HTTP submissions of the same `(payer, amount, currency, trusted_issuer, expires_at, resource, sourceHolding, merchantRequestId, orderId, nonce)` from ever reaching the ledger | `409 DUPLICATE_DEDUP`                                      |
| HTTP (optional)      | `(payer, client_request_id)` UNIQUE + `request_fingerprint`    | Body-tampered idempotent replays masquerading as the original order                                          | Same body → `200 + original orderId`; tampered → `409 DUPLICATE_CLIENT_REQUEST` |
| Canton Ledger API    | `Commands.deduplication_duration ≥ COMPLETION_TTL`             | A resubmitted `(actAs, commandId)` from creating a second in-flight transaction during retries              | gRPC `Aborted` → caller resolves via `RecoverByCommandID`  |
| Daml template key    | `(payer, dedupKey)` on `PaymentRequest`                        | Defence in depth against two concurrent in-flight `createAndExercise`s with the same `(payer, dedupKey)`     | Engine rejects second with `DuplicateKey` → mapped to 409  |

The template key alone is **not** sufficient for durable idempotency because
`createAndExercise` archives the request in the same transaction — see the
extended comment in `daml/Payment.daml`. Durable idempotency comes from the
SQL UNIQUE index plus the demux cache.

---

## 6. The `CantonReceipt` artefact

The `CantonReceipt` is the public API contract — merchants verify it offline
and never query the ledger. Its full field set is normative in
`docs/canton-receipt.schema.json`; this section explains intent.

```jsonc
{
  "version": 1,
  "domain": "x402-canton-payment/v1",
  "orderId": "uuidv7",
  "paymentRequestContractId": "<archived PaymentRequest cid>",
  "merchant": "<canton party id>",
  "payer":    "<canton party id>",
  "amount":   "1.5",
  "currency": "USD-canton",
  "trustedIssuer": "<canton party id>",
  "resource": "/goatx402-merchant/path",
  "merchantRequestId": "<mirrored from 402 challenge>",
  "expiresAtHttp": 1715600000000,
  "expiresAtDaml": 1715600030000,
  "ledgerId": "<canton ledger id>",
  "transactionId": "<canton tx id>",
  "contractId": "<merchant Holding cid>",
  "participantPartyId": "<participant party id>",
  "signatureScheme": "Ed25519",
  "signature": "<base64; over CanonicalReceipt(...)>",
  "receiptPayloadHash": "<base64 sha256 of CanonicalReceipt; display-only>",
  "completedAt": 1715600001234
}
```

Why these specific fields:

- `merchantRequestId` binds the receipt to the merchant's issued 402 challenge
  so a stolen receipt cannot be replayed off-session.
- `trustedIssuer` is in the signed bytes so the merchant can verify that the
  Holding consumed by `Pay` came from an issuer the merchant trusts.
- `expiresAtHttp` is what the payer signed; `expiresAtDaml` is what the ledger
  contract enforced (`HTTP + LEDGER_SKEW_SAFETY`). Both surfaces are exposed
  so auditors can reconcile without ambiguity.
- `paymentRequestContractId` is the cid of the (now-archived) `PaymentRequest`
  so a Canton operator can pull the audit trail from the participant if needed.

See `PLAN.md` §5.1 (`GET /proof`) for the wire definition and §6.4 for the
canonicalisers.

---

## 7. What this implementation does **not** model

A short list, so readers don't try to find these and conclude they're missing:

- **Cross-chain swap.** This is x402 over Canton, not a bridge. There is no
  on-EVM artefact.
- **Non-custodial signing.** v0 ships a custodial signer at
  `facilitator/internal/signer/custodial.go`. F10 (Task 17) swaps in
  `BYOSigner` without touching handlers — the `Signer` interface is the
  seam.
- **Two-step propose/accept.** F9 (Task 16) adds a `Propose`/`Accept`
  variant. v0 uses the single atomic `Pay` choice for latency.
- **Merchant-runs-participant settlement.** TBD-1 chose option C
  (signed-receipt, single shared participant). The receipt's
  `participantPartyId` would be the merchant's under option B; the schema
  is unchanged across options.
- **Concrete on-chain currency semantics.** `currency` is allowlisted text
  (`USD-canton` in v0); the trust anchor is the `(currency, trustedIssuer)`
  pair, not a contract-level type tag.

---

## 8. Pointers for further reading

| Topic                              | File                                              |
| ---------------------------------- | ------------------------------------------------- |
| Daml templates                     | `daml/Payment.daml`                               |
| Canonical serialisation + verifier | `goatx402-receipt/`                                    |
| HTTP API definitions               | `PLAN.md` §5                                      |
| Module-level design notes          | `PLAN.md` §6                                      |
| Receipt schema                     | `docs/canton-receipt.schema.json`                 |
| Operator runbooks                  | `docs/operator-handbook.md`                       |
| x402 wire spec (upstream)          | https://github.com/GOATNetwork/x402               |
| Daml / Canton docs                 | https://docs.daml.com/                            |
