-- 0001_orders.sql
-- Per PLAN.md §4.2 / §4.3:
--   * No DB-side defaults that depend on SQLite-only functions (e.g.
--     strftime('%s','now')); created_at / updated_at are supplied by the
--     Go layer so the migration is portable to PostgreSQL.
--   * status is constrained to the 6 documented states (PAYMENT_FAILED is
--     part of the v0 state machine — see §4.2 transition matrix).
--   * Partial indexes idx_orders_retry_next_at and uniq_orders_payer_client_request
--     are required by the sweeper retry queue and (payer, clientRequestId)
--     idempotency lookup respectively.
CREATE TABLE IF NOT EXISTS orders (
    id                          TEXT    NOT NULL PRIMARY KEY,
    status                      TEXT    NOT NULL CHECK (status IN (
                                            'CREATED',
                                            'CHECKOUT_VERIFIED',
                                            'PAYMENT_CONFIRMED',
                                            'PAYMENT_FAILED',
                                            'CANCELLED',
                                            'EXPIRED'
                                        )),
    amount                      TEXT    NOT NULL,
    currency                    TEXT    NOT NULL,
    trusted_issuer              TEXT    NOT NULL,
    merchant                    TEXT    NOT NULL,
    payer                       TEXT    NOT NULL,
    resource                    TEXT    NOT NULL,
    nonce                       TEXT    NOT NULL,
    memo                        TEXT,
    expires_at                  INTEGER NOT NULL,
    dedup_id                    TEXT    NOT NULL,
    payload_hash                BLOB    NOT NULL,
    merchant_request_id         TEXT    NOT NULL,
    client_request_id           TEXT,
    request_fingerprint         BLOB,
    source_holding_contract_id  TEXT    NOT NULL,
    command_id                  TEXT,
    retry_count                 INTEGER NOT NULL DEFAULT 0,
    retry_last_error            TEXT,
    retry_next_at               INTEGER,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL,
    status_version              INTEGER NOT NULL DEFAULT 0
);

CREATE        INDEX IF NOT EXISTS idx_orders_status               ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedup                ON orders(dedup_id);
CREATE        INDEX IF NOT EXISTS idx_orders_expires              ON orders(expires_at);

-- Sweeper retry queue (partial index — SQLite + Postgres both support it).
CREATE        INDEX IF NOT EXISTS idx_orders_retry_next_at        ON orders(retry_next_at)
    WHERE retry_next_at IS NOT NULL;

-- (payer, clientRequestId) idempotency lookup for POST /api/v1/orders.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_payer_client_request ON orders(payer, client_request_id)
    WHERE client_request_id IS NOT NULL;
