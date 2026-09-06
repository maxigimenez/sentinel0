import os from 'node:os'
import pLimit from 'p-limit'
import {
  RUN_STATUS,
  isApprovalChoice,
  isTerminalRunStatus,
  sleep,
  type AgentDescriptor,
  type AppConfig,
  type ApprovalChoice,
  type ProjectConfig,
  type RoutingRule,
  type RunRecord,
  type RunStatus,
  type TriggerEvent,
} from '@sentinel0/common'
import { HostExecutor } from '@sentinel0/common/executor'
import { loadConfig, resolveDataDir } from './config-loader.js'
import { getDatabase } from './database.js'
import { logger, setLoggerDatabase, setLogLevels } from './logger.js'
import { createRunId } from './run-id.js'
import { HermesAdapter, mapHermesStatus } from './hermes/adapter.js'
import type { HermesRunState } from './hermes/types.js'
import { createClientForProfile, discoverAgents } from './hermes/discovery.js'
import { Dispatcher, type OutcomeHandlers, type PromptRunRequest } from './routing/dispatcher.js'
import { RunLifecycle } from './routing/run-lifecycle.js'
import {
  CloudClient,
  MirrorOutbox,
  type AgentHealth,
  type RunnerCommand,
  type SkipReport,
} from './cloud/client.js'
import {
  loadCachedProjects,
  loadCachedRoutes,
  saveCachedProjects,
  saveCachedRoutes,
} from './cloud/config-cache.js'
import { buildProviderServices, trackerWriterFor, triggerSourceFor } from './runtime/services.js'
import { createApiServer } from './runtime/api-server.js'
import { validateRuntimeRequirements } from './runtime/preflight.js'

/** Fallback cadence when there is no cloud to long-poll against. */
const OFFLINE_POLL_INTERVAL_MS = 20_000

/**
 * How many recent skip decisions ride along with the heartbeat.
 *
 * Bounded because this is a diagnostic tail, not a log: a runner watching a
 * busy repository skips most of what it sees, every cycle, forever.
 */
const RECENT_SKIP_LIMIT = 10

/** How often a live run's new transcript lines are pushed to the cloud. */
const EVENT_MIRROR_INTERVAL_MS = 2_000

/**
 * Heartbeat cadence.
 *
 * Deliberately independent of the poll cycle, whose length is however long the
 * work in it takes. The cloud calls a runner stale after 90 seconds, so this
 * gives six misses of margin instead of the two a cycle-paced heartbeat gave.
 */
const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Outcome handlers for a run with no tracker item behind it.
 *
 * A manual prompt has no ticket to label and no pull request to comment on.
 * The dispatcher never calls these on that path, so they exist to satisfy the
 * dependency rather than to do anything -- and throwing here would turn a
 * future mistake into a failed run instead of a silent no-op.
 */
const NO_OUTCOMES: OutcomeHandlers = {
  postComment: async () => undefined,
  updateLabels: async () => undefined,
}

const RUNNER_VERSION = process.env.SENTINEL0_VERSION ?? '0.2.0'

/**
 * Why an approval could not be delivered.
 *
 * Approvals fail for mundane, explicable reasons -- the gate already lapsed,
 * the run is not waiting, the profile is gone -- and whoever pressed the button
 * is owed the reason rather than a generic failure.
 */
export interface ApprovalResult {
  ok: boolean
  reason?: string
}

interface Runtime {
  config: AppConfig
  projects: ProjectConfig[]
  agents: AgentDescriptor[]
  adapters: Map<string, HermesAdapter>
  routes: RoutingRule[]
  cloud?: CloudClient
  outbox?: MirrorOutbox
}

function buildAdapters(config: AppConfig): Map<string, HermesAdapter> {
  const adapters = new Map<string, HermesAdapter>()
  if (!config.hermes) {
    return adapters
  }
  for (const profile of config.hermes.profiles) {
    if (!profile.enabled) {
      continue
    }
    adapters.set(
      profile.name,
      new HermesAdapter(createClientForProfile(config.hermes, profile), logger)
    )
  }
  return adapters
}

