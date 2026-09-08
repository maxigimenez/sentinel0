import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import {
  RUN_STATUS,
  TRIGGER_TYPE,
  isTerminalRunStatus,
  type RunApprovalDetail,
  type RunLogEntry,
  type RunRecord,
  type RunStatus,
  type RunUsage,
  type TriggerChanges,
} from '@sentinel0/common'

/** A run that has not settled still owns its dispatch claim. */
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  RUN_STATUS.QUEUED,
  RUN_STATUS.RUNNING,
  RUN_STATUS.AWAITING_APPROVAL,
]

/** Members of `next` that were not in `previous`, compared case-insensitively. */
function added(previous: string[], next: string[]): string[] {
  const before = new Set(previous.map((value) => value.toLowerCase()))
  return next.filter((value) => !before.has(value.toLowerCase()))
}

export function resolveDbPath(): string {
  if (process.env.SENTINEL0_DB_PATH) {
    return process.env.SENTINEL0_DB_PATH === 'memory'
      ? 'memory'
      : path.resolve(process.env.SENTINEL0_DB_PATH)
  }
  if (process.env.SENTINEL0_DATA_DIR) {
    return path.resolve(process.env.SENTINEL0_DATA_DIR, 'sentinel0.db')
  }
  return path.resolve(process.cwd(), 'sentinel0.db')
}

/** Idempotent `ALTER TABLE ... ADD COLUMN`, for databases that already exist. */
function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * Rewrites observation rows that were keyed `<triggerType>:<ref>` onto the bare
 * ref.
 *
 * The old key gave every trigger type its own baseline for the same item, which
 * quietly made `pr_review_requested` transitions impossible to detect: that
 * event is only emitted once a reviewer exists, so its very first row was
 * written at the moment of the transition a route wanted to fire on — and
 * first sight reports no changes. `pr_event` is emitted for every open pull
 * request whether or not anyone has been asked to review, so its row is the one
 * holding the true history; it wins where both exist, and the rest are dropped.
 *
 * Without this a running install would go quiet for one cycle after upgrading,
 * reseeding a baseline it already had.
 */
function migrateObservationKeys(db: DatabaseSync): void {
  const legacy = db
    .prepare("SELECT projectId, ref FROM observations WHERE ref LIKE '%:%'")
    .all() as { projectId: string; ref: string }[]

  const prefixes = Object.values(TRIGGER_TYPE).map((type) => `${type}:`)

  // pr_event is emitted for every open pull request whether or not a review was
  // requested, so its row is the one holding real history. Promoting it last
  // lets it overwrite whatever a narrower type seeded.
  const rank = (ref: string): number => (ref.startsWith(`${TRIGGER_TYPE.PR_EVENT}:`) ? 1 : 0)
  legacy.sort((a, b) => rank(a.ref) - rank(b.ref))

  for (const row of legacy) {
    const prefix = prefixes.find((candidate) => row.ref.startsWith(candidate))
    // A ref that merely contains a colon and was never one of ours.
    if (prefix) {
      db.prepare(
        `INSERT INTO observations (projectId, ref, labels, assignees, reviewers, observedAt)
         SELECT projectId, ?, labels, assignees, reviewers, observedAt
           FROM observations WHERE projectId = ? AND ref = ?
         ON CONFLICT (projectId, ref) DO UPDATE SET
           labels = excluded.labels,
           assignees = excluded.assignees,
           reviewers = excluded.reviewers,
           observedAt = excluded.observedAt`
      ).run(row.ref.slice(prefix.length), row.projectId, row.ref)

      db.prepare('DELETE FROM observations WHERE projectId = ? AND ref = ?').run(
        row.projectId,
        row.ref
      )
    }
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      routeId TEXT NOT NULL,
      routeName TEXT NOT NULL,
      agentProfile TEXT NOT NULL,
      projectId TEXT NOT NULL,
      triggerType TEXT NOT NULL,
      triggerRef TEXT NOT NULL,
      triggerRevision TEXT NOT NULL,
      triggerUrl TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      hermesRunId TEXT,
      hermesSessionId TEXT,
      approvalDetail TEXT,
      summary TEXT,
      error TEXT,
      usage TEXT,
      startedAt INTEGER,
      endedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `)

  // `runId` here is the run's actual primary key. The predecessor table called
  // this column `taskExternalId` while storing the internal id -- a misnomer
  // that cost real debugging time. Naming it for what it holds is the fix.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      title TEXT,
      message TEXT NOT NULL,
      icon TEXT NOT NULL,
      level TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      groupId TEXT
    );
  `)

  // The dedupe ledger. The primary key IS the concurrency control: claiming a
  // dispatch is one INSERT OR IGNORE, so the poll loop cannot double-fire a
  // route for an unchanged ticket even if two cycles overlap.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_ledger (
      dedupeKey TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      routeId TEXT NOT NULL,
      triggerRef TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `)

  // What each item looked like last cycle, so "label added" can mean added
  // rather than merely present.
  //
  // Keyed by the item, not by the trigger type it raised. One pull request can
  // raise two events, and giving each its own baseline made the transition
  // history of the narrower one useless -- see migrateObservationKeys.
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      projectId  TEXT NOT NULL,
      ref        TEXT NOT NULL,
      labels     TEXT NOT NULL,
      assignees  TEXT NOT NULL,
      reviewers  TEXT NOT NULL,
      observedAt INTEGER NOT NULL,
      PRIMARY KEY (projectId, ref)
    );
  `)

  // The newest item-creation timestamp seen per project, in the provider's own
  // clock. What separates "created while we were watching" from "already there
  // when we arrived" -- see triggers/history.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_watch (
      projectId    TEXT PRIMARY KEY,
      maxCreatedAt TEXT NOT NULL
    );
  `)

  /*
   * The write-ahead log for the cloud mirror.
   *
   * Previously the outbox was an in-memory array drained once per poll cycle,
   * so a restart, a crash, or a backlog over 500 items silently dropped
   * whatever had not been sent -- and the cloud, which is the only view of this
   * runner from off its network, kept showing runs that had long since
   * finished. Durable here, delivered by its own loop, at-least-once.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS mirror_outbox (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `)

  // Existing installs predate these columns; `CREATE TABLE IF NOT EXISTS` alone
  // would leave them behind on every machine that has already run.
  addColumn(db, 'runs', 'approvalDetail', 'TEXT')
  migrateObservationKeys(db)

  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updatedAt DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updatedAt DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agentProfile, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(runId, timestamp, id)')
}

