import type { RunStatus } from '../api/types.js'

/** The tone each run status carries, used for badges, dots and meters alike. */
export const STATUS_TONE: Record<
  RunStatus,
  'primary' | 'amber' | 'success' | 'danger' | 'neutral'
> = {
  queued: 'amber',
  running: 'primary',
  awaiting_approval: 'amber',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
}

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'canceled']

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * How long a run took, or has been going.
 *
 * A running row has no `ended_at`, so it is measured against now; that is what
 * makes the number tick upward while you watch it.
 */
export function duration(
  startedAt: string | null,
  endedAt: string | null,
  now = Date.now()
): string {
  if (!startedAt) {
    return '—'
  }
  const start = Date.parse(startedAt)
  const end = endedAt ? Date.parse(endedAt) : now
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return '—'
  }
  return formatSeconds(Math.max(0, Math.round((end - start) / 1000)))
}

export function formatSeconds(total: number): string {
  if (total < 60) {
    return `${total}s`
  }
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** "4m ago", for last-seen and last-updated columns. */
export function relativeTime(value: string | null, now = Date.now()): string {
  if (!value) {
    return 'never'
  }
  const then = Date.parse(value)
  if (Number.isNaN(then)) {
    return '—'
  }
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 5) {
    return 'just now'
  }
  if (seconds < 0) {
    // Clock skew between the browser and the server. Better than "-3s ago".
    return 'just now'
  }
  return `${formatSeconds(seconds)} ago`
}

/** Initials for an avatar, from a profile name like "product" or "pr-reviewer". */
export function initials(name: string): string {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean)
  if (parts.length === 0) {
    return '—'
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * Epoch milliseconds from a value that may arrive as a string.
 *
 * Postgres bigints come back from node-postgres as strings, and passing one
 * straight to `new Date()` produces Invalid Date rather than throwing — so
 * every timestamp would silently render as a dash.
 */
export function epochMillis(value: number | string | null): number | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  const millis = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(millis) ? millis : undefined
}

/**
 * How long a runner has been up.
 *
 * Coarser than `duration`: nobody reads a daemon's uptime to the second, and a
 * value that changes every second reads as noise rather than information.
 */
export function uptime(startedAt: string, now = Date.now()): string {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) {
    return '—'
  }
  const seconds = Math.max(0, Math.round((now - start) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  }
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
}

/**
 * Shortens a value for a place that has no room to grow.
 *
 * Used where CSS truncation cannot reach -- a dialog's `meta` line, a toast --
 * rather than in table cells, which clip themselves.
 */
export function truncate(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat
}

/** The recognisable tail of an id, for captions and secondary lines. */
export function shortId(id: string): string {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
  return body.length > 10 ? `${body.slice(0, 10)}\u2026` : body
}