/**
 * Is Hermes answering?
 *
 * One profile is enough: the adapters all address the same gateway, so a
 * failure here means the gateway is down or the runner cannot reach it, which
 * is the condition worth reporting. Probing every profile every cycle would
 * multiply requests to say the same thing.
 *
 * Never throws — this reports health, and a health check that can take down the
 * loop it reports on is worse than no health check.
 */
async function probeHermes(
  adapters: Map<string, HermesAdapter>
): Promise<{ ok: boolean; detail: string }> {
  const first = adapters.values().next()
  if (first.done) {
    return { ok: false, detail: 'no enabled Hermes profiles' }
  }
  try {
    const capabilities = await first.value.capabilities()
    return { ok: true, detail: capabilities.model ?? capabilities.platform ?? 'reachable' }
  } catch (error: unknown) {
    return { ok: false, detail: errorMessage(error) }
  }
}

/**
 * Discovers agents and, when a cloud is configured, publishes the inventory.
 *
 * Discovery failures are reported but never fatal: five healthy profiles should
 * keep working while one has a stale key.
 */
async function refreshInventory(
  config: AppConfig,
  cloud?: CloudClient
): Promise<AgentDescriptor[]> {
  if (!config.hermes) {
    logger.warn('No Hermes configuration; no agents available. Run "sentinel0 init".')
    return []
  }

  const { agents, failures } = await discoverAgents(config.hermes)
  for (const failure of failures) {
    logger.error(`Hermes profile "${failure.profile}" is unreachable: ${failure.error}`)
  }
  logger.info(
    `Discovered ${agents.length} Hermes agent(s): ${agents.map((a) => a.profile).join(', ') || 'none'}`
  )

  if (cloud && agents.length > 0) {
    try {
      await cloud.pushInventory(agents)
    } catch (error: unknown) {
      logger.warn(`Failed to publish agent inventory: ${errorMessage(error)}`)
    }
  }

  return agents
}

/**
 * Pulls routes from the cloud, falling back to the last known good set.
 *
 * The runner must keep dispatching through a cloud outage, so a fetch failure
 * degrades to the on-disk cache rather than silently disabling every route.
 */
/**
 * Pulls the projects to watch from the cloud.
 *
 * Projects are cloud-owned configuration, not local config: `sentinel0 init`
 * never writes them. Any locally configured projects are treated as a fallback
 * for running without a control plane at all.
 */
async function refreshProjects(
  dataDir: string,
  localProjects: ProjectConfig[],
  cloud?: CloudClient
): Promise<ProjectConfig[]> {
  if (!cloud) {
    const cached = await loadCachedProjects(dataDir)
    return cached.length > 0 ? cached : localProjects
  }

  try {
    const { projects } = await cloud.fetchProjects()
    await saveCachedProjects(dataDir, projects)
    return projects
  } catch (error: unknown) {
    const cached = await loadCachedProjects(dataDir)
    logger.warn(
      `Could not fetch projects (${errorMessage(error)}); using ${cached.length} cached project(s).`
    )
    return cached.length > 0 ? cached : localProjects
  }
}

async function refreshRoutes(dataDir: string, cloud?: CloudClient): Promise<RoutingRule[]> {
  if (!cloud) {
    return loadCachedRoutes(dataDir)
  }

  try {
    const { routes } = await cloud.fetchRoutes()
    await saveCachedRoutes(dataDir, routes)
    return routes
  } catch (error: unknown) {
    const cached = await loadCachedRoutes(dataDir)
    logger.warn(
      `Could not fetch routes (${errorMessage(error)}); using ${cached.length} cached route(s).`
    )
    return cached
  }
}

