-- 0003_order_events.sql
-- Append-only audit log. Every successful Transition / TransitionAndArmRetry /
-- SaveReceiptAndConfirm / RecordRetry / MarkPaymentFailedAfterMaxRetries call
-- writes one row inside the same SQL transaction as the CAS update.
CREATE TABLE IF NOT EXISTS order_events (
    id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT    NOT NULL REFERENCES orders(id),
    from_status TEXT,
    to_status   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);
