import {
  APPROVAL_CHOICE,
  DEFAULT_APPROVAL_TIMEOUT_SECONDS,
  RUN_LOG_KIND,
  RUN_STATUS,
  type ApprovalChoice,
  type Logger,
  type RunApprovalDetail,
  type RunStatus,
  type RunUsage,
} from '@sentinel0/common'
import type { HermesClient } from './client.js'
import { mapHermesEvent, extractText } from './event-mapper.js'
import {
  isHermesTerminalStatus,
  type HermesCapabilities,
  type HermesPendingApproval,
  type HermesRunState,
} from './types.js'

export interface HermesRunJob {
  /** Sentinel0 run id — used for log correlation, not sent to Hermes. */
  runId: string
  prompt: string
  instructions?: string
  sessionId?: string
  previousResponseId?: string
  model?: string | null
  timeoutSeconds: number
  /** How long the run may sit at an approval gate before it is denied. */
  approvalTimeoutSeconds?: number
  /**
   * Called the moment Hermes accepts the run, before any polling.
   *
   * This is what makes mid-run cancellation possible: the id has to be durable
   * from the first instant, not recorded once the run is already over.
   */
  onRunCreated?: (hermesRunId: string, sessionId?: string) => void
  /** Called once each time the run stops at an approval gate. */
  onApprovalRequired?: (detail: RunApprovalDetail) => void
  /** Called once each time a gate is answered and the agent resumes. */
  onApprovalResolved?: () => void
}

/** A run that already exists on Hermes and only needs following. */
export interface HermesAttachJob extends Omit<
  HermesRunJob,
  'prompt' | 'onRunCreated' | 'sessionId' | 'previousResponseId'
> {
  hermesRunId: string
}

export interface HermesRunOutcome {
  status: RunStatus
  hermesRunId: string
  output: string
  error?: string
  usage?: RunUsage
  sessionId?: string
}

export interface HermesAdapterOptions {
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 3_000

/** Hermes says "cancelled"; Sentinel0 says "canceled". Normalize once. */
export function mapHermesStatus(status: string): RunStatus {
  const normalized = status.toLowerCase()
  if (normalized.includes('approval')) {
    return RUN_STATUS.AWAITING_APPROVAL
  }
  if (normalized === 'completed' || normalized === 'succeeded') {
    return RUN_STATUS.COMPLETED
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return RUN_STATUS.CANCELED
  }
  if (normalized === 'failed' || normalized === 'error' || normalized === 'expired') {
    return RUN_STATUS.FAILED
  }
  return RUN_STATUS.RUNNING
}

function toUsage(state: HermesRunState): RunUsage | undefined {
  const usage = state.usage
  if (!usage) {
    return undefined
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  }
}

/**
 * Drives a single Hermes profile.
 *
 * The critical design point: **the SSE stream is progress, the poll is truth.**
 * Hermes expires run event buffers after five minutes, so a run longer than
 * that will have its stream end while the run is still going. Completion is
 * therefore decided exclusively by polling `GET /v1/runs/{id}`; the stream only
 * ever feeds the log viewer, and any stream failure is logged and swallowed.
 */
export class HermesAdapter {
  private readonly pollIntervalMs: number

  /**
   * The last tool call seen on each run's stream.
   *
   * Kept because Hermes does not reliably say *what* it wants approved, and a
   * gate with no description is nearly useless to whoever has to answer it.
   * Keyed by Hermes run id and cleared when the run ends.
   */
  private readonly lastToolCalls = new Map<string, ToolCallSummary>()

