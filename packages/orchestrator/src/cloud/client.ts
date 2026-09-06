import type {
  AgentDescriptor,
  CloudConfig,
  ProjectConfig,
  RoutingRule,
  RunLogEntry,
  RunRecord,
} from '@sentinel0/common'

export interface RunnerCommand {
  id: string
  cursor: number
  type: 'run' | 'cancel' | 'resync' | 'run-prompt' | 'approve'
  payload: Record<string, unknown>
}

export interface HelloResponse {
  runnerId: string
  routesRevision: string
}

export interface RoutesResponse {
  revision: string
  routes: RoutingRule[]
}

export interface ProjectsResponse {
  projects: ProjectConfig[]
}

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string
  ) {
    super(`Sentinel0 cloud ${status} at ${path}: ${body.slice(0, 300)}`)
    this.name = 'CloudApiError'
  }
}

/** Long-poll window. The server holds the request open for up to this long. */
const POLL_WAIT_SECONDS = 25

/** Long-polling needs a client timeout comfortably above the server's hold. */
const POLL_TIMEOUT_MS = (POLL_WAIT_SECONDS + 10) * 1_000
const DEFAULT_TIMEOUT_MS = 15_000

export class CloudClient {
  private readonly root: string

  constructor(
    private readonly config: CloudConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.root = config.baseUrl.replace(/\/+$/, '')
  }

  get runnerName(): string {
    return this.config.runnerName
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {}
  ): Promise<T> {
    const { timeoutMs, ...rest } = init
    const response = await this.fetchImpl(`${this.root}${path}`, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    })

    if (!response.ok) {
      throw new CloudApiError(response.status, path, await response.text().catch(() => ''))
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  private post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body), timeoutMs })
  }

  hello(hostname: string, version: string): Promise<HelloResponse> {
    return this.post<HelloResponse>('/v1/runner/hello', {
      name: this.config.runnerName,
      hostname,
      version,
    })
  }

  /**
   * Periodic proof of life, with enough detail to be worth reading.
   *
   * The runner accepts no inbound connections, so nothing can ask it how it is
   * doing — health has to be pushed or it does not exist. Sent on its own
   * timer rather than once per poll cycle: a cycle takes as long as the work in
   * it, so pacing health by it meant a busy runner looked like a dead one.
   */
  heartbeat(health: RunnerHealth): Promise<void> {
    return this.post<void>('/v1/runner/heartbeat', {
      name: this.config.runnerName,
      ...health,
    })
  }

  pushInventory(agents: AgentDescriptor[]): Promise<void> {
    return this.request<void>('/v1/runner/inventory', {
      method: 'PUT',
      body: JSON.stringify({ agents }),
    })
  }

  fetchRoutes(): Promise<RoutesResponse> {
    return this.request<RoutesResponse>('/v1/runner/routes')
  }

  fetchProjects(): Promise<ProjectsResponse> {
    return this.request<ProjectsResponse>('/v1/runner/projects')
  }

  /**
   * Long-poll for work queued by a human.
   *
   * The server holds the connection open until something arrives or the window
   * closes, so an empty array is the normal, healthy result -- not an error.
   */
  pollCommands(cursor: number, signal?: AbortSignal): Promise<{ commands: RunnerCommand[] }> {
    // Naming ourselves is what lets the cloud address a command at one machine.
    // A command that names no runner is still delivered to everyone, so this is
    // additive: it narrows what this runner may claim, never what it receives.
    return this.request<{ commands: RunnerCommand[] }>(
      `/v1/runner/commands?cursor=${cursor}&wait=${POLL_WAIT_SECONDS}&runner=${encodeURIComponent(this.config.runnerName)}`,
      { timeoutMs: POLL_TIMEOUT_MS, signal }
    )
  }

  ackCommands(throughCursor: number): Promise<void> {
    // Same filter as the poll: acking by cursor alone would mark another
    // runner's addressed commands delivered before it ever fetched them.
    return this.post<void>('/v1/runner/commands/ack', {
      cursor: throughCursor,
      runner: this.config.runnerName,
    })
  }

  // Every mirror write names its runner. Without it the cloud attributed runs
  // to whichever runner it had heard from most recently, which is correct only
  // while there is exactly one.
  private get whoami(): string {
    return `runner=${encodeURIComponent(this.config.runnerName)}`
  }

  mirrorRun(run: RunRecord): Promise<void> {
    return this.post<void>(`/v1/runner/runs?${this.whoami}`, { run })
  }

  mirrorRunUpdate(run: RunRecord): Promise<void> {
    return this.request<void>(`/v1/runner/runs/${encodeURIComponent(run.id)}?${this.whoami}`, {
      method: 'PATCH',
      body: JSON.stringify({ run }),
    })
  }

  mirrorEvents(runId: string, events: RunLogEntry[]): Promise<void> {
    return this.post<void>(`/v1/runner/runs/${encodeURIComponent(runId)}/events?${this.whoami}`, {
      events,
    })
  }
}

/** What the runner reports about itself on each heartbeat. */
export interface RunnerHealth {
  startedAt: string
  hermesOk: boolean
  hermesDetail: string
  activeRuns: number
  lastError: string | null
  /**
   * Per-agent liveness.
   *
   * The cloud previously had no way to say whether an agent was working -- the
   * dashboard inferred it by counting run rows, which are exactly the rows that
   * go stale when a runner restarts. The runner knows the truth, so it says so.
   */
  agents?: AgentHealth[]
  /**
   * Routing decisions that produced no run.
   *
   * A trigger that matches nothing, or matches a busy agent, is invisible
   * today: it reaches local stdout and stops there. "Nothing happened and no
   * one can tell you why" is the worst failure this system has, so a bounded
   * tail of these rides along with health.
   */
  skips?: SkipReport[]
}

