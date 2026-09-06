import type { FastifyInstance } from 'fastify'
import type { AgentDescriptor, RoutingRule, RunLogEntry, RunRecord } from '@sentinel0/common'
import { authenticate, newId, parseBearer, type AuthContext } from '../auth.js'
import type { Database } from '../db.js'
import { notifyRunEvent } from '../notifications/slack.js'

/** How long a command long-poll may be held open. */
const MAX_WAIT_SECONDS = 30
const POLL_TICK_MS = 500

async function requireRunner(
  db: Database,
  header: string | undefined
): Promise<AuthContext | undefined> {
  return authenticate(db, parseBearer(header), 'runner')
}

/** The only agent states a runner may report; anything else is ignored. */
const AGENT_STATUSES = ['idle', 'busy', 'awaiting_approval']

export function registerRunnerRoutes(app: FastifyInstance, db: Database): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/runner/')) {
      return
    }
    const auth = await requireRunner(db, request.headers.authorization)
    if (!auth) {
      return reply.code(401).send({ error: 'A runner API key is required.' })
    }
    ;(request as { auth?: AuthContext }).auth = auth

    // Any authenticated runner call is proof of life, and the command long-poll
    // makes one roughly every 25 seconds on its own. Touching last_seen_at here
    // means liveness never depends on the runner remembering to say so — a
    // runner on an older build, which never sends a heartbeat, still reports as
    // alive because it is still polling.
    //
    // Scoped to the runner that made the call. Without the name filter this
    // marked every runner in the org alive whenever any one of them called,
    // which makes the staleness flag meaningless the moment there are two.
    //
    // Fire-and-forget: liveness bookkeeping must not fail a real request.
    const name = callerName(request)
    if (name) {
      void db
        .query('UPDATE runners SET last_seen_at = now() WHERE org_id = $1 AND name = $2', [
          auth.orgId,
          name,
        ])
        .catch(() => undefined)
    }
  })

  const authOf = (request: unknown): AuthContext => (request as { auth: AuthContext }).auth

  // ── Registration / heartbeat ───────────────────────────────

  app.post('/v1/runner/hello', async (request) => {
    const { orgId } = authOf(request)
    const { name, hostname, version } = request.body as {
      name: string
      hostname?: string
      version?: string
    }

    // started_at is set from the server clock on every hello, because hello is
    // sent exactly once per process. It is the runner's uptime, not the age of
    // the row, and resetting it on re-registration is the point: a restart is
    // the thing an operator wants to see.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO runners (id, org_id, name, hostname, version, last_seen_at, started_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (org_id, name)
       DO UPDATE SET hostname = EXCLUDED.hostname,
                     version = EXCLUDED.version,
                     last_seen_at = now(),
                     started_at = now(),
                     last_error = NULL
       RETURNING id`,
      [newId('rnr'), orgId, name, hostname ?? null, version ?? null]
    )

    return { runnerId: rows[0].id, routesRevision: String(Date.now()) }
  })

  /**
   * Periodic health, richer than "it is still there".
   *
   * The runner is behind NAT and accepts no inbound connections, so the
   * dashboard can never call the runner — health has to be pushed. Every field
   * is optional so an older runner, which sends none of them, still registers
   * and still reads as alive.
   */
  app.post('/v1/runner/heartbeat', async (request, reply) => {
    const { orgId } = authOf(request)
    const body = request.body as {
      name?: string
      startedAt?: string
      hermesOk?: boolean
      hermesDetail?: string
      activeRuns?: number
      lastError?: string | null
      agents?: Array<{ profile?: string; status?: string; runId?: string }>
      skips?: unknown[]
    }

    if (!body.name) {
      return reply.code(400).send({ error: 'name is required.' })
    }

    const { rowCount } = await db.query(
      `UPDATE runners
          SET last_seen_at      = now(),
              started_at        = COALESCE($3::timestamptz, started_at),
              hermes_ok         = $4,
              hermes_detail     = $5,
              active_runs       = $6,
              last_error        = $7,
              recent_skips      = COALESCE($8::jsonb, recent_skips),
              stale_notified_at = NULL
        WHERE org_id = $1 AND name = $2`,
      [
        orgId,
        body.name,
        body.startedAt ?? null,
        body.hermesOk ?? null,
        body.hermesDetail ?? null,
        body.activeRuns ?? null,
        body.lastError ?? null,
        body.skips ? JSON.stringify(body.skips) : null,
      ]
    )

    // A heartbeat for a runner the cloud has never seen means the row was
    // deleted, or this runner has never said hello. Saying so lets the runner
    // re-register rather than heartbeating into the void forever.
    if (rowCount === 0) {
      return reply.code(404).send({ error: `Runner "${body.name}" is not registered.` })
    }

    // Per-agent liveness. Written here rather than inferred from run rows,
    // which is what the dashboard did and why it reported agents busy long
    // after their runs had ended.
    for (const agent of body.agents ?? []) {
      if (!agent.profile || !AGENT_STATUSES.includes(agent.status ?? '')) {
        continue
      }
      await db.query(
        `UPDATE agents SET status = $3, current_run_id = $4, status_at = now()
          FROM runners
         WHERE agents.runner_id = runners.id
           AND runners.org_id = $1 AND runners.name = $2
           AND agents.profile = $5`,
        [orgId, body.name, agent.status, agent.runId ?? null, agent.profile]
      )
    }

    return { ok: true }
  })

  // ── Inventory ──────────────────────────────────────────────

  app.put('/v1/runner/inventory', async (request, reply) => {
    const { orgId } = authOf(request)
    const { agents } = request.body as { agents: AgentDescriptor[] }

    const runner = await currentRunner(db, orgId)
    if (!runner) {
      return reply.code(409).send({ error: 'Call /v1/runner/hello before pushing inventory.' })
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      // Inventory is derived state: replacing it wholesale is what makes a
      // deleted Hermes profile disappear from the registry rather than linger.
      await client.query('DELETE FROM agents WHERE runner_id = $1', [runner])
      for (const agent of agents) {
        await client.query(
          `INSERT INTO agents (id, org_id, runner_id, profile, display_name, role, model,
                               provider, toolsets, skills, github_login, avatar_url,
                               enabled, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
          [
            newId('agt'),
            orgId,
            runner,
            agent.profile,
            agent.displayName ?? null,
            agent.role ?? null,
            agent.model ?? null,
            agent.provider ?? null,
            JSON.stringify(agent.toolsets ?? []),
            JSON.stringify(agent.skills ?? []),
            agent.githubLogin ?? null,
            agent.avatarUrl ?? null,
            agent.enabled,
          ]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return { ok: true, count: agents.length }
  })

  // ── Projects ───────────────────────────────────────────────

  // The runner has no project configuration of its own: what to watch is
  // decided in the cloud, so it has to be able to read it back.
  app.get('/v1/runner/projects', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query<{ id: string; provider: string; filters: unknown }>(
      'SELECT id, provider, filters FROM projects WHERE org_id = $1 ORDER BY id',
      [orgId]
    )
    return { projects: rows }
  })

  // ── Routes ─────────────────────────────────────────────────

  app.get('/v1/runner/routes', async (request) => {
    const { orgId } = authOf(request)
    const { rows } = await db.query<{ definition: RoutingRule; updated_at: Date }>(
      'SELECT definition, updated_at FROM routes WHERE org_id = $1 AND enabled = true ORDER BY priority DESC',
      [orgId]
    )
    const revision = rows.reduce(
      (latest: number, row) => Math.max(latest, new Date(row.updated_at).getTime()),
      0
    )
    return { revision: String(revision), routes: rows.map((row) => row.definition) }
  })

  // ── Command inbox (long poll) ──────────────────────────────

  app.get('/v1/runner/commands', async (request) => {
    const { orgId } = authOf(request)
    const query = request.query as { cursor?: string; wait?: string; runner?: string }
    const cursor = Number.parseInt(query.cursor ?? '0', 10) || 0
    const wait = Math.min(Number.parseInt(query.wait ?? '25', 10) || 25, MAX_WAIT_SECONDS)
    const runnerId = await runnerIdFor(db, orgId, query.runner)

    const deadline = Date.now() + wait * 1_000

    // Poll the table rather than using LISTEN/NOTIFY: it survives connection
    // churn and pooling, and at one runner per org the cost is negligible.
    for (;;) {
      const commands = await fetchCommands(db, orgId, cursor, runnerId)
      if (commands.length > 0 || Date.now() >= deadline) {
        return { commands }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_TICK_MS))
    }
  })

  /**
   * Acks through a cursor, for this runner's share of the queue.
   *
   * The runner filter matters as much here as on the poll. Acking by cursor
   * alone marks every org command up to that point delivered, so on a two-runner
   * org whichever polled first would ack the other's addressed commands out of
   * existence before they were ever fetched.
   */
  app.post('/v1/runner/commands/ack', async (request) => {
    const { orgId } = authOf(request)
    const { cursor, runner } = request.body as { cursor: number; runner?: string }
    const runnerId = await runnerIdFor(db, orgId, runner)
    await db.query(
      `UPDATE runner_commands SET acked_at = now()
        WHERE org_id = $1 AND cursor <= $2 AND acked_at IS NULL
          AND (runner_id IS NULL OR runner_id = $3)`,
      [orgId, cursor, runnerId]
    )
    return { ok: true }
  })

  // ── Run mirroring ──────────────────────────────────────────

  app.post('/v1/runner/runs', async (request) => {
    const { orgId } = authOf(request)
    const { run } = request.body as { run: RunRecord }
    await upsertRun(db, orgId, await currentRunner(db, orgId, callerName(request)), run)
    await notifyRunEvent(db, orgId, run, 'run.started')
    return { ok: true }
  })

  app.patch('/v1/runner/runs/:runId', async (request) => {
    const { orgId } = authOf(request)
    const { run } = request.body as { run: RunRecord }
    await upsertRun(db, orgId, await currentRunner(db, orgId, callerName(request)), run)
    await notifyRunEvent(db, orgId, run, statusEvent(run.status))
    return { ok: true }
  })

  app.post('/v1/runner/runs/:runId/events', async (request) => {
    const { runId } = request.params as { runId: string }
    const { events } = request.body as { events: RunLogEntry[] }

    for (const event of events) {
      await db.query(
        `INSERT INTO run_events (run_id, title, message, icon, level, kind, source, group_id, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          runId,
          event.title ?? null,
          event.message,
          event.icon ?? null,
          event.level,
          event.kind,
          event.source,
          event.groupId ?? null,
          event.timestamp,
        ]
      )
    }
    return { ok: true, count: events.length }
  })
}

function statusEvent(status: string): string {
  switch (status) {
    case 'completed':
      return 'run.completed'
    case 'failed':
      return 'run.failed'
    case 'canceled':
      return 'run.canceled'
    case 'awaiting_approval':
      return 'run.needs_approval'
    default:
      return 'run.started'
  }
}

/**
 * Which runner a mirrored run belongs to.
 *
 * The caller names itself on the query string; falling back to "whichever
 * runner was seen most recently" attributes one machine's runs to another as
 * soon as there are two, and is kept only so an older runner still mirrors.
 */
async function currentRunner(
  db: Database,
  orgId: string,
  name?: string | null
): Promise<string | null> {
  if (name) {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM runners WHERE org_id = $1 AND name = $2',
      [orgId, name]
    )
    if (rows[0]) {
      return rows[0].id
    }
  }
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM runners WHERE org_id = $1 ORDER BY last_seen_at DESC LIMIT 1',
    [orgId]
  )
  return rows[0]?.id ?? null
}

/** The runner's own name, as carried on every call that knows it. */
function callerName(request: { query?: unknown }): string | null {
  const query = (request.query ?? {}) as { runner?: string }
  return query.runner ? String(query.runner) : null
}

interface CommandRow {
  cursor: string
  id: string
  type: 'run' | 'cancel' | 'resync' | 'run-prompt' | 'approve'
  payload: Record<string, unknown>
}

/**
 * Resolves the polling runner's name to its id.
 *
 * Returns null when the runner does not say who it is, which an older build
 * does not. A null id matches only unaddressed commands below, so such a runner
 * keeps receiving everything it always did and never claims a command addressed
 * to a machine it is not.
 */
async function runnerIdFor(
  db: Database,
  orgId: string,
  name: string | undefined
): Promise<string | null> {
  if (!name) {
    return null
  }
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM runners WHERE org_id = $1 AND name = $2',
    [orgId, name]
  )
  return rows[0]?.id ?? null
}

async function fetchCommands(db: Database, orgId: string, cursor: number, runnerId: string | null) {
  // A null runner_id is a broadcast -- resync, and every command queued before
  // commands were addressed at all -- so it goes to whoever polls.
  const { rows } = await db.query<CommandRow>(
    `SELECT cursor, id, type, payload FROM runner_commands
     WHERE org_id = $1 AND cursor > $2 AND acked_at IS NULL
       AND (runner_id IS NULL OR runner_id = $3)
     ORDER BY cursor ASC LIMIT 50`,
    [orgId, cursor, runnerId]
  )
  return rows.map((row) => ({
    id: row.id,
    cursor: Number(row.cursor),
    type: row.type,
    payload: row.payload,
  }))
}

async function upsertRun(
  db: Database,
  orgId: string,
  runnerId: string | null,
  run: RunRecord
): Promise<void> {
  await db.query(
    `INSERT INTO runs (id, org_id, runner_id, route_id, route_name, agent_profile, project_id,
                       trigger_type, trigger_ref, trigger_revision, trigger_url, title, status,
                       hermes_run_id, hermes_session_id, approval_detail,
                       summary, error, usage, started_at, ended_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             to_timestamp($20::double precision / 1000), to_timestamp($21::double precision / 1000),
             to_timestamp($22::double precision / 1000),
             to_timestamp($23::double precision / 1000))
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       hermes_run_id = COALESCE(EXCLUDED.hermes_run_id, runs.hermes_run_id),
       hermes_session_id = COALESCE(EXCLUDED.hermes_session_id, runs.hermes_session_id),
       -- Not COALESCE: a gate that has been answered must clear, and the
       -- runner reports that by sending null.
       approval_detail = EXCLUDED.approval_detail,
       summary = COALESCE(EXCLUDED.summary, runs.summary),
       error = COALESCE(EXCLUDED.error, runs.error),
       usage = COALESCE(EXCLUDED.usage, runs.usage),
       started_at = COALESCE(EXCLUDED.started_at, runs.started_at),
       ended_at = COALESCE(EXCLUDED.ended_at, runs.ended_at),
       -- The run's own clock, not the server's. Stamping now() here ordered
       -- the dashboard by when the mirror happened to flush, which under an
       -- outage is minutes after anything actually happened.
       updated_at = EXCLUDED.updated_at`,
    [
      run.id,
      orgId,
      runnerId,
      run.routeId,
      run.routeName,
      run.agentProfile,
      run.projectId,
      run.triggerType,
      run.triggerRef,
      run.triggerRevision ?? null,
      run.triggerUrl ?? null,
      run.title,
      run.status,
      run.hermesRunId ?? null,
      run.hermesSessionId ?? null,
      run.approvalDetail ? JSON.stringify(run.approvalDetail) : null,
      run.summary ?? null,
      run.error ?? null,
      run.usage ? JSON.stringify(run.usage) : null,
      run.startedAt ?? null,
      run.endedAt ?? null,
      run.createdAt,
      run.updatedAt,
    ]
  )
}
