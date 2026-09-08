-- Drops a column no code ever wrote.
--
-- `measured_block_interval_milliseconds` was added for a block time measured at boot and used to pace
-- the checkout countdown. Nothing ever measured it, so every row held NULL and the API would have
-- reported a value it does not have. A column that is always NULL is worse than a missing one: the
-- next person to read the schema plans around data that was never collected.
--
-- Polygon block time is configurable at runtime under PIP-75 in any case, which is why it was never
-- allowed to influence correctness. When the countdown needs pacing, the honest source is a
-- measurement taken from block timestamps, and that is a column added alongside the code that fills
-- it rather than years ahead of it.

ALTER TABLE block_cursors DROP COLUMN IF EXISTS measured_block_interval_milliseconds;
