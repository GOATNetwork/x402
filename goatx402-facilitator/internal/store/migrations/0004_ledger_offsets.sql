-- 0004_ledger_offsets.sql
-- Persisted ledger-API stream offsets. Owned by internal/canton/tx_stream.go
-- (PLAN.md §6.2 offset checkpoint), but the table is created by the store
-- module so all schema lives in one migrations directory.
CREATE TABLE IF NOT EXISTS ledger_offsets (
    stream_key TEXT    NOT NULL PRIMARY KEY,
    "offset"   TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
