-- Whether an agent is actually doing anything.
--
-- `agents.enabled` is a configuration flag -- whether the Hermes profile is
-- turned on -- and the dashboard had nothing else, so it inferred busy-ness by
-- counting run rows. Those are precisely the rows that go stale when a runner
-- restarts mid-run, so the one screen that works from off the runner's network
-- was guessing, and guessing wrong in the case that matters.
--
-- The runner knows the truth and now says so on every heartbeat. Nullable
-- because a runner on an older build sends none of it, and an agent it has not
-- reported on yet is unknown rather than idle.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status         TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_run_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_at      TIMESTAMPTZ;

-- Routing decisions that produced no run: no route matched, the agent was
-- busy, the trigger was a duplicate. These reached the runner's own stdout and
-- stopped there, so "sentinel0 did nothing and cannot tell you why" was a
-- routine experience. A bounded tail rides along with the heartbeat.
ALTER TABLE runners ADD COLUMN IF NOT EXISTS recent_skips JSONB;

-- Set once when a runner is first seen to have gone quiet, and cleared when it
-- comes back. Without it the stale sweep would re-announce the same dead runner
-- on every pass; `run.stale` has been a declared notification since 001 and has
-- never once been sent.
ALTER TABLE runners ADD COLUMN IF NOT EXISTS stale_notified_at TIMESTAMPTZ;