async function collectEvents(
  project: ProjectConfig,
  services: ReturnType<typeof buildProviderServices>
): Promise<TriggerEvent[]> {
  try {
    return await triggerSourceFor(project, services).collect(project)
  } catch (error: unknown) {
    logger.error(`Trigger collection failed for project "${project.id}": ${errorMessage(error)}`)
    return []
  }
}

async function main(): Promise<void> {
  const executor = new HostExecutor()
  const dataDir = resolveDataDir()
  const db = getDatabase()
  setLoggerDatabase(db)

  let config = await loadConfig()
  setLogLevels(config.logs)
  await validateRuntimeRequirements(config, executor)

  const cloud = config.cloud ? new CloudClient(config.cloud) : undefined
  const outbox = cloud
    ? new MirrorOutbox(cloud, db, (message: string) => logger.warn(message))
    : undefined
  // Whatever the last process did not manage to send goes out now, before any
  // new work is collected -- a restart is precisely when the cloud is most out
  // of date.
  outbox?.start()

  if (cloud) {
    try {
      const hello = await cloud.hello(os.hostname(), RUNNER_VERSION)
      logger.success(`Registered with Sentinel0 cloud as runner ${hello.runnerId}`)
    } catch (error: unknown) {
      // Not fatal: a runner that cannot reach the cloud still dispatches from
      // its cached routes, which is the whole point of caching them.
      logger.warn(`Cloud registration failed: ${errorMessage(error)}`)
    }
  } else {
    logger.warn('No cloud configured; routes will be read from the local cache only.')
  }

  const runtime: Runtime = {
    config,
    projects: await refreshProjects(dataDir, config.projects, cloud),
    agents: await refreshInventory(config, cloud),
    adapters: buildAdapters(config),
    routes: await refreshRoutes(dataDir, cloud),
    cloud,
    outbox,
  }

  logger.info(
    `Watching ${runtime.projects.length} project(s): ${runtime.projects.map((p) => p.id).join(', ') || 'none'}`
  )
  logger.info(`Loaded ${runtime.routes.length} route(s).`)

  if (runtime.projects.length === 0) {
    logger.warn(
      'No projects to watch, so nothing will ever trigger. Register one against the cloud: POST /v1/projects'
    )
  }
  if (runtime.routes.length === 0) {
    logger.warn('No routes loaded, so no trigger can start an agent. POST /v1/routes')
  }

  /*
   * How much of each run's transcript the cloud already has.
   *
   * Shipping the whole log once, at the end, meant a half-hour run showed an
   * empty event list in the dashboard for half an hour -- while the run detail
   * screen polled it every ten seconds. Batching by high-water id instead sends
   * the same rows, just while they still matter.
   */
  const mirroredEventIds = new Map<string, number>()

  const mirrorNewEvents = (runId: string): void => {
    if (!outbox) {
      return
    }
    const since = mirroredEventIds.get(runId) ?? 0
    const rows = db.listRunEventsSince(runId, since)
    if (rows.length === 0) {
      return
    }
    mirroredEventIds.set(runId, rows[rows.length - 1].id)
    outbox.enqueue({ kind: 'events', runId, events: rows.map((row) => row.entry) })
  }

  // Mirroring runs upward is what populates cloud run history and, through it,
  // fires the org's Slack notifications. It goes through the outbox so a cloud
  // outage degrades reporting rather than stalling a run.
  const lifecycle = new RunLifecycle(db, logger, {
    created: (run) => outbox?.enqueue({ kind: 'run', run }),
    changed: (run) => outbox?.enqueue({ kind: 'run-update', run }),
    settled: (run) => {
      // A final sweep for anything the streaming mirror had not reached yet.
      // Events are shipped as they happen (see mirrorNewEvents); this closes
      // the gap between the last batch and the run ending.
      mirrorNewEvents(run.id)
      mirroredEventIds.delete(run.id)
    },
  })
  const limit = pLimit(config.concurrency)
  const inFlight = new Map<string, AbortController>()

  /*
   * Routing decisions that produced no run.
   *
   * "The agent was busy, so your pull request is waiting" is the single most
   * useful thing this system can say when it appears to have done nothing, and
   * until now it said it only to a log file on the runner's own disk.
   */
  const recentSkips: SkipReport[] = []
  const recordSkip = (skip: SkipReport): void => {
    recentSkips.push(skip)
    if (recentSkips.length > RECENT_SKIP_LIMIT) {
      recentSkips.splice(0, recentSkips.length - RECENT_SKIP_LIMIT)
    }
  }

  // Live runs push their transcript upward on their own cadence, independent of
  // the poll loop, so watching a run from the dashboard shows what is happening
  // rather than what happened.
  const eventMirrorTimer = setInterval(() => {
    for (const runId of inFlight.keys()) {
      mirrorNewEvents(runId)
    }
  }, EVENT_MIRROR_INTERVAL_MS)
  eventMirrorTimer.unref()

  let services = buildProviderServices(config, executor)

  const reload = async (): Promise<AppConfig> => {
    config = await loadConfig()
    setLogLevels(config.logs)
    await validateRuntimeRequirements(config, executor)
    runtime.config = config
    runtime.projects = await refreshProjects(dataDir, config.projects, cloud)
    runtime.adapters = buildAdapters(config)
    runtime.agents = await refreshInventory(config, cloud)
    runtime.routes = await refreshRoutes(dataDir, cloud)
    services = buildProviderServices(config, executor)
    return config
  }

  const dispatcherFor = (project: ProjectConfig) =>
    new Dispatcher({
      db,
      logger,
      lifecycle,
      outcomes: trackerWriterFor(project, services),
      adapters: runtime.adapters,
      agents: runtime.agents,
      newRunId: createRunId,
      inFlight,
    })

  const cancelRun = async (runId: string): Promise<boolean> => {
    const controller = inFlight.get(runId)
    if (controller) {
      controller.abort()
      return true
    }
    // Not running locally: it may still be alive on the Hermes side after a
    // runner restart, so stop it there too rather than only marking the row.
    const run = db.getRun(runId)
    if (run?.hermesRunId) {
      const adapter = runtime.adapters.get(run.agentProfile)
      if (adapter) {
        await adapter.cancel(run.hermesRunId).catch(() => undefined)
      }
    }
    if (run) {
      lifecycle.canceled(runId, 'Canceled by operator.')
      return true
    }
    return false
  }

  /**
   * Answers a pending approval gate on the Hermes side.
   *
   * Nothing is written locally: the adapter is still polling this run, so it
   * sees the resulting status change and drives the lifecycle itself. Recording
   * "approved" here as well would let the two disagree, and the poll is the one
   * that is right.
   */
  const approveRun = async (runId: string, choice: ApprovalChoice): Promise<ApprovalResult> => {
    const run = db.getRun(runId)
    if (!run) {
      return { ok: false, reason: `Run "${runId}" is not known to this runner.` }
    }
    if (run.status !== RUN_STATUS.AWAITING_APPROVAL) {
      return { ok: false, reason: `Run "${runId}" is ${run.status}, not awaiting approval.` }
    }
    if (!run.hermesRunId) {
      return {
        ok: false,
        reason: `Run "${runId}" never reached Hermes; there is nothing to answer.`,
      }
    }
    const adapter = runtime.adapters.get(run.agentProfile)
    if (!adapter) {
      return { ok: false, reason: `No enabled Hermes profile named "${run.agentProfile}".` }
    }

    try {
      await adapter.approve(run.hermesRunId, choice)
    } catch (error: unknown) {
      // Worth saying plainly: this is what a gate that has already lapsed looks
      // like, and the operator needs to know the run is not coming back.
      const reason = errorMessage(error)
      logger.warn(`Approval of ${runId} (${choice}) was rejected by Hermes: ${reason}`, runId)
      return { ok: false, reason }
    }

    logger.info(`Approval of ${runId} answered "${choice}"`, runId)
    return { ok: true }
  }

  /**
   * Records a run that finished while this process was not watching.
   *
   * No outcome handlers run here: the tracker item was already labelled by
   * whoever started the run, and re-deriving a comment from a transcript this
   * process never saw would be worse than saying nothing.
   */
  const settleFromHermes = (runId: string, status: RunStatus, state: HermesRunState): void => {
    if (status === RUN_STATUS.COMPLETED) {
      lifecycle.completed(runId, 'Completed while the runner was restarting.')
    } else if (status === RUN_STATUS.CANCELED) {
      lifecycle.canceled(runId, 'Canceled while the runner was restarting.')
    } else {
      lifecycle.failed(runId, state.error ?? 'Failed while the runner was restarting.')
    }
  }

  const resumeRun = async (run: RunRecord, adapter: HermesAdapter): Promise<void> => {
    const route = runtime.routes.find((candidate) => candidate.id === run.routeId)
    const project = runtime.projects.find((candidate) => candidate.id === run.projectId)
    const dispatcher = project
      ? dispatcherFor(project)
      : new Dispatcher({
          db,
          logger,
          lifecycle,
          outcomes: NO_OUTCOMES,
          adapters: runtime.adapters,
          agents: runtime.agents,
          newRunId: createRunId,
          inFlight,
        })

    logger.info(`Re-adopting run ${run.id} still live on Hermes as ${run.hermesRunId}`, run.id)
    await dispatcher.resume(run, adapter, route)
  }

  /**
   * Re-adopts or settles the runs a previous process left in flight.
   *
   * Without this every restart strands its runs: they stay `running` or
   * `awaiting_approval` in SQLite and in the cloud forever, the dashboard shows
   * phantom work, and -- worse -- each one permanently occupies its agent,
   * because the busy check counts exactly these rows.
   */
  const reconcileOrphans = async (): Promise<void> => {
    const orphans = db.listUnfinishedRuns()
    if (orphans.length === 0) {
      return
    }
    logger.info(`Reconciling ${orphans.length} run(s) left behind by a previous process.`)

    for (const run of orphans) {
      if (!run.hermesRunId) {
        lifecycle.failed(run.id, 'The runner restarted before this run reached Hermes.')
        continue
      }
      const adapter = runtime.adapters.get(run.agentProfile)
      if (!adapter) {
        lifecycle.failed(
          run.id,
          `The runner restarted and Hermes profile "${run.agentProfile}" is no longer enabled.`
        )
        continue
      }

      try {
        const state = await adapter.describe(run.hermesRunId)
        const status = mapHermesStatus(state.status)
        if (isTerminalRunStatus(status)) {
          settleFromHermes(run.id, status, state)
        } else {
          // Still alive over there. Take the run back rather than killing work
          // that is going fine.
          void resumeRun(run, adapter)
        }
      } catch (error: unknown) {
        lifecycle.failed(
          run.id,
          `The runner restarted and Hermes no longer knows this run: ${errorMessage(error)}`
        )
      }
    }
  }

  const fastify = await createApiServer({
    getConfig: () => runtime.config,
    getProjects: () => runtime.projects,
    getAgents: () => runtime.agents,
    getRoutes: () => runtime.routes,
    reload,
    cancelRun,
    approveRun,
    db,
    dataDir,
  })

  await fastify.listen({
    port: config.server.apiPort,
    host: config.server.networkAccess ? '0.0.0.0' : '127.0.0.1',
  })
  logger.success(`Runner API listening on port ${config.server.apiPort}`)

  const runDispatch = (
    project: ProjectConfig,
    event: TriggerEvent,
    tally?: CycleTally
  ): Promise<void> =>
    limit(async () => {
      const result = await dispatcherFor(project).dispatch(event, runtime.routes, (decision) => {
        if (!tally) {
          return
        }
        if (decision.outcome === 'started') {
          tally.dispatched += 1
        } else if (decision.outcome === 'skipped') {
          tally.skipped[decision.reason] = (tally.skipped[decision.reason] ?? 0) + 1
          recordSkip({ reason: decision.reason, ref: event.ref, at: Date.now() })
        } else {
          tally.failed += 1
        }
      })
      if (result.outcome === 'skipped' && result.detail) {
        logger.info(result.detail)
      }
    }).catch((error: unknown) => {
      logger.error(`Dispatch failed for ${event.ref}: ${errorMessage(error)}`)
    })

  /**
   * Runs an operator's own prompt against one agent.
   *
   * Through the same concurrency limit as routed work, because the limit is
   * about this machine's capacity and a manual run consumes exactly as much of
   * it. No project and no route are involved, so the dispatcher is built
   * without a tracker writer -- there is no ticket to comment on.
   */
  const runPrompt = (request: PromptRunRequest): Promise<void> =>
    limit(async () => {
      const result = await new Dispatcher({
        db,
        logger,
        lifecycle,
        outcomes: NO_OUTCOMES,
        adapters: runtime.adapters,
        agents: runtime.agents,
        newRunId: createRunId,
        inFlight,
      }).dispatchPrompt(request)

      if (result.outcome === 'skipped') {
        logger.warn(result.detail ?? `Manual run skipped: ${result.reason}.`)
      }
    }).catch((error: unknown) => {
      logger.error(`Manual run failed: ${errorMessage(error)}`)
    })

  /**
   * Acts on one queued command.
   *
   * Commands that start an agent are *started* and not awaited, for the same
   * reason the trigger path does not await a dispatch: a run can take half an
   * hour, and this is called from the poll loop. Awaiting one would stop the
   * runner collecting triggers, stop it handling the commands behind it in the
   * batch, and -- worst of all -- stop its heartbeat, so the dashboard would
   * report the runner as stale for exactly as long as it was busy doing what it
   * was asked. Both helpers attach their own `catch`, so nothing is unhandled.
   *
   * `cancel` and `resync` are awaited. They are fast, and their whole point is
   * to have taken effect before the next cycle reads the config they changed.
   */
  const handleCommand = async (command: RunnerCommand): Promise<void> => {
    switch (command.type) {
      case 'cancel': {
        const runId = String(command.payload.runId ?? '')
        logger.info(`Cloud requested cancellation of ${runId}`)
        await cancelRun(runId)
        break
      }
      case 'approve': {
        const runId = String(command.payload.runId ?? '')
        const choice = command.payload.choice
        if (!runId || !isApprovalChoice(choice)) {
          logger.warn('Ignoring approval command with no run id or an unknown choice.')
          return
        }
        logger.info(`Cloud requested "${choice}" on the approval for ${runId}`)
        // Awaited: the poll loop's next cycle reads the status this changes.
        const result = await approveRun(runId, choice)
        if (!result.ok) {
          logger.warn(`Approval of ${runId} was not delivered: ${result.reason}`)
        }
        break
      }
      case 'resync': {
        logger.info('Cloud requested a resync')
        await reload()
        break
      }
      case 'run': {
        // A human pressing "run this now" is just another trigger event.
        const event = command.payload.event as TriggerEvent | undefined
        const project = runtime.projects.find((entry) => entry.id === event?.projectId)
        if (!event || !project) {
          logger.warn(`Ignoring manual run command with no resolvable project.`)
          return
        }
        // Started, not awaited -- see the note on handleCommand.
        void runDispatch(project, event)
        break
      }
      case 'run-prompt': {
        const agentProfile = String(command.payload.agentProfile ?? '')
        const prompt = String(command.payload.prompt ?? '')
        const title = command.payload.title ? String(command.payload.title) : undefined
        if (!agentProfile || !prompt) {
          logger.warn('Ignoring prompt run command with no agent or no prompt.')
          return
        }
        void runPrompt({ agentProfile, prompt, title })
        break
      }
      default:
        // Named rather than ignored. The cloud is deployed independently of the
        // runners polling it, so a runner too old for a command type is a real
        // state -- and one where "nothing happened" needs an explanation.
        logger.warn(
          `Ignoring command of unknown type "${command.type}"; this runner may need updating.`
        )
    }
  }

  let cursor = 0
  let pollFailures = 0

  // Reported as the runner's uptime, so it is the moment this process came up
  // rather than the age of its row in the cloud.
  const startedAt = new Date().toISOString()
  let lastCycleError: string | null = null
  let heartbeatFailing = false

  /**
   * Tells the cloud the runner is alive, and how it is doing.
   *
   * Sent after the work of a cycle rather than before it, so `activeRuns` and
   * `lastError` describe what just happened instead of the previous round. A
   * failure here is logged at debug and otherwise ignored: losing a heartbeat
   * degrades an indicator, and must never interrupt dispatching.
   */
  /**
   * What each agent is doing right now.
   *
   * Derived from this process's own in-flight map rather than from run rows,
   * because rows are what go stale. An agent the cloud believes is busy while
   * the runner knows it is idle is the failure this exists to prevent.
   */
  const agentHealth = (): AgentHealth[] =>
    runtime.agents.map((agent) => {
      const run = db
        .listRuns({ limit: 20 })
        .find(
          (candidate) =>
            candidate.agentProfile === agent.profile && !isTerminalRunStatus(candidate.status)
        )
      if (!run) {
        return { profile: agent.profile, status: 'idle' }
      }
      return {
        profile: agent.profile,
        status: run.status === RUN_STATUS.AWAITING_APPROVAL ? 'awaiting_approval' : 'busy',
        runId: run.id,
      }
    })

  const sendHeartbeat = async (): Promise<void> => {
    if (!cloud) {
      return
    }
    const hermes = await probeHermes(runtime.adapters)
    try {
      await cloud.heartbeat({
        startedAt,
        hermesOk: hermes.ok,
        hermesDetail: hermes.detail,
        activeRuns: inFlight.size,
        lastError: lastCycleError,
        agents: agentHealth(),
        skips: recentSkips.slice(-RECENT_SKIP_LIMIT),
      })
      if (heartbeatFailing) {
        logger.info('Heartbeat restored.')
        heartbeatFailing = false
      }
    } catch (error: unknown) {
      // Only the transition into failure is worth a line. A cloud outage lasts
      // many cycles, and one warning per cycle would bury everything else in
      // the log for the duration.
      if (!heartbeatFailing) {
        heartbeatFailing = true
        logger.warn(`Heartbeat failed: ${errorMessage(error)}`)
      }
    }
  }

  // Health rides its own timer rather than the cycle's. A cycle takes as long
  // as the work in it, so a busy runner used to look like a dead one -- and the
  // cycle that threw is exactly the one whose error must still be reported.
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat()
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()
  await sendHeartbeat()

  // Runs left behind by a previous process are picked back up before any new
  // trigger is collected -- one of them may still hold the agent a new trigger
  // would target.
  await reconcileOrphans()

  for (;;) {
    try {
      // Projects and routes are cloud-owned, so a change made in the dashboard
      // has to reach a long-running runner without anyone restarting it. Two
      // small GETs per cycle is a rounding error next to the poll they pace.
      if (cloud) {
        const [nextProjects, nextRoutes] = await Promise.all([
          refreshProjects(dataDir, config.projects, cloud),
          refreshRoutes(dataDir, cloud),
        ])
        reportConfigDrift(runtime, nextProjects, nextRoutes)
        runtime.projects = nextProjects
        runtime.routes = nextRoutes
      }

      const tally = newTally()

      for (const project of runtime.projects) {
        const events = await collectEvents(project, services)
        tally.collected += events.length
        tally.perProject.push(`${project.id} ${events.length}`)

        for (const event of events) {
          // Record what this item looks like now and attach what changed, so
          // routes can match "label added" rather than merely "label present".
          const changes = db.observe(event.projectId, `${event.type}:${event.ref}`, {
            labels: event.labels,
            assignees: event.assignees ?? [],
            reviewers: event.requestedReviewers ?? [],
          })
          void runDispatch(project, { ...event, changes }, tally)
        }
      }

      // Routing decisions resolve synchronously ahead of the agent run, so a
      // tick of the event loop is enough to have counted them all -- without
      // waiting on runs that may take half an hour.
      await sleep(0)
      logger.info(summarizeCycle(tally))

      const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1_000
      db.pruneDispatchLedger(monthAgo)
      db.pruneObservations(monthAgo)
      lastCycleError = null
    } catch (error: unknown) {
      lastCycleError = errorMessage(error)
      logger.error(`Poll cycle error: ${lastCycleError}`)
    }

    // The long poll doubles as the loop's pacing: it returns as soon as a human
    // queues something, and otherwise costs one held connection per window.
    if (cloud) {
      try {
        const { commands } = await cloud.pollCommands(cursor)
        pollFailures = 0
        for (const command of commands) {
          cursor = Math.max(cursor, command.cursor)
          await handleCommand(command)
        }
        if (commands.length > 0) {
          await cloud.ackCommands(cursor).catch(() => undefined)
        }
      } catch (error: unknown) {
        pollFailures += 1
        const backoff = Math.min(60_000, 2 ** Math.min(pollFailures, 5) * 1_000)
        logger.warn(
          `Command poll failed (${pollFailures}); retrying in ${backoff / 1000}s: ${errorMessage(error)}`
        )
        await sleep(backoff)
      }
    } else {
      await sleep(OFFLINE_POLL_INTERVAL_MS)
    }
  }
}

