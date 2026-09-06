import type { FastifyInstance } from 'fastify'
import {
  APPROVAL_CHOICES,
  DEFAULT_ROUTE_GUARD,
  isApprovalChoice,
  SENTINEL0_LABELS,
  PROMPT_CATALOG,
  PROMPT_VARIABLES,
  ROUTE_CATALOG,
  validateRoutingRule,
  type RoutingRule,
} from '@sentinel0/common'
import { authenticate, generateKey, newId, parseBearer, type AuthContext } from '../auth.js'
import type { Database } from '../db.js'

/**
 * A ceiling on a hand-written prompt.
 *
 * Not a guess at what an agent will accept -- Hermes decides that -- but a
 * bound on what a single request can push into a JSONB column and back out
 * through every runner's command poll.
 */
const MAX_PROMPT_LENGTH = 20_000

/**
 * The human-facing API.
 *
 * This is the contract `packages/dashboard` will consume, so it is shaped for a
 * UI from the start: list endpoints are paged, mutations return the stored
 * object, and nothing here requires knowing how the runner works.
 */
export function registerUserRoutes(app: FastifyInstance, db: Database): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/') || request.url.startsWith('/v1/runner/')) {
      return
    }
    const auth = await authenticate(db, parseBearer(request.headers.authorization), 'user')
    if (!auth) {
      return reply.code(401).send({ error: 'A user API key is required.' })
    }
    ;(request as { auth?: AuthContext }).auth = auth
  })

  const authOf = (request: unknown): AuthContext => (request as { auth: AuthContext }).auth

  // ── Identity ───────────────────────────────────────────────

  /**
   * Resolves the presented key to the org behind it.
   *
   * The dashboard needs this: a key is the whole of its login, so it has to be
   * able to check one before storing it, and show whose org it opened. Every
   * other endpoint would answer the "is this key valid" half, but none names
   * the organization, and picking an arbitrary one to probe with would make an
   * unrelated endpoint's failure look like a rejected key.
   */
  app.get('/v1/me', async (request) => {
    const { orgId, keyId } = authOf(request)
    const { rows } = await db.query(
      `SELECT o.id, o.name, o.created_at, k.name AS key_name, k.prefix AS key_prefix
       FROM organizations o JOIN api_keys k ON k.org_id = o.id
       WHERE o.id = $1 AND k.id = $2`,
      [orgId, keyId]
    )
    const row = rows[0] as
      | { id: string; name: string; created_at: string; key_name: string; key_prefix: string }
      | undefined

    return {
      org: { id: orgId, name: row?.name ?? orgId, createdAt: row?.created_at ?? null },
      key: {
        id: keyId,
        name: row?.key_name ?? null,
        prefix: row?.key_prefix ?? null,
        scope: 'user',
      },
    }
  })

  // ── Runners and agents ─────────────────────────────────────

  /**
   * Runners and how they are doing.
   *
   * `stale` is the whole point of the endpoint, so the threshold matters: the
   * runner heartbeats every 30 seconds, and 90 allows three to be missed before
   * anything is reported wrong. A shorter window would report every transient
   * network blip as an outage.
   */
  app.get('/v1/runners', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query(
      `SELECT id, name, hostname, version, last_seen_at, started_at,
              hermes_ok, hermes_detail, active_runs, last_error, recent_skips,
              (last_seen_at < now() - interval '90 seconds') AS stale
       FROM runners WHERE org_id = $1 ORDER BY name`,
      [orgId]
    )
    return { runners: rows }
  })

  app.get('/v1/agents', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query(
      `SELECT a.id, a.profile, a.display_name, a.role, a.model, a.provider,
              a.toolsets, a.skills, a.github_login, a.avatar_url, a.enabled, a.synced_at,
              a.status, a.current_run_id, a.status_at,
              r.name AS runner, (r.last_seen_at < now() - interval '90 seconds') AS runner_stale
       FROM agents a JOIN runners r ON r.id = a.runner_id
       WHERE a.org_id = $1 ORDER BY a.profile`,
      [orgId]
    )
    return { agents: rows }
  })

  // ── Projects ───────────────────────────────────────────────

  app.get('/v1/projects', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query(
      'SELECT id, provider, filters FROM projects WHERE org_id = $1 ORDER BY id',
      [orgId]
    )
    return { projects: rows }
  })

  app.post('/v1/projects', async (request, reply) => {
    const { orgId } = authOf(request)
    const body = request.body as { id?: string; provider?: string; filters?: unknown }

    if (!body.id || !body.provider) {
      return reply.code(400).send({ error: 'id and provider are required.' })
    }
    if (body.provider !== 'github' && body.provider !== 'linear') {
      return reply.code(400).send({ error: 'provider must be "github" or "linear".' })
    }

    await db.query(
      `INSERT INTO projects (id, org_id, provider, filters) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, filters = EXCLUDED.filters`,
      [body.id, orgId, body.provider, JSON.stringify(body.filters ?? {})]
    )
    return reply.code(201).send({ id: body.id })
  })

  app.delete('/v1/projects/:id', async (request) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    await db.query('DELETE FROM projects WHERE org_id = $1 AND id = $2', [orgId, id])
    return { ok: true }
  })

  // ── Routes ─────────────────────────────────────────────────

  app.get('/v1/routes', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query<{ definition: RoutingRule }>(
      'SELECT definition FROM routes WHERE org_id = $1 ORDER BY priority DESC, id',
      [orgId]
    )
    return { routes: rows.map((row: { definition: RoutingRule }) => row.definition) }
  })

  app.post('/v1/routes', async (request, reply) => {
    const { orgId } = authOf(request)
    const route = request.body as RoutingRule

    const problem = validateRoutingRule(route)
    if (problem) {
      return reply.code(400).send({ error: problem })
    }

    const id = route.id || newId('rt')
    // Stored explicitly rather than left to the runner's default, so what a
    // route will do is visible in the API rather than implied.
    const stored: RoutingRule = { ...route, id, guard: { ...DEFAULT_ROUTE_GUARD, ...route.guard } }

    await db.query(
      `INSERT INTO routes (id, org_id, name, priority, enabled, definition, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, priority = EXCLUDED.priority,
                                      enabled = EXCLUDED.enabled, definition = EXCLUDED.definition,
                                      updated_at = now()`,
      [
        id,
        orgId,
        stored.name,
        stored.priority ?? 0,
        stored.enabled !== false,
        JSON.stringify(stored),
      ]
    )
    return reply.code(201).send({ route: stored })
  })

  app.get('/v1/routes/:id', async (request, reply) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const { rows } = await db.query<{ definition: RoutingRule }>(
      'SELECT definition FROM routes WHERE org_id = $1 AND id = $2',
      [orgId, id]
    )
    if (rows.length === 0) {
      return reply.code(404).send({ error: `Route "${id}" not found.` })
    }
    return { route: rows[0].definition }
  })

  /**
   * Replaces a route in place.
   *
   * A full replacement rather than a partial merge. A route is a single
   * decision — trigger, match, target, execution, outcome — and the parts
   * constrain each other: a `githubLogin` target is valid on a pull request
   * trigger and invalid on a ticket one. Merging a field at a time would let a
   * caller move a route through states the validator rejects as a whole, so the
   * body is validated as the complete rule it will become.
   *
   * The id in the path wins over any id in the body, so a copy-pasted
   * definition cannot rewrite a different route.
   */
  app.put('/v1/routes/:id', async (request, reply) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const body = request.body as RoutingRule

    const route: RoutingRule = { ...body, id }
    const problem = validateRoutingRule(route)
    if (problem) {
      return reply.code(400).send({ error: problem })
    }

    const stored: RoutingRule = { ...route, guard: { ...DEFAULT_ROUTE_GUARD, ...route.guard } }
    const { rowCount } = await db.query(
      `UPDATE routes
          SET name = $3, priority = $4, enabled = $5, definition = $6, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [
        orgId,
        id,
        stored.name,
        stored.priority ?? 0,
        stored.enabled !== false,
        JSON.stringify(stored),
      ]
    )

    // Not an upsert: PUT to a route that does not exist is a mistake worth
    // reporting, not a reason to create one under a caller-chosen id.
    if (rowCount === 0) {
      return reply.code(404).send({ error: `Route "${id}" not found.` })
    }
    return { route: stored }
  })

  app.delete('/v1/routes/:id', async (request) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    await db.query('DELETE FROM routes WHERE org_id = $1 AND id = $2', [orgId, id])
    return { ok: true }
  })

  /**
   * Starter prompts and the placeholders they can use.
   *
   * The dashboard prefills its prompt editor from this; nothing dispatches by
   * template id, so changing the catalog never alters an existing route.
   */
  app.get('/v1/prompt-templates', async () => ({
    templates: PROMPT_CATALOG,
    variables: PROMPT_VARIABLES,
  }))

  /**
   * Complete, ready-to-create routes for every supported case.
   *
   * Each carries `<PLACEHOLDER>` tokens a user fills in, distinct from the
   * `{{variables}}` the runner substitutes at dispatch. Every entry is verified
   * against this same API's validator in CI, so picking one and filling it in
   * always produces a route the API accepts.
   */
  app.get('/v1/route-templates', async () => ({
    templates: ROUTE_CATALOG,
    defaultGuard: DEFAULT_ROUTE_GUARD,
  }))

  /** Labels Sentinel0 manages itself, for a dashboard to render distinctly. */
  app.get('/v1/reserved-labels', async () => ({
    labels: SENTINEL0_LABELS,
    defaultGuard: DEFAULT_ROUTE_GUARD,
  }))

  // ── Runs ───────────────────────────────────────────────────

  app.get('/v1/runs', async (request) => {
    const { orgId } = authOf(request)
    const query = request.query as { limit?: string; status?: string }
    const limit = Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200)

    const { rows } = await db.query(
      `SELECT id, route_name, agent_profile, project_id, trigger_ref, trigger_url, title,
              status, summary, error, hermes_run_id, approval_detail,
              started_at, ended_at, updated_at
       FROM runs WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY updated_at DESC LIMIT $3`,
      [orgId, query.status ?? null, limit]
    )
    return { runs: rows }
  })

  app.get('/v1/runs/:id', async (request, reply) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const { rows } = await db.query('SELECT * FROM runs WHERE org_id = $1 AND id = $2', [orgId, id])
    if (rows.length === 0) {
      return reply.code(404).send({ error: `Run "${id}" not found.` })
    }
    return { run: rows[0] }
  })

  app.get('/v1/runs/:id/events', async (request) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const query = request.query as { since?: string; limit?: string }

    const { rows } = await db.query(
      `SELECT e.title, e.message, e.icon, e.level, e.kind, e.source, e.group_id, e.ts
       FROM run_events e JOIN runs r ON r.id = e.run_id
       WHERE r.org_id = $1 AND e.run_id = $2 AND e.ts >= $3
       ORDER BY e.ts ASC, e.id ASC LIMIT $4`,
      [
        orgId,
        id,
        Number.parseInt(query.since ?? '0', 10) || 0,
        Math.min(Number.parseInt(query.limit ?? '500', 10) || 500, 2000),
      ]
    )
    return { events: rows }
  })

  /**
   * Queue a manual dispatch for the runner to pick up on its next poll.
   *
   * Two shapes, and exactly one per request:
   *
   * - `{ event }` synthesises a trigger and puts it through the rule engine, so
   *   it starts whichever agent a route would have started. This is "run that
   *   ticket now".
   * - `{ agentProfile, prompt }` starts one named agent on the operator's own
   *   text, with no route and no trigger involved at all. This is "ask this
   *   agent to do this thing".
   *
   * Sending both is rejected rather than resolved by precedence: they answer
   * different questions, and guessing which one was meant would start the wrong
   * agent on the wrong work.
   */
  app.post('/v1/runs', async (request, reply) => {
    const { orgId } = authOf(request)
    const body = request.body as {
      event?: unknown
      prompt?: unknown
      agentProfile?: unknown
      runnerId?: unknown
      title?: unknown
    }

    const wantsPrompt = body.prompt !== undefined || body.agentProfile !== undefined
    if (body.event !== undefined && wantsPrompt) {
      return reply
        .code(400)
        .send({ error: 'Send either event, or agentProfile and prompt — not both.' })
    }

    if (wantsPrompt) {
      const agentProfile = typeof body.agentProfile === 'string' ? body.agentProfile.trim() : ''
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

      if (!agentProfile) {
        return reply.code(400).send({ error: 'agentProfile is required.' })
      }
      if (!prompt) {
        return reply.code(400).send({ error: 'prompt is required and cannot be blank.' })
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return reply
          .code(400)
          .send({ error: `prompt is limited to ${MAX_PROMPT_LENGTH} characters.` })
      }

      // The agent decides the machine. Resolving it here rather than trusting
      // the caller means a dashboard left open across an inventory change
      // cannot address a command to a runner that no longer has the profile --
      // which would queue a command nothing ever answers.
      const { rows } = await db.query<{ runner_id: string; runner_name: string; enabled: boolean }>(
        `SELECT a.runner_id, r.name AS runner_name, a.enabled
         FROM agents a JOIN runners r ON r.id = a.runner_id
         WHERE a.org_id = $1 AND a.profile = $2
           AND ($3::text IS NULL OR a.runner_id = $3)`,
        [orgId, agentProfile, typeof body.runnerId === 'string' ? body.runnerId : null]
      )
      const agent = rows[0]
      if (!agent) {
        return reply
          .code(404)
          .send({ error: `No agent "${agentProfile}" is registered on that runner.` })
      }
      if (!agent.enabled) {
        return reply.code(409).send({ error: `Agent "${agentProfile}" is disabled.` })
      }

      const id = newId('cmd')
      await db.query(
        `INSERT INTO runner_commands (id, org_id, runner_id, type, payload)
         VALUES ($1,$2,$3,'run-prompt',$4)`,
        [
          id,
          orgId,
          agent.runner_id,
          JSON.stringify({
            agentProfile,
            prompt,
            title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
          }),
        ]
      )
      return reply.code(202).send({ queued: id, runner: agent.runner_name })
    }

    if (!body.event) {
      return reply.code(400).send({ error: 'event is required.' })
    }
    const id = newId('cmd')
    await db.query(
      `INSERT INTO runner_commands (id, org_id, type, payload) VALUES ($1,$2,'run',$3)`,
      [id, orgId, JSON.stringify({ event: body.event })]
    )
    return reply.code(202).send({ queued: id })
  })

  /**
   * Answer an agent that has stopped for permission.
   *
   * Addressed at the runner holding the run, unlike cancel: an approval reaching
   * the wrong machine is not merely useless, it is a command that will never be
   * answered and that nothing will retry. The run row records which runner
   * mirrored it, so there is no guessing.
   */
  app.post('/v1/runs/:id/approval', async (request, reply) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const { choice } = (request.body ?? {}) as { choice?: unknown }

    if (!isApprovalChoice(choice)) {
      return reply
        .code(400)
        .send({ error: `choice must be one of: ${APPROVAL_CHOICES.join(', ')}.` })
    }

    const { rows } = await db.query<{ runner_id: string | null; status: string }>(
      'SELECT runner_id, status FROM runs WHERE org_id = $1 AND id = $2',
      [orgId, id]
    )
    const run = rows[0]
    if (!run) {
      return reply.code(404).send({ error: `Run "${id}" not found.` })
    }
    if (run.status !== 'awaiting_approval') {
      return reply.code(409).send({ error: `Run "${id}" is ${run.status}, not awaiting approval.` })
    }

    const commandId = newId('cmd')
    await db.query(
      `INSERT INTO runner_commands (id, org_id, runner_id, type, payload)
       VALUES ($1,$2,$3,'approve',$4)`,
      [commandId, orgId, run.runner_id, JSON.stringify({ runId: id, choice })]
    )
    return reply.code(202).send({ queued: commandId, choice })
  })

  app.post('/v1/runs/:id/cancel', async (request, reply) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    const commandId = newId('cmd')
    await db.query(
      `INSERT INTO runner_commands (id, org_id, type, payload) VALUES ($1,$2,'cancel',$3)`,
      [commandId, orgId, JSON.stringify({ runId: id })]
    )
    return reply.code(202).send({ queued: commandId })
  })

  app.post('/v1/resync', async (request, reply) => {
    const { orgId } = authOf(request)
    const commandId = newId('cmd')
    await db.query(
      `INSERT INTO runner_commands (id, org_id, type, payload) VALUES ($1,$2,'resync','{}'::jsonb)`,
      [commandId, orgId]
    )
    return reply.code(202).send({ queued: commandId })
  })

  // ── Slack ──────────────────────────────────────────────────

  app.get('/v1/integrations/slack', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query(
      'SELECT enabled, events, created_at FROM slack_integrations WHERE org_id = $1',
      [orgId]
    )
    // The webhook URL is a credential: report that one is configured, never what.
    return { configured: rows.length > 0, ...(rows[0] ?? {}) }
  })

  app.put('/v1/integrations/slack', async (request, reply) => {
    const { orgId } = authOf(request)
    const body = request.body as { webhookUrl?: string; events?: string[]; enabled?: boolean }

    // Slack's own host, unless an operator has deliberately pointed the
    // notifier somewhere else (a sink, a relay) via SLACK_WEBHOOK_HOST.
    const allowedPrefix = process.env.SLACK_WEBHOOK_HOST ?? 'https://hooks.slack.com/'
    if (!body.webhookUrl?.startsWith(allowedPrefix)) {
      return reply.code(400).send({ error: `webhookUrl must start with ${allowedPrefix}` })
    }

    await db.query(
      `INSERT INTO slack_integrations (org_id, webhook_url, enabled)
       VALUES ($1,$2,$3)
       ON CONFLICT (org_id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url,
                                          enabled = EXCLUDED.enabled`,
      [orgId, body.webhookUrl, body.enabled !== false]
    )
    if (body.events?.length) {
      await db.query('UPDATE slack_integrations SET events = $2 WHERE org_id = $1', [
        orgId,
        body.events,
      ])
    }
    return { ok: true }
  })

  app.delete('/v1/integrations/slack', async (request) => {
    const { orgId } = authOf(request)
    await db.query('DELETE FROM slack_integrations WHERE org_id = $1', [orgId])
    return { ok: true }
  })

  // ── API keys ───────────────────────────────────────────────

  app.get('/v1/keys', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query(
      `SELECT id, name, scope, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId]
    )
    return { keys: rows }
  })

  /** Mints a key. This is the only time the plaintext is ever available. */
  app.post('/v1/keys', async (request, reply) => {
    const { orgId } = authOf(request)
    const body = request.body as { name?: string; scope?: string }

    if (body.scope !== 'runner' && body.scope !== 'user') {
      return reply.code(400).send({ error: 'scope must be "runner" or "user".' })
    }

    const { key, hash, prefix } = generateKey(body.scope)
    const id = newId('key')
    await db.query(
      'INSERT INTO api_keys (id, org_id, name, scope, key_hash, prefix) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, orgId, body.name ?? body.scope, body.scope, hash, prefix]
    )
    return reply.code(201).send({ id, key, scope: body.scope, prefix })
  })

  app.delete('/v1/keys/:id', async (request) => {
    const { orgId } = authOf(request)
    const { id } = request.params as { id: string }
    await db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL',
      [orgId, id]
    )
    return { ok: true }
  })
}