interface RunRow {
  id: string
  routeId: string
  routeName: string
  agentProfile: string
  projectId: string
  triggerType: string
  triggerRef: string
  triggerRevision: string
  triggerUrl: string | null
  title: string
  status: string
  hermesRunId: string | null
  hermesSessionId: string | null
  approvalDetail: string | null
  summary: string | null
  error: string | null
  usage: string | null
  startedAt: number | null
  endedAt: number | null
  createdAt: number
  updatedAt: number
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    routeId: row.routeId,
    routeName: row.routeName,
    agentProfile: row.agentProfile,
    projectId: row.projectId,
    triggerType: row.triggerType as RunRecord['triggerType'],
    triggerRef: row.triggerRef,
    triggerRevision: row.triggerRevision,
    triggerUrl: row.triggerUrl ?? undefined,
    title: row.title,
    status: row.status as RunStatus,
    hermesRunId: row.hermesRunId ?? undefined,
    hermesSessionId: row.hermesSessionId ?? undefined,
    approvalDetail: row.approvalDetail
      ? (JSON.parse(row.approvalDetail) as RunApprovalDetail)
      : undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    usage: row.usage ? (JSON.parse(row.usage) as RunUsage) : undefined,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface ListRunsOptions {
  limit?: number
  projectId?: string
  status?: RunStatus
}

export interface RunPatch {
  status?: RunStatus
  hermesRunId?: string
  hermesSessionId?: string
  /** `null` clears a gate that has been answered; `undefined` leaves it alone. */
  approvalDetail?: RunApprovalDetail | null
  summary?: string
  error?: string
  usage?: RunUsage
  startedAt?: number
  endedAt?: number
}

export class Sentinel0Database {
  constructor(private readonly db: DatabaseSync) {
    migrate(db)
  }

  createRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, routeId, routeName, agentProfile, projectId,
          triggerType, triggerRef, triggerRevision, triggerUrl,
          title, status, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.routeId,
        run.routeName,
        run.agentProfile,
        run.projectId,
        run.triggerType,
        run.triggerRef,
        run.triggerRevision,
        run.triggerUrl ?? null,
        run.title,
        run.status,
        run.createdAt,
        run.updatedAt
      )
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    const clauses: string[] = []
    const params: Array<string | number> = []

