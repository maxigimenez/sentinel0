import {
  INTEGRATION_PROVIDER,
  type IntegrationProvider,
  type IntegrationSummary,
} from '@sentinel0/common'
import { GitHubRestClient } from '@sentinel0/common/github'
import { decrypt, encrypt, tokenPrefix } from './crypto.js'
import type { Database } from './db.js'

/**
 * Storage and verification for the credentials an organization holds.
 *
 * Kept out of `routes/user.ts` because both APIs need it: the user API to save
 * and list, the runner API to hand the plaintext to a runner. Encryption is
 * applied here rather than at either call site, so there is exactly one place
 * a plaintext token can enter or leave the database.
 */

interface IntegrationRow {
  id: string
  provider: IntegrationProvider
  project_id: string | null
  token_ciphertext: string
  token_prefix: string
  account_login: string | null
  scopes: string[]
  created_at: Date
  updated_at: Date
  last_verified_at: Date | null
  last_error: string | null
}

export interface VerifiedIdentity {
  login: string
  scopes: string[]
}

/**
 * Confirms a token works before it is stored.
 *
 * A credential that is saved unverified fails later, on a poll cycle, as a 401
 * in a log nobody is reading -- and the person who pasted it has already left
 * the screen believing it worked. Verifying at save time turns that into an
 * error beside the field.
 */
export async function verifyToken(
  provider: IntegrationProvider,
  token: string
): Promise<VerifiedIdentity> {
  if (provider === INTEGRATION_PROVIDER.GITHUB) {
    return new GitHubRestClient(async () => token).identity()
  }

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query: '{ viewer { email } }' }),
  })
  if (!response.ok) {
    throw new Error(`Linear rejected the API key (${response.status}).`)
  }
  const body = (await response.json()) as {
    data?: { viewer?: { email?: string } }
    errors?: Array<{ message?: string }>
  }
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message ?? 'unknown').join('; '))
  }
  // Linear has no scope introspection, so the empty list means "not reported"
  // here exactly as it does for a fine-grained GitHub token.
  return { login: body.data?.viewer?.email ?? 'unknown', scopes: [] }
}

export async function listIntegrations(db: Database, orgId: string): Promise<IntegrationSummary[]> {
  const { rows } = await db.query<IntegrationRow>(
    `SELECT id, provider, project_id, token_ciphertext, token_prefix, account_login,
            scopes, created_at, updated_at, last_verified_at, last_error
     FROM integrations WHERE org_id = $1
     ORDER BY provider, project_id NULLS FIRST`,
    [orgId]
  )
  return rows.map(toSummary)
}

export async function saveIntegration(
  db: Database,
  orgId: string,
  input: {
    provider: IntegrationProvider
    projectId: string | null
    token: string
    identity: VerifiedIdentity
  }
): Promise<void> {
  // Two statements, not one, because the uniqueness is two partial indexes:
  // Postgres does not treat NULLs as equal, so a single
  // `ON CONFLICT (org_id, provider, project_id)` would never fire for the
  // organization default and would let an org accumulate any number of them.
  // Each branch names the index whose predicate it matches.
  if (input.projectId === null) {
    await db.query(
      `INSERT INTO integrations
         (id, org_id, provider, project_id, token_ciphertext, token_prefix,
          account_login, scopes, last_verified_at)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,now())
       ON CONFLICT (org_id, provider) WHERE project_id IS NULL DO UPDATE SET
         token_ciphertext = EXCLUDED.token_ciphertext,
         token_prefix     = EXCLUDED.token_prefix,
         account_login    = EXCLUDED.account_login,
         scopes           = EXCLUDED.scopes,
         updated_at       = now(),
         last_verified_at = now(),
         last_error       = NULL`,
      [
        `int_${input.provider}_${orgId}`,
        orgId,
        input.provider,
        encrypt(input.token),
        tokenPrefix(input.token),
        input.identity.login,
        input.identity.scopes,
      ]
    )
    return
  }

  await db.query(
    `INSERT INTO integrations
       (id, org_id, provider, project_id, token_ciphertext, token_prefix,
        account_login, scopes, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (org_id, provider, project_id) WHERE project_id IS NOT NULL DO UPDATE SET
       token_ciphertext = EXCLUDED.token_ciphertext,
       token_prefix     = EXCLUDED.token_prefix,
       account_login    = EXCLUDED.account_login,
       scopes           = EXCLUDED.scopes,
       updated_at       = now(),
       last_verified_at = now(),
       last_error       = NULL`,
    [
      `int_${input.provider}_${orgId}_${input.projectId}`,
      orgId,
      input.provider,
      input.projectId,
      encrypt(input.token),
      tokenPrefix(input.token),
      input.identity.login,
      input.identity.scopes,
    ]
  )
}

export async function deleteIntegration(
  db: Database,
  orgId: string,
  provider: IntegrationProvider,
  projectId: string | null
): Promise<void> {
  await db.query(
    projectId === null
      ? 'DELETE FROM integrations WHERE org_id = $1 AND provider = $2 AND project_id IS NULL'
      : 'DELETE FROM integrations WHERE org_id = $1 AND provider = $2 AND project_id = $3',
    projectId === null ? [orgId, provider] : [orgId, provider, projectId]
  )
}

/**
 * The plaintext credential that applies to a project.
 *
 * Used by the runner endpoint and by the dashboard's repository picker. The
 * precedence -- project override, then organization default -- is expressed
 * once, in SQL, by ordering the two candidate rows and taking the first.
 */
export async function resolveToken(
  db: Database,
  orgId: string,
  provider: IntegrationProvider,
  projectId: string | null
): Promise<string | undefined> {
  const { rows } = await db.query<{ token_ciphertext: string }>(
    `SELECT token_ciphertext FROM integrations
     WHERE org_id = $1 AND provider = $2
       AND (project_id IS NULL OR project_id = $3)
     ORDER BY project_id NULLS LAST
     LIMIT 1`,
    [orgId, provider, projectId]
  )
  return rows[0] ? decrypt(rows[0].token_ciphertext) : undefined
}

/** Every credential this org holds, decrypted, for the runner to cache. */
export async function resolveAllTokens(
  db: Database,
  orgId: string
): Promise<Array<{ provider: IntegrationProvider; projectId: string | null; token: string }>> {
  const { rows } = await db.query<IntegrationRow>(
    'SELECT provider, project_id, token_ciphertext FROM integrations WHERE org_id = $1',
    [orgId]
  )
  return rows.map((row) => ({
    provider: row.provider,
    projectId: row.project_id,
    token: decrypt(row.token_ciphertext),
  }))
}

/** Records a verification failure without discarding the credential. */
export async function recordFailure(
  db: Database,
  orgId: string,
  provider: IntegrationProvider,
  projectId: string | null,
  error: string
): Promise<void> {
  await db.query(
    projectId === null
      ? `UPDATE integrations SET last_error = $3 WHERE org_id = $1 AND provider = $2 AND project_id IS NULL`
      : `UPDATE integrations SET last_error = $4 WHERE org_id = $1 AND provider = $2 AND project_id = $3`,
    projectId === null ? [orgId, provider, error] : [orgId, provider, projectId, error]
  )
}

function toSummary(row: IntegrationRow): IntegrationSummary {
  return {
    provider: row.provider,
    projectId: row.project_id,
    tokenPrefix: row.token_prefix,
    accountLogin: row.account_login,
    scopes: row.scopes ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    lastError: row.last_error,
  }
}