  constructor(
    private readonly client: HermesClient,
    private readonly logger: Logger,
    options: HermesAdapterOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  get profile(): string {
    return this.client.profile
  }

  /** Whether the gateway answers, and what it says it is. Used for health. */
  async capabilities(): Promise<HermesCapabilities> {
    return this.client.capabilities()
  }

  async cancel(hermesRunId: string): Promise<void> {
    await this.client.stopRun(hermesRunId)
  }

  /**
   * Answer a gate. The poll loop notices the resulting status change on its own
   * -- this deliberately does not try to drive the run forward itself, because
   * the poll is the only thing that decides what a run is doing.
   */
  async approve(hermesRunId: string, choice: ApprovalChoice): Promise<void> {
    await this.client.resolveApproval(hermesRunId, choice)
  }

  /** One status read, for deciding what a run left behind by a restart is doing. */
  async describe(hermesRunId: string): Promise<HermesRunState> {
    return this.client.getRun(hermesRunId)
  }

  /**
   * Follows a run this process did not start.
   *
   * Identical to `run` from the poll onward -- it is the same loop -- but skips
   * creation, because the agent is already working. This is what lets a runner
   * restart cost nothing: the run is picked back up where it was rather than
   * being abandoned in whatever state the crash caught it in.
   */
  async attach(job: HermesAttachJob, signal?: AbortSignal): Promise<HermesRunOutcome> {
    const streamAbort = new AbortController()
    const streaming = this.consumeStream(job.runId, job.hermesRunId, streamAbort.signal)

    try {
      return await this.pollUntilSettled({ ...job, prompt: '' }, job.hermesRunId, signal)
    } finally {
      streamAbort.abort()
      this.lastToolCalls.delete(job.hermesRunId)
      await streaming.catch(() => undefined)
    }
  }

  async run(job: HermesRunJob, signal?: AbortSignal): Promise<HermesRunOutcome> {
    const created = await this.client.createRun(
      {
        input: job.prompt,
        ...(job.instructions ? { instructions: job.instructions } : {}),
        ...(job.sessionId ? { session_id: job.sessionId } : {}),
        ...(job.previousResponseId ? { previous_response_id: job.previousResponseId } : {}),
        ...(job.model ? { model: job.model } : {}),
      },
      signal
    )

    const hermesRunId = created.run_id
    if (!hermesRunId) {
      throw new Error(`Hermes profile "${this.client.profile}" returned no run_id.`)
    }

    // The session id is what lets an operator attach to the agent mid-run, so
    // record it as early as Hermes offers it rather than only once the run ends.
    job.onRunCreated?.(hermesRunId, created.session_id)
    this.logger.info(
      `Hermes run ${hermesRunId} started on profile ${this.client.profile}`,
      job.runId
    )

    const streamAbort = new AbortController()
    const streaming = this.consumeStream(job.runId, hermesRunId, streamAbort.signal)

    try {
      return await this.pollUntilSettled(job, hermesRunId, signal)
    } finally {
      streamAbort.abort()
      this.lastToolCalls.delete(hermesRunId)
      // Surfaced inside consumeStream; awaited only so the task cannot outlive the run.
      await streaming.catch(() => undefined)
    }
  }

  private async consumeStream(
    runId: string,
    hermesRunId: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for await (const event of this.client.streamRunEvents(hermesRunId, signal)) {
        const entry = mapHermesEvent(event)
        if (!entry) {
          continue
        }
        if (entry.kind === RUN_LOG_KIND.COMMAND) {
          this.lastToolCalls.set(hermesRunId, { tool: entry.title, command: entry.message })
        }
        this.logger.event({
          runId,
          title: entry.title,
          message: entry.message,
          level: entry.level,
          kind: entry.kind,
          source: entry.source,
          icon: entry.icon,
          groupId: entry.groupId,
        })
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        return
      }
      // Never fatal: losing progress output must not fail an otherwise fine run.
      this.logger.warn(
        `Hermes event stream ended early for ${hermesRunId}: ${errorMessage(error)}`,
        runId
      )
    }
  }