    if (options.projectId) {
      clauses.push('projectId = ?')
      params.push(options.projectId)
    }
    if (options.status) {
      clauses.push('status = ?')
      params.push(options.status)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
    params.push(limit)

    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY updatedAt DESC LIMIT ?`)
      .all(...params) as unknown as RunRow[]

    return rows.map(toRun)
  }

  updateRun(id: string, patch: RunPatch, now: number = Date.now()): void {
    const sets: string[] = ['updatedAt = ?']
    const params: Array<string | number | null> = [now]

    const assign = (column: string, value: string | number | null | undefined): void => {
      if (value !== undefined) {
        sets.push(`${column} = ?`)
        params.push(value)
      }
    }

    assign('status', patch.status)
    assign('hermesRunId', patch.hermesRunId)
    assign('hermesSessionId', patch.hermesSessionId)
    assign('summary', patch.summary)
    assign('error', patch.error)
    assign('startedAt', patch.startedAt)
    assign('endedAt', patch.endedAt)
    assign('usage', patch.usage ? JSON.stringify(patch.usage) : undefined)
    assign(
      'approvalDetail',
      patch.approvalDetail === undefined
        ? undefined
        : patch.approvalDetail === null
          ? null
          : JSON.stringify(patch.approvalDetail)
    )

    params.push(id)
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  /**
   * Runs currently occupying an agent.
   *
   * Hermes corrupts a profile's memory if two agents drive it at once, so the
   * dispatcher consults this before starting work on a profile.
   */
  countActiveRunsForAgent(agentProfile: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM runs
         WHERE agentProfile = ? AND status IN (?, ?, ?)`
      )
      .get(agentProfile, RUN_STATUS.QUEUED, RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_APPROVAL) as {
      count: number
    }
    return row.count
  }

  listUnfinishedRuns(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE status IN (?, ?, ?) ORDER BY createdAt ASC')
      .all(
        RUN_STATUS.QUEUED,
        RUN_STATUS.RUNNING,
        RUN_STATUS.AWAITING_APPROVAL
      ) as unknown as RunRow[]
    return rows.map(toRun)
  }

  // ── Events ─────────────────────────────────────────────────

  appendRunEvent(runId: string, entry: RunLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO run_events (runId, title, message, icon, level, timestamp, kind, source, groupId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        entry.title ?? null,
        entry.message,
        entry.icon,
        entry.level,
        entry.timestamp,
        entry.kind,
        entry.source,
        entry.groupId ?? null
      )
  }

  listRunEvents(runId: string, options: { since?: number; limit?: number } = {}): RunLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
    const rows = this.db
      .prepare(
        `SELECT title, message, icon, level, timestamp, kind, source, groupId
         FROM run_events WHERE runId = ? AND timestamp >= ?
         ORDER BY timestamp ASC, id ASC LIMIT ?`
      )
      .all(runId, options.since ?? 0, limit) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      title: (row.title as string | null) ?? undefined,
      message: row.message as string,
      icon: row.icon as string,
      level: row.level as RunLogEntry['level'],
      timestamp: row.timestamp as number,
      kind: row.kind as RunLogEntry['kind'],
      source: row.source as RunLogEntry['source'],
      groupId: (row.groupId as string | null) ?? undefined,
    }))
  }

  /**
   * Events recorded after `afterId`, with their ids.
   *
   * The id is the high-water mark the cloud mirror advances on. Timestamps
   * cannot serve: two events inside the same millisecond are common on a busy
   * stream, and `>= since` would either resend or skip them.
   */
  listRunEventsSince(
    runId: string,
    afterId: number,
    limit = 200
  ): Array<{ id: number; entry: RunLogEntry }> {
    const rows = this.db
      .prepare(
        `SELECT id, title, message, icon, level, timestamp, kind, source, groupId
         FROM run_events WHERE runId = ? AND id > ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(runId, afterId, Math.min(Math.max(limit, 1), 2000)) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      id: Number(row.id),
      entry: {
        title: (row.title as string | null) ?? undefined,
        message: row.message as string,
        icon: row.icon as string,
        level: row.level as RunLogEntry['level'],
        timestamp: row.timestamp as number,
        kind: row.kind as RunLogEntry['kind'],
        source: row.source as RunLogEntry['source'],
        groupId: (row.groupId as string | null) ?? undefined,
      },
    }))
  }

  // ── Observations ───────────────────────────────────────────

  /**
   * Records what an item looks like now and reports what changed.
   *
   * Returns undefined the first time an item is seen. That is deliberate: with
   * no prior observation every label looks newly added, and a freshly created
   * route would fire across an entire existing backlog. First sight seeds the
   * baseline silently; only a genuine subsequent change produces transitions.
   */
  observe(
    projectId: string,
    ref: string,
    current: { labels: string[]; assignees: string[]; reviewers: string[] },
    now: number = Date.now()
  ): TriggerChanges | undefined {
    const changes = this.changesSince(projectId, ref, current)

    this.db
      .prepare(
        `INSERT INTO observations (projectId, ref, labels, assignees, reviewers, observedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (projectId, ref) DO UPDATE SET
           labels = excluded.labels,
           assignees = excluded.assignees,
           reviewers = excluded.reviewers,
           observedAt = excluded.observedAt`
      )
      .run(
        projectId,
        ref,
        JSON.stringify(current.labels),
        JSON.stringify(current.assignees),
        JSON.stringify(current.reviewers),
        now
      )

    return changes
  }

  /**
   * What changed, without recording anything.
   *
   * The read half of `observe`, split out for the explain endpoint: asking why
   * a route did not fire must not move the baseline it is being asked about,
   * or the question would answer itself differently every time it is put.
   */
  changesSince(
    projectId: string,
    ref: string,
    current: { labels: string[]; assignees: string[]; reviewers: string[] }
  ): TriggerChanges | undefined {
    const row = this.db
      .prepare(
        'SELECT labels, assignees, reviewers FROM observations WHERE projectId = ? AND ref = ?'
      )
      .get(projectId, ref) as { labels: string; assignees: string; reviewers: string } | undefined

    if (!row) {
      return undefined
    }

    const previous = {
      labels: JSON.parse(row.labels) as string[],
      assignees: JSON.parse(row.assignees) as string[],
      reviewers: JSON.parse(row.reviewers) as string[],
    }

    return {
      labelsAdded: added(previous.labels, current.labels),
      labelsRemoved: added(current.labels, previous.labels),
      assigneesAdded: added(previous.assignees, current.assignees),
      assigneesRemoved: added(current.assignees, previous.assignees),
      reviewersAdded: added(previous.reviewers, current.reviewers),
    }
  }

  /**
   * Re-runs the observation key migration.
   *
   * Exposed because a migration that only ever runs inside the constructor
   * cannot be tested, and this one decides whether a live install keeps the
   * history it already had or goes quiet for a cycle. It is idempotent.
   */
  migrateObservationKeys(): void {
    migrateObservationKeys(this.db)
  }

  /** The newest creation timestamp seen for a project, or undefined on its first cycle. */
  watermarkFor(projectId: string): string | undefined {
    const row = this.db
      .prepare('SELECT maxCreatedAt FROM project_watch WHERE projectId = ?')
      .get(projectId) as { maxCreatedAt: string } | undefined
    return row?.maxCreatedAt
  }

  /**
   * Moves a project's watermark forward, never back.
   *
   * Monotonic because a provider can report an item created *before* one
   * already seen -- a pull request reopened, a filter widened, a page arriving
   * out of order -- and letting the watermark drop would make every item newer
   * than it look freshly born.
   */
  advanceWatermark(projectId: string, createdAt: string | undefined): void {
    if (!createdAt) {
      return
    }
    this.db
      .prepare(
        `INSERT INTO project_watch (projectId, maxCreatedAt) VALUES (?, ?)
         ON CONFLICT (projectId) DO UPDATE SET
           maxCreatedAt = MAX(excluded.maxCreatedAt, project_watch.maxCreatedAt)`
      )
      .run(projectId, createdAt)
  }

  pruneObservations(olderThan: number): number {
    const result = this.db.prepare('DELETE FROM observations WHERE observedAt < ?').run(olderThan)
    return Number(result.changes)
  }

  // ── Dispatch ledger ────────────────────────────────────────

  /**
   * Atomically claim the right to dispatch this (route, trigger, revision).
   *
   * Returns false when the key was already claimed, which is the normal case:
   * every poll cycle re-observes every open ticket, and only a genuine change
   * to the ticket produces a new revision and therefore a new key.
   */
  claimDispatch(
    dedupeKey: string,
    claim: { runId: string; routeId: string; triggerRef: string },
    now: number = Date.now()
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO dispatch_ledger (dedupeKey, runId, routeId, triggerRef, createdAt)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(dedupeKey, claim.runId, claim.routeId, claim.triggerRef, now)

    return Number(result.changes) > 0
  }

  /**
   * Undo a claim. Used when dispatch fails before the agent was ever reached,
   * so a transient error does not permanently suppress that trigger.
   */
  /**
   * Releases a `while-matched` route's claims on items it no longer matches.
   *
   * This is what re-arms such a route. A claim held while the condition is true
   * is what stops a fresh run on every push; releasing it the moment the
   * condition lapses is what lets the *next* request through.
   *
   * A claim whose run has not finished is never released -- during a run the
   * item carries `sentinel0:in-progress` and so stops matching by construction,
   * and releasing on that basis would re-arm the route against the work it is
   * still doing.
   */
  releaseUnmatchedClaims(routeId: string, matchedRefs: readonly string[]): number {
    const placeholders = matchedRefs.map(() => '?').join(', ')
    const notMatched = matchedRefs.length > 0 ? `AND triggerRef NOT IN (${placeholders})` : ''
    const active = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')

    const result = this.db
      .prepare(
        `DELETE FROM dispatch_ledger
          WHERE routeId = ?
            ${notMatched}
            AND runId NOT IN (SELECT id FROM runs WHERE status IN (${active}))`
      )
      .run(routeId, ...matchedRefs, ...ACTIVE_RUN_STATUSES)

    return Number(result.changes)
  }

  releaseDispatch(dedupeKey: string): void {
    this.db.prepare('DELETE FROM dispatch_ledger WHERE dedupeKey = ?').run(dedupeKey)
  }

  hasDispatched(dedupeKey: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM dispatch_ledger WHERE dedupeKey = ?').get(dedupeKey) !==
      undefined
    )
  }

  /** Drops ledger rows whose runs have long since finished. */
  pruneDispatchLedger(olderThan: number): number {
    const result = this.db.prepare('DELETE FROM dispatch_ledger WHERE createdAt < ?').run(olderThan)
    return Number(result.changes)
  }

  // ── Cloud mirror outbox ────────────────────────────────────

  /**
   * Records one pending mirror write.
   *
   * Returns the assigned sequence so the drain can delete exactly what it sent
   * rather than truncating a queue that may have grown underneath it.
   */
  enqueueMirror(kind: string, payload: unknown, now: number = Date.now()): number {
    const result = this.db
      .prepare('INSERT INTO mirror_outbox (kind, payload, createdAt) VALUES (?, ?, ?)')
      .run(kind, JSON.stringify(payload), now)
    return Number(result.lastInsertRowid)
  }

  /** The oldest pending writes, in the order they were made. */
  peekMirror(limit = 50): Array<{ seq: number; kind: string; payload: unknown }> {
    const rows = this.db
      .prepare('SELECT seq, kind, payload FROM mirror_outbox ORDER BY seq ASC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as unknown as Array<{
      seq: number
      kind: string
      payload: string
    }>
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    }))
  }

  ackMirror(seq: number): void {
    this.db.prepare('DELETE FROM mirror_outbox WHERE seq = ?').run(seq)
  }

  countMirrorPending(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM mirror_outbox').get() as {
      count: number
    }
    return row.count
  }

  /**
   * Drops the oldest pending writes when the backlog is absurd.
   *
   * A cloud that has been unreachable for days is not worth an unbounded local
   * file, but unlike the old in-memory queue this is a deliberate, reported
   * decision rather than something that happens on every restart.
   */
  trimMirror(keep: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM mirror_outbox WHERE seq NOT IN (
           SELECT seq FROM mirror_outbox ORDER BY seq DESC LIMIT ?
         )`
      )
      .run(Math.max(keep, 1))
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}

export function openDatabase(dbPath: string = resolveDbPath()): Sentinel0Database {
  return new Sentinel0Database(new DatabaseSync(dbPath === 'memory' ? ':memory:' : dbPath))
}

export { isTerminalRunStatus }

let singleton: Sentinel0Database | undefined

/**
 * Process-wide handle, opened on first use.
 *
 * Lazy on purpose: the previous module-level `const db = new DatabaseSync(...)`
 * created a SQLite file as an import side effect, so merely importing this
 * module from a CLI command or a test wrote a stray `sentinel0.db` into the cwd.
 * Tests should open their own with `openDatabase('memory')`.
 */
export function getDatabase(): Sentinel0Database {
  singleton ??= openDatabase()
  return singleton
}

/** Test seam: point the process-wide handle at an explicit database. */
export function setDatabase(db: Sentinel0Database): void {
  singleton = db
}
