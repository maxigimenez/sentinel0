-- Tracker credentials, held for the organization rather than on each machine.
--
-- GitHub access used to be `gh`'s own login on the runner's box and Linear's
-- key a line in `~/.sentinel0/config.json`. Neither survives a machine that
-- cannot install `gh`, and neither lets the dashboard offer a repository
-- picker, because a browser must never hold a token that grants writing to
-- someone's repositories.
--
-- `project_id` NULL is the organization default; a row naming a project is an
-- override for that project alone. Postgres does not treat NULLs as equal in a
-- unique constraint, so the uniqueness is expressed as two partial indexes --
-- one over the default row, one over the per-project rows. A single
-- `UNIQUE (org_id, provider, project_id)` would silently permit any number of
-- competing organization defaults.
CREATE TABLE IF NOT EXISTS integrations (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'linear')),
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,

  -- AES-256-GCM, keyed by SENTINEL0_SECRET_KEY. Never returned by the user API.
  token_ciphertext TEXT NOT NULL,
  -- The first few characters, so a person can tell which token is installed
  -- without the API handing back one that can write to their repositories.
  token_prefix     TEXT NOT NULL,

  -- Resolved against the provider when the credential was saved, so a route
  -- targeting an agent by GitHub identity can be checked against something.
  account_login    TEXT,
  scopes           TEXT[] NOT NULL DEFAULT '{}',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  last_error       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_org_default
  ON integrations(org_id, provider)
  WHERE project_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_org_project
  ON integrations(org_id, provider, project_id)
  WHERE project_id IS NOT NULL;
