import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import {
  APPROVAL_CHOICES,
  isApprovalChoice,
  type AgentDescriptor,
  type AppConfig,
  type ApprovalChoice,
  type ProjectConfig,
  type RoutingRule,
  type RunStatus,
  type TriggerEvent,
} from '@sentinel0/common'
import type { Sentinel0Database } from '../database.js'
import { readRunnerErrors } from './diagnostics.js'
import { isAllowedBrowserOrigin } from './network-access.js'
import { explainRule } from '../routing/rule-engine.js'

export interface ApiServerDeps {
  getConfig: () => AppConfig
  getProjects: () => ProjectConfig[]
  getAgents: () => AgentDescriptor[]
  getRoutes: () => RoutingRule[]
  reload: () => Promise<AppConfig>
  cancelRun: (runId: string) => Promise<boolean>
  approveRun: (runId: string, choice: ApprovalChoice) => Promise<{ ok: boolean; reason?: string }>
  db: Sentinel0Database
  dataDir: string
  /**
   * Re-collects triggers for one project, or for all of them.
   *
   * Separate from the poll loop's own collection so that asking the question
   * does not record an answer: see `explainRouting`.
   */
  collectTriggers: (projectId?: string) => Promise<TriggerEvent[]>
}

/**
 * Why every route did or did not select every trigger currently visible.
 *
 * Deliberately computed live rather than read from a log. The failure this
 * addresses is a route that produces no output at all, and the operator's
 * question is always about the item in front of them right now -- so the
 * useful answer names that item, that route, and the one clause that rejected
 * it, rather than a cycle summary that says `no-route` about a repository.
 *
 * It reads history through `changesSince` and never calls `observe`, because a
 * diagnostic that advanced the baseline would consume the very transition the
 * operator is asking about, and answer differently the second time it is asked.
 */
function explainRouting(
  deps: ApiServerDeps,
  events: readonly TriggerEvent[],
  routes: readonly RoutingRule[]
) {
  return events.map((event) => {
    const changes = deps.db.changesSince(event.projectId, event.ref, {
      labels: event.labels,
      assignees: event.assignees ?? [],
      reviewers: event.requestedReviewers ?? [],
    })
    const observed = { ...event, changes }

    const verdicts = routes.map((route) => {
      const reason = explainRule(route, observed)
      return {
        routeId: route.id,
        routeName: route.name,
        matched: reason === undefined,
        reason,
      }
    })

    return {
      ref: event.ref,
      type: event.type,
      projectId: event.projectId,
      title: event.title,
      url: event.url,
      labels: event.labels,
      assignees: event.assignees ?? [],
      requestedReviewers: event.requestedReviewers ?? [],
      /** Absent means this item has never been polled before. */
      changes,
      /**
       * A matching route still may not run: the dispatch ledger, the one-run-
       * per-agent rule and agent resolution all come after this point, and the
       * cycle summary reports those as `duplicate`, `agent-busy` and
       * `unknown-agent` respectively.
       */
      verdicts,
    }
  })
}

function parsePositiveInt(raw: unknown, label: string, fallback: number): number {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(String(raw), 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

/**
 * The runner's local API.
 *
 * Intentionally read-mostly. Configuration lives in the cloud now, so this
 * surface exists for the CLI on the same machine: check health, watch runs,
 * tail logs, cancel something. It is unauthenticated and binds to loopback
 * unless network access is explicitly enabled.
 */
export async function createApiServer(deps: ApiServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const networkAccess = deps.getConfig().server.networkAccess

  await app.register(cors, {
    delegator: (req, callback) => {
      const origin = req.headers.origin
      callback(null, {
        origin: !origin || isAllowedBrowserOrigin(origin, req.headers.host, networkAccess),
      })
    },
  })

  app.get('/runtime/health', async () => {
    const config = deps.getConfig()
    return {
      status: 'ok',
      version: process.env.SENTINEL0_VERSION ?? 'dev',
      projects: deps.getProjects().length,
      agents: deps.getAgents().length,
      routes: deps.getRoutes().length,
      cloud: config.cloud ? 'configured' : 'none',
      hermes: config.hermes?.baseUrl ?? null,
    }
  })

  app.get('/runtime/errors', async () => readRunnerErrors(deps.dataDir))

  app.post('/runtime/reload', async (_request, reply) => {
    try {
      await deps.reload()
      return { ok: true, projects: deps.getProjects().length, routes: deps.getRoutes().length }
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/projects', async () => ({ projects: deps.getProjects() }))

  app.get('/agents', async () => ({ agents: deps.getAgents() }))

  app.get('/routes', async () => ({ routes: deps.getRoutes() }))

  app.get('/routes/explain', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const projectId = query.project
    if (projectId && !deps.getProjects().some((project) => project.id === projectId)) {
      return reply.code(404).send({ error: `No project "${projectId}" is configured.` })
    }

    try {
      const events = await deps.collectTriggers(projectId)
      const wanted = query.ref
      return {
        items: explainRouting(
          deps,
          wanted ? events.filter((event) => event.ref === wanted) : events,
          deps.getRoutes()
        ),
      }
    } catch (error: unknown) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/runs', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    try {
      return {
        runs: deps.db.listRuns({
          limit: parsePositiveInt(query.limit, 'limit', 100),
          projectId: query.projectId,
          status: query.status as RunStatus | undefined,
        }),
      }
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const run = deps.db.getRun(runId)
    if (!run) {
      return reply.code(404).send({ error: `Run "${runId}" not found.` })
    }
    return { run }
  })

  app.get('/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const query = request.query as Record<string, string | undefined>

    if (!deps.db.getRun(runId)) {
      return reply.code(404).send({ error: `Run "${runId}" not found.` })
    }
    try {
      return {
        events: deps.db.listRunEvents(runId, {
          since: query.since ? Number.parseInt(query.since, 10) : undefined,
          limit: parsePositiveInt(query.limit, 'limit', 500),
        }),
      }
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * Answer a pending approval.
   *
   * Loopback and unauthenticated like the rest of this server, and reached
   * either by `sentinel0 approve` or by the cloud relaying a dashboard button.
   */
  app.post('/runs/:runId/approval', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const { choice } = (request.body ?? {}) as { choice?: unknown }
    if (!isApprovalChoice(choice)) {
      return reply
        .code(400)
        .send({ error: `choice must be one of: ${APPROVAL_CHOICES.join(', ')}.` })
    }
    const result = await deps.approveRun(runId, choice)
    if (!result.ok) {
      return reply.code(409).send({ error: result.reason })
    }
    return { ok: true, runId, choice }
  })

  app.post('/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string }
    const canceled = await deps.cancelRun(runId)
    if (!canceled) {
      return reply.code(404).send({ error: `Run "${runId}" not found.` })
    }
    return { ok: true, runId }
  })

  return app
}
