// ─────────────────────────────────────────────────────────────
// Run lifecycle
// ─────────────────────────────────────────────────────────────

export const RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS]

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  RUN_STATUS.COMPLETED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELED,
]

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

// ─────────────────────────────────────────────────────────────
// Ticket providers
// ─────────────────────────────────────────────────────────────

export const TICKET_PROVIDER = {
  LINEAR: 'linear',
  GITHUB: 'github',
} as const

export type TicketProvider = (typeof TICKET_PROVIDER)[keyof typeof TICKET_PROVIDER]

// ─────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────

export const LOG_LEVEL = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  SUCCESS: 'success',
} as const

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL]

export const RUN_LOG_LEVEL = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
} as const

export type RunLogLevel = (typeof RUN_LOG_LEVEL)[keyof typeof RUN_LOG_LEVEL]

export const RUN_LOG_KIND = {
  LIFECYCLE: 'lifecycle',
  AGENT_MESSAGE: 'agent_message',
  REASONING: 'reasoning',
  COMMAND: 'command',
  FILE_CHANGE: 'file_change',
  SUBAGENT: 'subagent',
  MCP: 'mcp',
  WARNING: 'warning',
  ERROR: 'error',
  RESULT: 'result',
} as const

export type RunLogKind = (typeof RUN_LOG_KIND)[keyof typeof RUN_LOG_KIND]

export const RUN_LOG_SOURCE = {
  SYSTEM: 'system',
  AGENT: 'agent',
  HERMES: 'hermes',
  GITHUB: 'github',
  LINEAR: 'linear',
} as const

export type RunLogSource = (typeof RUN_LOG_SOURCE)[keyof typeof RUN_LOG_SOURCE]

export interface RunLogEntry {
  title?: string
  message: string
  icon: string
  level: RunLogLevel
  timestamp: number
  kind: RunLogKind
  source: RunLogSource
  groupId?: string
}

export interface Logger {
  info: (msg: string, runId?: string) => void
  success: (msg: string, runId?: string) => void
  warn: (msg: string, runId?: string) => void
  error: (msg: string, runId?: string) => void
  event: (entry: {
    runId: string
    title?: string
    message: string
    level?: RunLogLevel
    kind: RunLogKind
    source: RunLogSource
    icon?: string
    groupId?: string
  }) => void
}

// ─────────────────────────────────────────────────────────────
// Hermes agent inventory
// ─────────────────────────────────────────────────────────────

/**
 * A Hermes profile as discovered through its API server. This is what the
 * runner pushes to the cloud registry; it is derived state, never hand-edited.
 */
export interface AgentDescriptor {
  profile: string
  displayName?: string
  role?: string
  model?: string
  provider?: string
  toolsets: string[]
  skills: string[]
  githubLogin?: string
  avatarUrl?: string
  enabled: boolean
  discoveredAt: number
}

// ─────────────────────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────────────────────

export const TRIGGER_TYPE = {
  TICKET: 'ticket',
  PR_REVIEW_REQUESTED: 'pr_review_requested',
  PR_EVENT: 'pr_event',
  SCHEDULE: 'schedule',
  MANUAL: 'manual',
} as const

export type TriggerType = (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE]

/**
 * A normalized "something happened" fact, produced by a trigger source and fed
 * to the rule engine. `revision` captures the mutable parts of the source
 * object so that re-observing an unchanged ticket does not re-fire a route.
 */
export interface TriggerEvent {
  type: TriggerType
  projectId: string
  provider: TicketProvider
  ref: string
  revision: string
  title: string
  body: string
  url?: string
  labels: string[]
  state?: string
  assignees?: string[]
  prNumber?: number
  requestedReviewers?: string[]
  isDraft?: boolean
  baseBranch?: string
  /**
   * What changed since the last time this item was observed.
   *
   * Absent on first sight: an item seen for the first time has no history, and
   * treating everything about it as newly added would fire "label added" routes
   * across an entire existing backlog the moment a route is created.
   */
  changes?: TriggerChanges
}

export interface TriggerChanges {
  labelsAdded: string[]
  labelsRemoved: string[]
  assigneesAdded: string[]
  assigneesRemoved: string[]
  reviewersAdded: string[]
}

// ─────────────────────────────────────────────────────────────
// Routing rules
// ─────────────────────────────────────────────────────────────

/** Set predicate. `any` = OR, `all` = AND, `none` = NOR. Omitted keys are ignored. */
export interface StringSetMatch {
  any?: string[]
  all?: string[]
  none?: string[]
}

