/**
 * The shapes `packages/cloud-api` actually returns.
 *
 * Declared here rather than imported from `@sentinel0/common` on purpose: those
 * are the runner's internal types, and several fields the API returns are
 * snake_case Postgres columns that never appear in them. Coupling the browser
 * bundle to the orchestrator's type spine would also drag Node-only
 * declarations into a DOM build.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'canceled'

export interface Me {
  org: { id: string; name: string; createdAt: string | null }
  key: { id: string; name: string | null; prefix: string | null; scope: string }
}

export interface Runner {
  id: string
  name: string
  hostname: string | null
  version: string | null
  last_seen_at: string | null
  /** When the runner process started, so uptime is its age, not the row's. */
  started_at: string | null
  /** Null until a runner new enough to send a heartbeat has sent one. */
  hermes_ok: boolean | null
  hermes_detail: string | null
  active_runs: number | null
  last_error: string | null
  /** Routing decisions that produced no run, newest last. */
  recent_skips: SkipReport[] | null
  stale: boolean
}

/** Why a trigger produced no run. */
export interface SkipReport {
  reason: string
  ref: string
  routeId?: string
  at: number
}

export interface Agent {
  id: string
  profile: string
  display_name: string | null
  role: string | null
  model: string | null
  provider: string | null
  toolsets: string[] | null
  skills: string[] | null
  github_login: string | null
  avatar_url: string | null
  enabled: boolean
  synced_at: string | null
  runner: string
  /**
   * What the agent is doing, as its runner last reported.
   *
   * Null on an agent whose runner has not heartbeated since it was registered.
   * Distinct from `enabled`, which is configuration: an enabled agent can be
   * idle, busy, or waiting on a person.
   */
  status: 'idle' | 'busy' | 'awaiting_approval' | null
  current_run_id: string | null
  status_at: string | null
  runner_stale: boolean
}

export interface Project {
  id: string
  provider: 'github' | 'linear'
  filters: Record<string, unknown>
}

/** What an agent is waiting to be allowed to do. Every field is a hint. */
export interface ApprovalDetail {
  tool?: string
  command?: string
  arguments?: string
  requestedAt?: number
}

export interface Run {
  id: string
  route_name: string | null
  agent_profile: string | null
  project_id: string | null
  trigger_ref: string | null
  trigger_revision?: string | null
  trigger_url: string | null
  title: string | null
  status: RunStatus
  summary: string | null
  error: string | null
  /** Present on the detail endpoint, which selects the whole row. */
  hermes_run_id?: string | null
  hermes_session_id?: string | null
  approval_detail?: ApprovalDetail | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    costUsd?: number
  } | null
  started_at: string | null
  ended_at: string | null
  updated_at: string | null
}

export interface RunEvent {
  title: string | null
  message: string | null
  icon: string | null
  level: string | null
  kind: string | null
  source: string | null
  group_id: string | null
  /**
   * Epoch milliseconds — but typed to accept a string.
   *
   * The column is a bigint, and node-postgres returns bigints as strings
   * rather than risk a silent precision loss above 2^53. `new Date()` on that
   * string yields Invalid Date, so every consumer must coerce it first.
   */
  ts: number | string
}

export interface ApiKey {
  id: string
  name: string
  scope: 'runner' | 'user'
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface SlackIntegration {
  configured: boolean
  enabled?: boolean
  events?: string[]
  created_at?: string
}

/** A routing rule as the API stores it. Kept loose: routes are user data. */
export interface RoutingRule {
  id: string
  name: string
  priority: number
  enabled: boolean
  trigger: { type: string; provider?: string; projectId?: string }
  match?: Record<string, unknown>
  target: { agentRef?: { profile?: string; githubLogin?: string } }
  execution: { prompt: string; requireApproval?: boolean; timeoutSeconds?: number }
  outcome?: Record<string, unknown>
  guard?: { refire?: string; markers?: boolean }
}

export interface RouteTemplatePlaceholder {
  token: string
  label: string
  hint: string
}

export interface RouteTemplate {
  id: string
  name: string
  summary: string
  description: string
  placeholders: RouteTemplatePlaceholder[]
  route: Omit<RoutingRule, 'id'>
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  prompt: string
}
