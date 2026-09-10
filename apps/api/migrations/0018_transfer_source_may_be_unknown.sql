-- Not every chain names a sender.
--
-- A Solana transaction may debit several accounts, so there is no single account that sent the
-- payment. The adapter recorded the credited account instead, which put the merchant's own deposit
-- address in a column the dashboard renders under the heading "From". An address that nobody paid
-- from is worse than no address, so the column now admits the honest answer.
--
-- The two CHECK constraints on this column are unchanged and stay correct: a CHECK that evaluates
-- to NULL passes, so a row with no source account satisfies both the lowercase rule and the
-- canonical-form rule without either being weakened for the rows that do carry one.

ALTER TABLE payment_transfers
  ALTER COLUMN source_account DROP NOT NULL;

COMMENT ON COLUMN payment_transfers.source_account IS
  'The account the value came from, where the chain names one. Null on a chain that cannot: a Solana transaction may debit several accounts and naming one would be a guess.';