export interface RouteMatch {
  /** Matched against the item's current labels. */
  labels?: StringSetMatch
  state?: StringSetMatch
  titleMatches?: string
  bodyMatches?: string
  /** Matched against current assignees. */
  assignees?: StringSetMatch
  /**
   * Matched against reviewers currently requested.
   *
   * The state counterpart of `reviewersAdded`. Transition clauses cannot match
   * the first time an item is seen -- there is nothing to compare against --
   * so a route that must work for requests made while the runner was down
   * needs this one, and relies on the dispatch ledger rather than on history
   * to fire only once per change.
   */
  reviewers?: StringSetMatch
  /**
   * Matched against what changed since the previous observation.
   *
   * These never match on first sight, which is what stops a new route from
   * firing across every item that already exists.
   */
  labelsAdded?: StringSetMatch
  labelsRemoved?: StringSetMatch
  assigneesAdded?: StringSetMatch
  /**
   * Reviewers newly requested since the last poll.
   *
   * The precise primitive for a review cycle: it fires when someone is *asked*
   * to review, not while a request happens to be outstanding. An agent posting
   * comments does not add a reviewer, so a route keyed on this cannot retrigger
   * itself no matter what the agent does.
   */
  reviewersAdded?: StringSetMatch
  /** Only meaningful for pull requests. */
  isDraft?: boolean
  baseBranch?: StringSetMatch
}

export interface RouteTarget {
  agentRef: {
    profile?: string
    githubLogin?: string
  }
}

export interface RouteExecution {
  /**
   * The prompt sent to the agent, as free text with `{{variable}}` placeholders.
   *
   * Stored per route rather than selected from a fixed set of built-ins: the
   * wording of what an agent is asked to do is the main thing an operator wants
   * to tune, and shipping a code change to reword a prompt is absurd. The
   * built-in templates survive only as a catalog to prefill this at creation
   * time -- see PROMPT_VARIABLES for what can be interpolated.
   */
  prompt: string
  requireApproval: boolean
  modelOverride?: string | null
  timeoutSeconds: number
  /**
   * How long a run may sit waiting for a human to answer Hermes' approval gate.
   *
   * Separate from `timeoutSeconds` because the two measure different things:
   * that one bounds how long the agent may work, this one bounds how long a
   * person may take to notice Slack. The run clock stops while the approval
   * clock runs, so a deliberating human never eats the agent's budget.
   */
  approvalTimeoutSeconds?: number
}

/**
 * Hermes' approval vocabulary, verbatim.
 *
 * `POST /v1/runs/{id}/approval` takes `{"choice": ...}` and rejects anything
 * else with `invalid_approval_choice`, so this union is the wire contract and
 * not a Sentinel0 invention. The dashboard offers approve (`session`) and deny;
 * `once` and `always` exist for the CLI and for completeness.
 */
export const APPROVAL_CHOICE = {
  ONCE: 'once',
  SESSION: 'session',
  ALWAYS: 'always',
  DENY: 'deny',
} as const

export type ApprovalChoice = (typeof APPROVAL_CHOICE)[keyof typeof APPROVAL_CHOICE]

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = Object.values(APPROVAL_CHOICE)

export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return typeof value === 'string' && (APPROVAL_CHOICES as readonly string[]).includes(value)
}

/** One hour: long enough to walk away from Slack, short enough to free the agent. */
export const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 3600

/**
 * Placeholders available inside `RouteExecution.prompt`.
 *
 * Declared here rather than in the renderer so the cloud can advertise them to
 * the dashboard without importing the runner.
 */
export const PROMPT_VARIABLES = [
  'ticket.ref',
  'ticket.title',
  'ticket.body',
  'ticket.url',
  'ticket.state',
  'ticket.labels',
  'ticket.assignees',
  'project.id',
  'repo.slug',
  'agent.profile',
  'agent.role',
  'pr.number',
  'pr.reviewers',
  'pr.baseBranch',
  'changes.labelsAdded',
  'changes.labelsRemoved',
  'changes.assigneesAdded',
  'changes.reviewersAdded',
] as const

export type PromptVariable = (typeof PROMPT_VARIABLES)[number]

export const COMMENT_TARGET = {
  TICKET: 'ticket',
  PR: 'pr',
  NONE: 'none',
} as const

export type CommentTarget = (typeof COMMENT_TARGET)[keyof typeof COMMENT_TARGET]

export interface RouteOutcome {
  postComment?: { target: CommentTarget }
  labels?: { add?: string[]; remove?: string[] }
}

/**
 * How often a route may fire for the same item, and whether it marks its work.
 *
 * The default is the safe one. An agent that acts on a pull request changes it
 * — a commit, a review, a comment — which changes the item's revision, which
 * would otherwise re-trigger the very route that started it. Firing once per
 * item unless told otherwise means a route cannot loop by construction.
 */
