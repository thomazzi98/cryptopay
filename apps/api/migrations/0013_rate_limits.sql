-- A request budget per API key, counted in the database rather than in a process.
--
-- An in-process token bucket is the usual approach and it is wrong for anything running more than
-- one replica: each instance would enforce the configured limit independently, so the effective
-- limit becomes the configured one multiplied by the replica count, and it changes silently when
-- the deployment scales. The counter has to be somewhere every instance can see.
--
-- A fixed window rather than a sliding one. A sliding window needs either a sorted set of request
-- timestamps or a background sweep, and neither is worth it here: the failure a fixed window allows
-- is a caller sending two windows' worth of requests across a boundary, which costs a brief burst
-- of twice the limit and no correctness at all.
--
-- The primary key is the key and the window together, so the counter is one upsert and the row for
-- an idle key simply stops being written to. Old windows are removed by the same statement that
-- writes a new one rather than by a scheduled job, which is one fewer thing to operate.

CREATE TABLE api_key_rate_windows (
  api_key_id     TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  window_started TIMESTAMPTZ NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),

  PRIMARY KEY (api_key_id, window_started)
);

-- Supports the sweep of expired windows, which is by time across every key rather than by key.
CREATE INDEX api_key_rate_windows_expiry_idx ON api_key_rate_windows (window_started);
