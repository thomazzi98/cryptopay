-- Makes a redelivery its own attempt cycle, without losing the attempts that came before it.
--
-- Requeuing used to reset attempt_count to zero so the retry schedule started again. Two things
-- followed from that, and both were found by asking for a redelivery and looking at what the
-- merchant could then see:
--
--   1. The new attempt reused an attempt number that already existed, and the insert is
--      ON CONFLICT DO NOTHING for crash-replay safety, so the redelivery left no row at all. The
--      request really was sent — it simply became invisible, which for an audit trail is worse than
--      not sending it.
--   2. The retry policy abandons a delivery older than the age ceiling, measured from created_at.
--      A redelivery of a three-day-old event was therefore abandoned on its first attempt, and the
--      button in the dashboard silently did nothing.
--
-- The fix separates the two counts that were being conflated. attempt_count keeps rising for the
-- life of the event, so attempt numbers stay unique and the history is complete; schedule_offset
-- records where the current cycle started, so the policy still sees "attempt 1 of the schedule";
-- and cycle_started_at gives the age ceiling a start it can honestly measure from.

ALTER TABLE webhook_deliveries
  ADD COLUMN schedule_offset INTEGER NOT NULL DEFAULT 0 CHECK (schedule_offset >= 0),
  ADD COLUMN cycle_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing rows have never been requeued, so their cycle began when the event did. The column
-- default would otherwise date every historical delivery to this migration and make a genuinely old
-- delivery look fresh to the age ceiling.
UPDATE webhook_deliveries SET cycle_started_at = created_at;
