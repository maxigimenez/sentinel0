import {
  COMMENT_TARGET,
  MAX_CONCURRENT_RUNS_PER_AGENT,
  SENTINEL0_LABEL,
  RUN_STATUS,
  type AgentDescriptor,
  type CommentTarget,
  type Logger,
  TRIGGER_TYPE,
  type RoutingRule,
  type RunRecord,
  type TriggerEvent,
} from '@sentinel0/common'
import type { Sentinel0Database } from '../database.js'
import type { HermesAdapter, HermesRunOutcome } from '../hermes/adapter.js'
import { renderRoutePrompt } from '../prompts/render.js'
import { resolveSummary } from '../prompts/output-contract.js'
import { dedupeKey, evaluate, guardOf } from './rule-engine.js'
import type { RunLifecycle } from './run-lifecycle.js'

export type DispatchResult =
  | { outcome: 'dispatched'; runId: string; status: RunRecord['status'] }
  | { outcome: 'skipped'; reason: SkipReason; detail?: string }
  | { outcome: 'failed'; runId?: string; reason: string }

export type SkipReason = 'no-route' | 'duplicate' | 'unknown-agent' | 'agent-busy'

/**
 * A run an operator asked for directly: one agent, one prompt, no route.
 *
 * `title` is what the run is called in the dashboard. It is optional because
 * the prompt itself is a reasonable name for the work, and deriving one is
 * better than making somebody invent a label before they can press the button.
 */
export interface PromptRunRequest {
  agentProfile: string
  prompt: string
  title?: string
}

/**
 * Side effects Sentinel0 owns after a run finishes.
 *
 * Injected rather than imported so the dispatcher is testable without GitHub or
 * Linear, and so the tracker write path stays in one place.
 */
export interface OutcomeHandlers {
  postComment(target: CommentTarget, event: TriggerEvent, body: string): Promise<void>
  updateLabels(event: TriggerEvent, labels: { add?: string[]; remove?: string[] }): Promise<void>
}

export interface DispatcherDeps {
  db: Sentinel0Database
  logger: Logger
  lifecycle: RunLifecycle
  outcomes: OutcomeHandlers
  /** Adapter per Hermes profile. */
  adapters: Map<string, HermesAdapter>
  agents: AgentDescriptor[]
  newRunId: () => string
  now?: () => number
  /** Registry of in-flight runs, so the API can abort one by id. */
  inFlight?: Map<string, AbortController>
}

/**
 * What a manual run records where a routed one records its route and trigger.
 *
 * Both schemas require these columns, and inventing a plausible-looking route
 * id would be worse than saying plainly that there was not one. The dashboard
 * shows `routeName` in its Route column, so this is read by people.
 */
const MANUAL_ROUTE_ID = 'manual'
const MANUAL_ROUTE_NAME = 'manual run'

/**
 * How long a manual run may take before Sentinel0 stops it.
 *
 * The same 30 minutes every route template defaults to. A route can be tuned
 * because it runs unattended and forever; a manual run is watched by the person
 * who started it, so one fewer field in the way is worth more than the knob.
 */
const MANUAL_TIMEOUT_SECONDS = 1_800

/**
 * Rebuilds the trigger event a finished run came from.
 *
 * Only the fields the outcome handlers actually read are recoverable, and only
 * those are needed: they address a ticket or pull request by `ref`. Matching is
 * never done against this -- the routing decision was made long ago.
 */
/**
 * The only part of a route that settling a run reads.
 *
 * Narrowed so resumption can settle a run whose route has since been deleted --
 * or which never had one -- without inventing a whole rule to satisfy a type.
 */
type RouteOutcomeSource = Pick<RoutingRule, 'outcome'>

function eventFromRun(run: RunRecord): TriggerEvent {
  return {
    type: run.triggerType,
    projectId: run.projectId,
    provider: run.triggerType === TRIGGER_TYPE.TICKET ? 'linear' : 'github',
    ref: run.triggerRef,
    revision: run.triggerRevision,
    title: run.title,
    body: '',
    url: run.triggerUrl,
    labels: [],
  }
}

/** How much of the prompt becomes the run's title when none is given. */
const TITLE_LENGTH = 80