export interface RouteGuard {
  /**
   * `once`       fire at most once per item, whatever changes afterwards.
   * `per-change` fire again each time the item changes.
   */
  refire: 'once' | 'per-change'
  /**
   * Apply `sentinel0:` marker labels around the run, and skip items already
   * carrying one. Markers make an in-flight run visible in the tracker and let
   * a human re-arm a route by removing the label.
   */
  markers: boolean
}

export interface RoutingRule {
  id: string
  name: string
  priority: number
  enabled: boolean
  guard?: RouteGuard
  trigger: {
    type: TriggerType
    provider?: TicketProvider
    projectId: string
  }
  match: RouteMatch
  target: RouteTarget
  execution: RouteExecution
  outcome: RouteOutcome
}

// ─────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────

export interface RunUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
}

/**
 * What an agent is waiting to be allowed to do.
 *
 * Hermes' run state is the preferred source; when it says only "pending
 * approval" without saying what for, the adapter falls back to the last tool
 * call it saw on the event stream. Either way this is a hint for a human, never
 * something matched on -- hence every field optional.
 */
export interface RunApprovalDetail {
  tool?: string
  command?: string
  arguments?: string
  requestedAt: number
}

export interface RunRecord {
  id: string
  routeId: string
  routeName: string
  agentProfile: string
  projectId: string
  triggerType: TriggerType
  triggerRef: string
  triggerRevision: string
  triggerUrl?: string
  title: string
  status: RunStatus
  hermesRunId?: string
  hermesSessionId?: string
  approvalDetail?: RunApprovalDetail
  summary?: string
  error?: string
  usage?: RunUsage
  startedAt?: number
  endedAt?: number
  createdAt: number
  updatedAt: number
}

// ─────────────────────────────────────────────────────────────
// Configuration (~/.sentinel0/config.json)
// ─────────────────────────────────────────────────────────────

export interface HermesProfileConfig {
  name: string
  apiKey: string
  githubLogin?: string
  role?: string
  /** Shown beside this agent's Slack notifications. */
  avatarUrl?: string
  enabled: boolean
}

export interface HermesConfig {
  baseUrl: string
  profiles: HermesProfileConfig[]
}

export interface CloudConfig {
  baseUrl: string
  apiKey: string
  runnerName: string
}

export interface ProjectConfig {
  id: string
  provider: TicketProvider
  filters: {
    team?: string
    state?: string
    labels?: string[]
    project?: string
    owner?: string
    repo?: string
  }
}

export interface StoredConfig {
  version: number
  cloud: CloudConfig | null
  hermes: HermesConfig | null
  projects: ProjectConfig[]
  secrets: Record<string, string>
  updatedAt: number
}

export interface ServerConfig {
  apiPort: number
  networkAccess: boolean
}

export interface AppConfig {
  projects: ProjectConfig[]
  hermes: HermesConfig | null
  cloud: CloudConfig | null
  concurrency: number
  logs: LogLevel[]
  server: ServerConfig
}

export const CONFIG_VERSION = 2
export const DEFAULT_API_PORT = 9371
export const DEFAULT_CONCURRENCY = 2

/** Hermes' own docs warn that two agents must never drive one profile at once. */
export const MAX_CONCURRENT_RUNS_PER_AGENT = 1

// ─────────────────────────────────────────────────────────────
// Reserved labels
// ─────────────────────────────────────────────────────────────

/**
 * Namespace Sentinel0 writes into.
 *
 * Everything Sentinel0 applies to a ticket or pull request is prefixed, so it is
 * obvious in the tracker which labels are machine-managed, and so a human can
 * clear them to re-arm a route.
 */
export const SENTINEL0_LABEL_PREFIX = 'sentinel0:'

export const SENTINEL0_LABEL = {
  IN_PROGRESS: 'sentinel0:in-progress',
  DONE: 'sentinel0:done',
  FAILED: 'sentinel0:failed',
} as const

export type Sentinel0Label = (typeof SENTINEL0_LABEL)[keyof typeof SENTINEL0_LABEL]

export const SENTINEL0_LABELS: Sentinel0Label[] = [
  SENTINEL0_LABEL.IN_PROGRESS,
  SENTINEL0_LABEL.DONE,
  SENTINEL0_LABEL.FAILED,
]

export function isSentinel0Label(label: string): boolean {
  return label.trim().toLowerCase().startsWith(SENTINEL0_LABEL_PREFIX)
}

export const DEFAULT_ROUTE_GUARD: RouteGuard = { refire: 'once', markers: true }

export * from './prompt-catalog.js'
export * from './route-catalog.js'
export * from './route-validation.js'

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
