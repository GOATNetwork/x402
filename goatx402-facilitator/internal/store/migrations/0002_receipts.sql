-- 0002_receipts.sql
-- One row per order; the row is INSERTed by SaveReceiptAndConfirm in the same
-- SQL transaction as the CHECKOUT_VERIFIED → PAYMENT_CONFIRMED CAS-transition,
-- so a crash between INSERT and the CAS step rolls both back (PLAN.md §6.5
-- atomic-receipt invariant).
CREATE TABLE IF NOT EXISTS receipts (
    order_id                    TEXT    NOT NULL PRIMARY KEY REFERENCES orders(id),
    ledger_id                   TEXT    NOT NULL,
    tx_id                       TEXT    NOT NULL,
    contract_id                 TEXT    NOT NULL,
    payment_request_contract_id TEXT    NOT NULL,
    participant_party           TEXT    NOT NULL,
    signature_scheme            TEXT    NOT NULL,
    signature                   BLOB    NOT NULL,
    payload_hash                BLOB    NOT NULL,
    completed_at                INTEGER NOT NULL,
    raw_json                    TEXT    NOT NULL,
    created_at                  INTEGER NOT NULL
);