  private async pollUntilSettled(
    job: HermesRunJob,
    hermesRunId: string,
    signal?: AbortSignal
  ): Promise<HermesRunOutcome> {
    const approvalBudgetMs =
      (job.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS) * 1_000
    let deadline = Date.now() + job.timeoutSeconds * 1_000
    let lastState: HermesRunState | undefined
    // Non-null exactly while the run sits at a gate; the instant it opened is
    // what separates "the agent is slow" from "a human has not answered yet".
    let waitingSince: number | undefined

    for (;;) {
      if (signal?.aborted) {
        await this.stopQuietly(hermesRunId, job.runId)
        return this.outcome(RUN_STATUS.CANCELED, hermesRunId, lastState, 'Canceled by operator.')
      }

      if (waitingSince !== undefined) {
        // The run deadline is deliberately not checked here: the agent is not
        // working, so its budget must not burn while a person decides. The time
        // spent waiting is credited back exactly when the gate closes.
        if (Date.now() - waitingSince > approvalBudgetMs) {
          await this.denyQuietly(hermesRunId, job.runId)
          await this.stopQuietly(hermesRunId, job.runId)
          return this.outcome(
            RUN_STATUS.FAILED,
            hermesRunId,
            lastState,
            `Approval was not answered within ${formatDuration(approvalBudgetMs)}; the run was denied and stopped.`
          )
        }
      } else if (Date.now() > deadline) {
        await this.stopQuietly(hermesRunId, job.runId)
        return this.outcome(
          RUN_STATUS.FAILED,
          hermesRunId,
          lastState,
          `Run exceeded its ${job.timeoutSeconds}s timeout and was stopped.`
        )
      }

      try {
        lastState = await this.client.getRun(hermesRunId, signal)
      } catch (error: unknown) {
        // A transient poll failure is not a run failure; the deadline is the
        // only thing that ends the loop unhappily.
        this.logger.warn(
          `Hermes status poll failed for ${hermesRunId}: ${errorMessage(error)}`,
          job.runId
        )
      }

      if (lastState && isHermesTerminalStatus(lastState.status)) {
        const status = mapHermesStatus(lastState.status)
        return this.outcome(status, hermesRunId, lastState, lastState.error)
      }

      // An approval is a wait state, not an outcome. Leaving the loop here --
      // as this once did -- abandons a live run: nothing re-polls it, nothing
      // can answer it, and it holds its agent until someone cancels by hand.
      const awaiting =
        lastState !== undefined &&
        mapHermesStatus(lastState.status) === RUN_STATUS.AWAITING_APPROVAL

      if (awaiting && waitingSince === undefined) {
        waitingSince = Date.now()
        job.onApprovalRequired?.(this.approvalDetail(hermesRunId, lastState))
      } else if (!awaiting && waitingSince !== undefined) {
        deadline += Date.now() - waitingSince
        waitingSince = undefined
        job.onApprovalResolved?.()
      }

      await delay(this.pollIntervalMs, signal)
    }
  }

  /**
   * What the agent is asking for, best effort.
   *
   * Hermes may or may not describe the pending call in its run state, so the
   * stream's last tool call stands in when it does not. A gate with no
   * description at all is still worth showing -- an operator can open the run
   * log -- so this always returns something.
   */
  private approvalDetail(hermesRunId: string, state?: HermesRunState): RunApprovalDetail {
    const pending = state?.pending_approval ?? state?.approval
    const fromState = pending ? describeApproval(pending) : undefined
    return {
      ...(fromState ?? this.lastToolCalls.get(hermesRunId) ?? {}),
      requestedAt: Date.now(),
    }
  }

  private async denyQuietly(hermesRunId: string, runId: string): Promise<void> {
    try {
      await this.client.resolveApproval(hermesRunId, APPROVAL_CHOICE.DENY)
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to deny the lapsed approval on ${hermesRunId}: ${errorMessage(error)}`,
        runId
      )
    }
  }

  private async stopQuietly(hermesRunId: string, runId: string): Promise<void> {
    try {
      await this.client.stopRun(hermesRunId)
    } catch (error: unknown) {
      this.logger.warn(`Failed to stop Hermes run ${hermesRunId}: ${errorMessage(error)}`, runId)
    }
  }

  private outcome(
    status: RunStatus,
    hermesRunId: string,
    state: HermesRunState | undefined,
    error?: string
  ): HermesRunOutcome {
    return {
      status,
      hermesRunId,
      output: state ? extractText(state.output) : '',
      error,
      usage: state ? toUsage(state) : undefined,
      sessionId: state?.session_id,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ToolCallSummary {
  tool?: string
  command?: string
  arguments?: string
}

/** Reads whichever of Hermes' several spellings of a pending call arrived. */
function describeApproval(pending: HermesPendingApproval): ToolCallSummary | undefined {
  const tool = pending.tool ?? pending.tool_name
  const command = pending.command
  const args = extractText(pending.arguments ?? pending.input)
  if (!tool && !command && !args) {
    return undefined
  }
  return {
    ...(tool ? { tool } : {}),
    ...(command ? { command } : {}),
    ...(args ? { arguments: args } : {}),
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}
