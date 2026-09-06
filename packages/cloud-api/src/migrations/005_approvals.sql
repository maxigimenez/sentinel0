-- Answering an agent that has stopped for permission.
--
-- Hermes gates certain tool calls behind a human decision. Sentinel0 recorded
-- that a run was waiting -- it even told Slack -- but offered no way to answer,
-- so the only escape was cancelling the run. This is the command that carries
-- the decision back to the machine holding the Hermes run.
--
-- Addressed rather than broadcast: unlike 'cancel', which is harmless anywhere,
-- an approval means nothing to a runner that is not running the run.
ALTER TABLE runner_commands DROP CONSTRAINT IF EXISTS runner_commands_type_check;
ALTER TABLE runner_commands ADD CONSTRAINT runner_commands_type_check
  CHECK (type IN ('run', 'cancel', 'resync', 'run-prompt', 'approve'));

-- What the agent is waiting to be allowed to do, so the dashboard and Slack can
-- say more than "something needs approval".
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval_detail JSONB;

-- Both of these were already on the wire and dropped on the floor by the
-- mirror's INSERT. The session id is what lets an operator attach to a live
-- agent; the revision is what identifies the change a run was fired for.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS hermes_session_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_revision TEXT;
