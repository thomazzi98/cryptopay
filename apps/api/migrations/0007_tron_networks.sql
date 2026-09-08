-- The TRON networks, as enum values and nothing else.
--
-- This file is deliberately tiny, and deliberately alone. PostgreSQL refuses to use a newly added
-- enum value inside the transaction that added it, and the migration runner wraps every file in one
-- transaction, so a migration that both adds `tron-nile` and writes a constraint mentioning it fails
-- at apply time with a message about unsafe enum use. Splitting the two is the only correct shape,
-- and merging them back would break deployment rather than CI, which is the worse place to find out.
--
-- Adding the values does not yet make a TRON payment storable. Two constraints still stand in the
-- way, and both are correct as written for an EVM-only system: `payments_environment_network_
-- consistent` enumerates the networks each environment may use, and sixteen CHECK constraints
-- require accounts to equal their own lowercase form. That second rule is an EVM rule wearing a
-- universal one's clothes, and replacing it with a per-network canonical form is the migration that
-- follows this one.
--
-- What this file does achieve on its own is that a TRON payment is refused cleanly. Creation asks
-- whether any scanner watches the network before it writes anything, and with the value present but
-- no cursor for it, the answer is "this deployment is not watching TRON" rather than a driver error
-- about an invalid enum value surfacing as a 500.

ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'tron-mainnet';
ALTER TYPE network_identifier ADD VALUE IF NOT EXISTS 'tron-nile';