export interface AgentHealth {
  profile: string
  status: 'idle' | 'busy' | 'awaiting_approval'
  runId?: string
}

export interface SkipReport {
  reason: string
  ref: string
  routeId?: string
  at: number
}

export type OutboxItem =
  | { kind: 'run'; run: RunRecord }
  | { kind: 'run-update'; run: RunRecord }
  | { kind: 'events'; runId: string; events: RunLogEntry[] }

/** Storage the outbox needs. Narrowed so tests can stand in a fake. */
export interface MirrorStore {
  enqueueMirror(kind: string, payload: unknown): number
  peekMirror(limit?: number): Array<{ seq: number; kind: string; payload: unknown }>
  ackMirror(seq: number): void
  countMirrorPending(): number
  trimMirror(keep: number): number
}

export interface MirrorOutboxOptions {
  /** How long to wait after an enqueue before draining, to batch bursts. */
  debounceMs?: number
  /** First retry delay after a failed send; doubles up to `maxBackoffMs`. */
  backoffMs?: number
  maxBackoffMs?: number
  /** Backlog above which the oldest writes are dropped, loudly. */
  maxPending?: number
}

/**
 * Ships run state to the cloud, durably and promptly.
 *
 * Two things about this are load-bearing, and both were wrong before:
 *
 * 1. **It drains on its own.** The previous outbox was flushed by the poll
 *    loop, whose last act is a 25-second long poll, so a status change waited
 *    out the rest of a cycle before anyone off this network could see it. The
 *    cloud is the only view of this runner from elsewhere; it may not lag by a
 *    minute.
 * 2. **It survives a restart.** The queue lives in SQLite, so a crash, a
 *    deploy, or a cloud outage cannot silently strand a finished run in
 *    "running" forever. Delivery is at-least-once: every mirror write is an
 *    upsert, so a duplicate is harmless where a loss is not.
 */
export class MirrorOutbox {
  private readonly debounceMs: number
  private readonly backoffMs: number
  private readonly maxBackoffMs: number
  private readonly maxPending: number

  private timer: NodeJS.Timeout | undefined
  private draining = false
  private stopped = false
  private failures = 0

  constructor(
    private readonly client: CloudClient,
    private readonly store: MirrorStore,
    private readonly onError: (message: string) => void,
    options: MirrorOutboxOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 200
    this.backoffMs = options.backoffMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.maxPending = options.maxPending ?? 10_000
  }

  get size(): number {
    return this.store.countMirrorPending()
  }

  enqueue(item: OutboxItem): void {
    const { kind, ...payload } = item
    this.store.enqueueMirror(kind, payload)

    const pending = this.store.countMirrorPending()
    if (pending > this.maxPending) {
      const dropped = this.store.trimMirror(this.maxPending)
      this.onError(`Mirror backlog over ${this.maxPending}; dropped ${dropped} oldest write(s).`)
    }

    this.schedule(this.debounceMs)
  }

  /** Begins draining whatever a previous process left behind. */
  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer || this.draining) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delayMs)
    // A pending flush must never hold the process open on its own.
    this.timer.unref?.()
  }

  /**
   * Sends everything pending, oldest first.
   *
   * Stops at the first failure so ordering is preserved -- a run update that
   * overtook its own creation would be rejected -- and retries with backoff.
   */
  async flush(): Promise<void> {
    if (this.draining || this.stopped) {
      return
    }
    this.draining = true
    try {
      for (;;) {
        const batch = this.store.peekMirror(50)
        if (batch.length === 0) {
          this.failures = 0
          return
        }

        for (const entry of batch) {
          try {
            await this.send(entry.kind, entry.payload)
            this.store.ackMirror(entry.seq)
          } catch (error: unknown) {
            this.failures += 1
            const backoff = Math.min(
              this.maxBackoffMs,
              this.backoffMs * 2 ** Math.min(this.failures - 1, 5)
            )
            this.onError(
              `Cloud mirror deferred (${this.store.countMirrorPending()} pending, retrying in ${Math.round(backoff / 1000)}s): ${error instanceof Error ? error.message : String(error)}`
            )
            this.draining = false
            this.schedule(backoff)
            return
          }
        }
        this.failures = 0
      }
    } finally {
      this.draining = false
    }
  }

  private async send(kind: string, payload: unknown): Promise<void> {
    const item = payload as Omit<OutboxItem, 'kind'> & {
      run?: RunRecord
      runId?: string
      events?: RunLogEntry[]
    }

    if (kind === 'run' && item.run) {
      await this.client.mirrorRun(item.run)
      return
    }
    if (kind === 'run-update' && item.run) {
      await this.client.mirrorRunUpdate(item.run)
      return
    }
    if (kind === 'events' && item.runId && item.events) {
      await this.client.mirrorEvents(item.runId, item.events)
      return
    }
    // A row this process cannot interpret came from a newer build. Dropping it
    // is better than blocking every later write behind it forever.
    this.onError(`Discarding unrecognized mirror item of kind "${kind}".`)
  }
}