function titleFrom(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].trim()
  return firstLine.length > TITLE_LENGTH
    ? `${firstLine.slice(0, TITLE_LENGTH - 1)}\u2026`
    : firstLine
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Resolve `target.agentRef` to a concrete, enabled profile. */
  private resolveAgent(route: RoutingRule): AgentDescriptor | undefined {
    const { profile, githubLogin } = route.target.agentRef
    return this.deps.agents.find((agent) => {
      if (!agent.enabled) {
        return false
      }
      if (profile) {
        return agent.profile === profile
      }
      if (githubLogin) {
        return agent.githubLogin?.toLowerCase() === githubLogin.toLowerCase()
      }
      return false
    })
  }

  /**
   * @param onDecision Called the moment routing is decided, before the agent
   *   run begins. A run can take half an hour, so anything that wants to report
   *   on routing -- a per-cycle summary, say -- cannot wait for the promise.
   */
  async dispatch(
    event: TriggerEvent,
    routes: readonly RoutingRule[],
    onDecision?: (decision: DispatchResult | { outcome: 'started'; runId: string }) => void
  ): Promise<DispatchResult> {
    const decide = <T extends DispatchResult>(result: T): T => {
      onDecision?.(result)
      return result
    }

    const route = evaluate(routes, event)
    if (!route) {
      return decide({ outcome: 'skipped', reason: 'no-route' })
    }

    const agent = this.resolveAgent(route)
    if (!agent) {
      const ref = route.target.agentRef
      const detail = `Route "${route.id}" targets ${ref.profile ? `profile "${ref.profile}"` : `github login "${ref.githubLogin}"`}, which is not a known enabled agent.`
      this.deps.logger.warn(detail)
      return decide({ outcome: 'skipped', reason: 'unknown-agent', detail })
    }

    // Hermes corrupts a profile's memory if two agents drive it concurrently.
    // Deferring rather than queueing is deliberate: the trigger will still be
    // there next cycle, and the dedupe key is not claimed, so nothing is lost.
    if (this.deps.db.countActiveRunsForAgent(agent.profile) >= MAX_CONCURRENT_RUNS_PER_AGENT) {
      return decide({
        outcome: 'skipped',
        reason: 'agent-busy',
        detail: `Agent "${agent.profile}" is already running; deferring ${event.ref}.`,
      })
    }

    const adapter = this.deps.adapters.get(agent.profile)
    if (!adapter) {
      return decide({
        outcome: 'skipped',
        reason: 'unknown-agent',
        detail: `No Hermes client configured for profile "${agent.profile}".`,
      })
    }

    const key = dedupeKey(route, event)
    const runId = this.deps.newRunId()

    // Claim before any work: this is what makes a re-observed, unchanged ticket
    // a no-op on every subsequent poll cycle.
    if (
      !this.deps.db.claimDispatch(
        key,
        { runId, routeId: route.id, triggerRef: event.ref },
        this.now()
      )
    ) {
      return decide({ outcome: 'skipped', reason: 'duplicate' })
    }

    let prompt: string
    try {
      const rendered = renderRoutePrompt({
        event,
        route,
        agentProfile: agent.profile,
        agentRole: agent.role,
      })
      prompt = rendered.prompt
      if (rendered.unknown.length > 0) {
        // Not fatal: the placeholder is left visible in the prompt, so the run
        // still happens and the mistake is obvious rather than silent.
        this.deps.logger.warn(
          `Route "${route.id}" uses unknown placeholder(s): ${rendered.unknown.join(', ')}`
        )
      }
    } catch (error: unknown) {
      // Releasing the claim keeps the trigger live so a corrected route can run.
      this.deps.db.releaseDispatch(key)
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.logger.error(reason)
      return decide({ outcome: 'failed', reason })
    }

    const now = this.now()
    const record: RunRecord = {
      id: runId,
      routeId: route.id,
      routeName: route.name,
      agentProfile: agent.profile,
      projectId: event.projectId,
      triggerType: event.type,
      triggerRef: event.ref,
      triggerRevision: event.revision,
      triggerUrl: event.url,
      title: event.title,
      status: RUN_STATUS.QUEUED,
      createdAt: now,
      updatedAt: now,
    }
    this.deps.lifecycle.created(record)
    onDecision?.({ outcome: 'started', runId })

    const controller = new AbortController()
    this.deps.inFlight?.set(runId, controller)
    let hermesRunId: string | undefined

    const guard = guardOf(route)

    try {
      this.deps.lifecycle.running(runId, `Dispatched ${event.ref} to agent "${agent.profile}"`)

      // Mark before the agent touches anything. The marker is what stops a
      // second route -- or this one on the next cycle -- picking the item up
      // while work is in flight.
      if (guard.markers) {
        await this.safely(
          () => this.deps.outcomes.updateLabels(event, { add: [SENTINEL0_LABEL.IN_PROGRESS] }),
          'mark in progress'
        )
      }

      const result = await adapter.run(
        {
          runId,
          prompt,
          model: route.execution.modelOverride ?? agent.model ?? null,
          timeoutSeconds: route.execution.timeoutSeconds,
          approvalTimeoutSeconds: route.execution.approvalTimeoutSeconds,
          // Persisted immediately so a cancel arriving mid-run has something to
          // stop, and so a runner restart can still reach an orphaned run.
          onRunCreated: (id, sessionId) => {
            hermesRunId = id
            this.deps.lifecycle.attachHermesRun(runId, id, sessionId)
          },
          // An approval is a status this run passes through, not the end of it:
          // the adapter keeps polling, so both edges are reported.
          onApprovalRequired: (detail) => this.deps.lifecycle.awaitingApproval(runId, detail),
          onApprovalResolved: () => this.deps.lifecycle.approvalResolved(runId),
        },
        controller.signal
      )

      this.deps.lifecycle.attachHermesRun(runId, result.hermesRunId, result.sessionId)

      await this.settle(runId, result, { route, event, guard })

      return { outcome: 'dispatched', runId, status: result.status }
    } catch (error: unknown) {
      // An abort can land anywhere -- including in the window before Hermes has
      // even accepted the run -- and surfaces as a rejection rather than a
      // status. Classifying on the signal keeps "the operator cancelled it"
      // from being reported as "the agent failed".
      if (controller.signal.aborted) {
        await this.clearMarker(guard, event, undefined)
        // The adapter's own cancel path did not get to run, so stopping the
        // Hermes side is this branch's job -- otherwise the agent keeps working
        // on a run Sentinel0 has already written off.
        if (hermesRunId) {
          await adapter.cancel(hermesRunId).catch((stopError: unknown) => {
            this.deps.logger.warn(
              `Canceled ${runId} locally but could not stop Hermes run ${hermesRunId}: ${stopError instanceof Error ? stopError.message : String(stopError)}`
            )
          })
        } else {
          // Aborted before Hermes acknowledged the run. It may or may not exist
          // there; nothing identifies it, so say so rather than pretend.
          this.deps.logger.warn(
            `Canceled ${runId} before Hermes acknowledged it; a run may be orphaned on profile "${agent.profile}".`
          )
        }
        this.deps.lifecycle.canceled(runId, 'Canceled by operator.')
        return { outcome: 'dispatched', runId, status: RUN_STATUS.CANCELED }
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.lifecycle.failed(runId, reason)
      await this.clearMarker(guard, event, SENTINEL0_LABEL.FAILED)
      await this.postFailure(route, event, reason)
      return { outcome: 'failed', runId, reason }
    } finally {
      this.deps.inFlight?.delete(runId)
    }
  }

  /**
   * Starts one named agent on an operator's own prompt.
   *
   * Everything routing does is deliberately absent. There is no rule to
   * evaluate, so no route is matched; no trigger, so nothing is claimed in the
   * dispatch ledger; no ticket or pull request, so no label is moved and no
   * comment is posted. What remains is the part that is genuinely shared: one
   * agent at a time, driven through the same lifecycle so the run looks like
   * every other run in the dashboard.
   *
   * Skipping the ledger is safe precisely because there is no trigger to
   * re-observe. The ledger exists to stop an unchanged ticket firing twice per
   * poll cycle; a person pressing a button twice means it twice.
   */
  async dispatchPrompt(request: PromptRunRequest): Promise<DispatchResult> {
    const agent = this.deps.agents.find(
      (candidate) => candidate.enabled && candidate.profile === request.agentProfile
    )
    if (!agent) {
      const detail = `Agent "${request.agentProfile}" is not a known enabled agent on this runner.`
      this.deps.logger.warn(detail)
      return { outcome: 'skipped', reason: 'unknown-agent', detail }
    }

    // The one-run-per-agent invariant is not a routing concern -- it is a fact
    // about Hermes, which corrupts a profile's memory if two runs drive it at
    // once. A manual run is refused rather than deferred: nothing will retry it,
    // and the person who pressed the button is owed the reason.
    if (this.deps.db.countActiveRunsForAgent(agent.profile) >= MAX_CONCURRENT_RUNS_PER_AGENT) {
      const detail = `Agent "${agent.profile}" is already running; try again when it finishes.`
      this.deps.logger.warn(detail)
      return { outcome: 'skipped', reason: 'agent-busy', detail }
    }

    const adapter = this.deps.adapters.get(agent.profile)
    if (!adapter) {
      const detail = `No Hermes client configured for profile "${agent.profile}".`
      this.deps.logger.warn(detail)
      return { outcome: 'skipped', reason: 'unknown-agent', detail }
    }

    const runId = this.deps.newRunId()
    const now = this.now()
    const record: RunRecord = {
      id: runId,
      routeId: MANUAL_ROUTE_ID,
      routeName: MANUAL_ROUTE_NAME,
      agentProfile: agent.profile,
      // No project: a prompt is not about a repository unless it says so, and
      // naming one would imply a scope nothing enforces.
      projectId: '',
      triggerType: TRIGGER_TYPE.MANUAL,
      // The run is its own trigger. Using the run id keeps `triggerRef` unique
      // and traceable rather than a constant repeated across every manual run.
      triggerRef: runId,
      triggerRevision: String(now),
      title: request.title?.trim() || titleFrom(request.prompt),
      status: RUN_STATUS.QUEUED,
      createdAt: now,
      updatedAt: now,
    }
    this.deps.lifecycle.created(record)

    const controller = new AbortController()
    this.deps.inFlight?.set(runId, controller)
    let hermesRunId: string | undefined

    try {
      this.deps.lifecycle.running(runId, `Started agent "${agent.profile}" on a manual prompt`)

      const result = await adapter.run(
        {
          runId,
          prompt: request.prompt,
          model: agent.model ?? null,
          timeoutSeconds: MANUAL_TIMEOUT_SECONDS,
          onRunCreated: (id, sessionId) => {
            hermesRunId = id
            this.deps.lifecycle.attachHermesRun(runId, id, sessionId)
          },
          onApprovalRequired: (detail) => this.deps.lifecycle.awaitingApproval(runId, detail),
          onApprovalResolved: () => this.deps.lifecycle.approvalResolved(runId),
        },
        controller.signal
      )

      this.deps.lifecycle.attachHermesRun(runId, result.hermesRunId, result.sessionId)
      const summary = resolveSummary(result.output)

      switch (result.status) {
        case RUN_STATUS.COMPLETED:
          this.deps.lifecycle.completed(runId, summary, result.usage)
          break
        case RUN_STATUS.CANCELED:
          this.deps.lifecycle.canceled(runId, result.error)
          break
        default:
          this.deps.lifecycle.failed(runId, result.error ?? 'Agent run failed.', result.usage)
          break
      }

      return { outcome: 'dispatched', runId, status: result.status }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (hermesRunId) {
          await adapter.cancel(hermesRunId).catch(() => undefined)
        }
        this.deps.lifecycle.canceled(runId, 'Canceled by operator.')
        return { outcome: 'dispatched', runId, status: RUN_STATUS.CANCELED }
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.lifecycle.failed(runId, reason)
      return { outcome: 'failed', runId, reason }
    } finally {
      this.deps.inFlight?.delete(runId)
    }
  }

  /**
   * Swaps the in-progress marker for a terminal one.
   *
   * Always removes `in-progress`, even when there is no terminal marker to
   * apply (a cancellation): leaving it behind would make the item permanently
   * unroutable, since every route declines anything carrying it.
   */
  /**
   * Records a finished run and tells the tracker about it.
   *
   * Shared by the dispatch path and by resumption after a restart so that a run
   * adopted from a previous process still clears its in-progress marker. An
   * item left marked is unroutable forever -- the rule engine skips anything
   * carrying it -- so this is not merely tidiness.
   */
  private async settle(
    runId: string,
    result: HermesRunOutcome,
    context: { route: RouteOutcomeSource; event: TriggerEvent; guard: { markers: boolean } }
  ): Promise<void> {
    const { route, event, guard } = context
    const summary = resolveSummary(result.output)

    switch (result.status) {
      case RUN_STATUS.COMPLETED:
        this.deps.lifecycle.completed(runId, summary, result.usage)
        await this.clearMarker(guard, event, SENTINEL0_LABEL.DONE)
        await this.applyOutcomes(route, event, summary ?? 'Run completed with no summary.')
        break
      case RUN_STATUS.CANCELED:
        this.deps.lifecycle.canceled(runId, result.error)
        await this.clearMarker(guard, event, undefined)
        break
      default:
        this.deps.lifecycle.failed(runId, result.error ?? 'Agent run failed.', result.usage)
        await this.clearMarker(guard, event, SENTINEL0_LABEL.FAILED)
        // The tracker still hears about it: a failure the humans never see is
        // the worst outcome, and it is exactly the case an agent cannot report
        // on its own behalf.
        await this.postFailure(route, event, result.error ?? 'Agent run failed.')
        break
    }
  }

  /**
   * Takes back a run that outlived the process which started it.
   *
   * The trigger event is long gone, so it is rebuilt from what the run record
   * kept. That is enough for every outcome handler -- they address the item by
   * `ref` -- and it is the difference between a restart costing a run and a
   * restart costing nothing.
   */
  async resume(run: RunRecord, adapter: HermesAdapter, route?: RoutingRule): Promise<void> {
    if (!run.hermesRunId) {
      return
    }
    const event = eventFromRun(run)
    const guard = route ? guardOf(route) : { markers: true, refire: 'once' as const }
    const controller = new AbortController()
    this.deps.inFlight?.set(run.id, controller)

    try {
      const result = await adapter.attach(
        {
          runId: run.id,
          hermesRunId: run.hermesRunId,
          timeoutSeconds: route?.execution.timeoutSeconds ?? MANUAL_TIMEOUT_SECONDS,
          approvalTimeoutSeconds: route?.execution.approvalTimeoutSeconds,
          onApprovalRequired: (detail) => this.deps.lifecycle.awaitingApproval(run.id, detail),
          onApprovalResolved: () => this.deps.lifecycle.approvalResolved(run.id),
        },
        controller.signal
      )

      if (route) {
        await this.settle(run.id, result, { route, event, guard })
      } else {
        // A manual run, or one whose route has since been deleted: there is no
        // outcome to apply, but the status is still worth recording truthfully.
        await this.settle(run.id, result, {
          route: { outcome: {} },
          event,
          guard: { markers: false },
        })
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.lifecycle.failed(run.id, `Could not resume after a restart: ${reason}`)
    } finally {
      this.deps.inFlight?.delete(run.id)
    }
  }

  private async clearMarker(
    guard: { markers: boolean },
    event: TriggerEvent,
    terminal: string | undefined
  ): Promise<void> {
    if (!guard.markers) {
      return
    }
    await this.safely(
      () =>
        this.deps.outcomes.updateLabels(event, {
          add: terminal ? [terminal] : [],
          remove: [SENTINEL0_LABEL.IN_PROGRESS],
        }),
      'clear in-progress marker'
    )
  }

  private async applyOutcomes(
    route: RouteOutcomeSource,
    event: TriggerEvent,
    body: string
  ): Promise<void> {
    const target = route.outcome.postComment?.target
    if (target && target !== COMMENT_TARGET.NONE) {
      await this.safely(() => this.deps.outcomes.postComment(target, event, body), 'post comment')
    }
    if (route.outcome.labels) {
      await this.safely(
        () => this.deps.outcomes.updateLabels(event, route.outcome.labels!),
        'update labels'
      )
    }
  }

  private async postFailure(
    route: RouteOutcomeSource,
    event: TriggerEvent,
    error: string
  ): Promise<void> {
    const target = route.outcome.postComment?.target
    if (!target || target === COMMENT_TARGET.NONE) {
      return
    }
    await this.safely(
      () => this.deps.outcomes.postComment(target, event, `Sentinel0 run failed: ${error}`),
      'post failure comment'
    )
  }

  /** An outcome handler failing must not reclassify an otherwise-successful run. */
  private async safely(action: () => Promise<void>, label: string): Promise<void> {
    try {
      await action()
    } catch (error: unknown) {
      this.deps.logger.warn(
        `Failed to ${label}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}
