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
} from '@sentinel0/common'
import type { Sentinel0Database } from '../database.js'
import { readRunnerErrors } from './diagnostics.js'
import { isAllowedBrowserOrigin } from './network-access.js'

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
