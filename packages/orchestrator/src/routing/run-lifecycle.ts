import {
  RUN_STATUS,
  isTerminalRunStatus,
  type Logger,
  type RunApprovalDetail,
  type RunRecord,
  type RunStatus,
  type RunUsage,
} from '@sentinel0/common'
import type { Sentinel0Database } from '../database.js'

/** "Waiting for approval: gh pr review 42 --approve", when we know that much. */
function describeGate(detail?: RunApprovalDetail): string {
  const what = detail?.command ?? detail?.arguments ?? detail?.tool
  return what ? `Waiting for approval: ${what}` : 'Waiting for approval'
}

/**
 * Notified whenever a run is created or changes status.
 *
 * `created` is distinct from `changed` because the cloud treats the first
 * report as the run starting and later ones as updates, and only the first
 * should announce "started" to Slack. `settled` carries the finished run so
 * its transcript can be shipped once, rather than streamed event by event.
 */
export interface RunObserver {
  created?: (run: RunRecord) => void
  changed?: (run: RunRecord) => void
  settled?: (run: RunRecord) => void
}

/**
 * The single place a run's status changes.
 *
 * Every transition writes the database and emits a lifecycle event together, so
 * a run's stored status and its visible history can never disagree. Terminal
 * transitions always stamp `endedAt`, which is what the cloud mirror and the
 * Slack notifier use to report duration.
 */
export class RunLifecycle {
  constructor(
    private readonly db: Sentinel0Database,
    private readonly logger: Logger,
    private readonly observer: RunObserver = {}
  ) {}

  /**
   * Records a new run.
   *
   * Creation lives here rather than in the dispatcher so that every write to a
   * run -- the first one included -- goes through one place, and so nothing can
   * create a run the cloud never hears about.
   */
  created(run: RunRecord): void {
    this.db.createRun(run)
    this.observer.created?.(run)
  }

  private transition(
    runId: string,
    status: RunStatus,
    message: string,
    icon: string,
    extra: {
      summary?: string
      error?: string
      usage?: RunUsage
      approvalDetail?: RunApprovalDetail | null
    } = {}
  ): void {
    const now = Date.now()
    // A run that resumes after an approval is running *again*, not starting
    // over: re-stamping startedAt here would erase however long it had already
    // worked and make every elapsed time on the dashboard a lie.
    const alreadyStarted = this.db.getRun(runId)?.startedAt !== undefined
    this.db.updateRun(
      runId,
      {
        status,
        ...extra,
        ...(status === RUN_STATUS.RUNNING && !alreadyStarted ? { startedAt: now } : {}),
        ...(status === RUN_STATUS.COMPLETED ||
        status === RUN_STATUS.FAILED ||
        status === RUN_STATUS.CANCELED
          ? { endedAt: now }
          : {}),
      },
      now
    )

    this.logger.event({
      runId,
      message,
      icon,
      kind: 'lifecycle',
      source: 'system',
      level: status === RUN_STATUS.FAILED ? 'error' : 'info',
    })

    const updated = this.db.getRun(runId)
    if (!updated) {
      return
    }
    this.observer.changed?.(updated)
    if (isTerminalRunStatus(updated.status)) {
      this.observer.settled?.(updated)
    }
  }

  queued(runId: string, message = 'Queued'): void {
    this.transition(runId, RUN_STATUS.QUEUED, message, '.')
  }

  running(runId: string, message = 'Dispatched to agent'): void {
    this.transition(runId, RUN_STATUS.RUNNING, message, '>')
  }

  /**
   * The agent has stopped at a gate and is waiting on a person.
   *
   * The detail travels with the transition so that whoever reads Slack or the
   * dashboard learns *what* is being asked, not merely that something is.
   */
  awaitingApproval(runId: string, detail?: RunApprovalDetail): void {
    this.transition(
      runId,
      RUN_STATUS.AWAITING_APPROVAL,
      describeGate(detail),
      '?',
      detail ? { approvalDetail: detail } : {}
    )
  }

  /** A gate was answered; the agent is working again. */
  approvalResolved(runId: string, message = 'Approved; the agent resumed'): void {
    this.transition(runId, RUN_STATUS.RUNNING, message, '>', { approvalDetail: null })
  }

  completed(runId: string, summary?: string, usage?: RunUsage): void {
    this.transition(runId, RUN_STATUS.COMPLETED, summary ?? 'Completed', 'v', { summary, usage })
  }

  failed(runId: string, error: string, usage?: RunUsage): void {
    this.transition(runId, RUN_STATUS.FAILED, error, 'x', { error, usage })
  }

  canceled(runId: string, reason = 'Canceled'): void {
    this.transition(runId, RUN_STATUS.CANCELED, reason, '-', { error: reason })
  }

  /** Records the Hermes-side identifiers as soon as they are known. */
  attachHermesRun(runId: string, hermesRunId: string, sessionId?: string): void {
    this.db.updateRun(runId, { hermesRunId, hermesSessionId: sessionId })
    const updated = this.db.getRun(runId)
    if (updated) {
      this.observer.changed?.(updated)
    }
  }
}
