-- Reconciliation needs to remember what it has already looked at.
--
-- Without a marker every pass would read the same few rows: the ones that sort first. These columns
-- are ordering state and nothing else. They record when a row was last compared against the chain,
-- never what the comparison concluded, because a conclusion belongs to the payment's status and
-- there is exactly one path allowed to write that.
--
-- Nullable and unindexed by intent. A null sorts first under NULLS FIRST, so every row is naturally
-- checked once before any row is checked twice, and the working set here is the live payments,
-- which is small by construction because payments expire.

ALTER TABLE payments ADD COLUMN reconciled_at TIMESTAMPTZ;
ALTER TABLE payment_transfers ADD COLUMN reconciled_at TIMESTAMPTZ;