/**
 * Announces cloud-side configuration changes.
 *
 * Refreshing every cycle is silent by design, but a route appearing or
 * disappearing changes what the runner will do, and that should be visible in
 * the log without diffing two poll summaries.
 */
function reportConfigDrift(
  runtime: Runtime,
  nextProjects: ProjectConfig[],
  nextRoutes: RoutingRule[]
): void {
  const describe = (
    label: string,
    before: Array<{ id: string }>,
    after: Array<{ id: string }>
  ): void => {
    const previous = new Set(before.map((entry) => entry.id))
    const current = new Set(after.map((entry) => entry.id))
    const added = after.filter((entry) => !previous.has(entry.id)).map((entry) => entry.id)
    const removed = before.filter((entry) => !current.has(entry.id)).map((entry) => entry.id)

    if (added.length > 0) {
      logger.success(`${label} added: ${added.join(', ')}`)
    }
    if (removed.length > 0) {
      logger.info(`${label} removed: ${removed.join(', ')}`)
    }
  }

  describe('Project', runtime.projects, nextProjects)
  describe('Route', runtime.routes, nextRoutes)
}

interface CycleTally {
  collected: number
  perProject: string[]
  dispatched: number
  failed: number
  skipped: Record<string, number>
}

function newTally(): CycleTally {
  return { collected: 0, perProject: [], dispatched: 0, failed: 0, skipped: {} }
}

/**
 * One line per cycle, so "nothing happened" is always distinguishable from
 * "nothing was seen". Without this, a route that simply does not match is
 * indistinguishable from a runner that never fetched the ticket at all.
 */
function summarizeCycle(tally: CycleTally): string {
  const parts = [`poll: ${tally.collected} event(s)`]
  if (tally.perProject.length > 0) {
    parts.push(`(${tally.perProject.join(', ')})`)
  }
  if (tally.dispatched > 0) {
    parts.push(`· dispatched ${tally.dispatched}`)
  }
  if (tally.failed > 0) {
    parts.push(`· failed ${tally.failed}`)
  }

  const skipped = Object.entries(tally.skipped)
  if (skipped.length > 0) {
    const total = skipped.reduce((sum, [, count]) => sum + count, 0)
    parts.push(`· skipped ${total} (${skipped.map(([r, c]) => `${r} ${c}`).join(', ')})`)
  }
  return parts.join(' ')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
