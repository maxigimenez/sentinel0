import { createHash } from 'node:crypto'
import {
  DEFAULT_ROUTE_GUARD,
  SENTINEL0_LABEL,
  type RouteGuard,
  type RoutingRule,
  type StringSetMatch,
  type TriggerEvent,
} from '@sentinel0/common'

export function guardOf(rule: RoutingRule): RouteGuard {
  return { ...DEFAULT_ROUTE_GUARD, ...rule.guard }
}

/**
 * Route selection. Pure - no I/O, no clock, no config reads - so the whole
 * "which agent gets started, and when" decision is exhaustively unit-testable.
 */

function normalize(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean)
}

/**
 * `any` = at least one present (OR), `all` = every one present (AND),
 * `none` = not one present (NOR). Omitted keys impose no constraint; an
 * explicitly empty array likewise imposes none, so a half-filled rule coming
 * out of the dashboard never silently matches everything or nothing.
 */
export function matchesSet(match: StringSetMatch | undefined, values: readonly string[]): boolean {
  if (!match) {
    return true
  }

  const present = new Set(normalize(values))

  if (match.any?.length && !normalize(match.any).some((value) => present.has(value))) {
    return false
  }
  if (match.all?.length && !normalize(match.all).every((value) => present.has(value))) {
    return false
  }
  if (match.none?.length && normalize(match.none).some((value) => present.has(value))) {
    return false
  }

  return true
}

/**
 * An unparseable pattern is a configuration error, not a reason to crash the
 * poll loop or - worse - to match everything. It fails closed.
 */
function matchesPattern(pattern: string | undefined, value: string): boolean {
  if (!pattern) {
    return true
  }
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

export function matchesRule(rule: RoutingRule, event: TriggerEvent): boolean {
  if (!rule.enabled) {
    return false
  }

  // Never start a second agent on something a run is already working on. This
  // is unconditional: an agent acting on an item changes it, and without this
  // the change would re-trigger the very route that started the work.
  const present = new Set(normalize(event.labels))
  if (present.has(SENTINEL0_LABEL.IN_PROGRESS)) {
    return false
  }

  // A route that fires once per item also declines anything it already
  // finished. Removing the marker by hand is how a human re-arms it.
  const guard = guardOf(rule)
  if (guard.refire === 'once' && guard.markers) {
    if (present.has(SENTINEL0_LABEL.DONE) || present.has(SENTINEL0_LABEL.FAILED)) {
      return false
    }
  }
  if (rule.trigger.type !== event.type) {
    return false
  }
  if (rule.trigger.projectId !== event.projectId) {
    return false
  }
  if (rule.trigger.provider && rule.trigger.provider !== event.provider) {
    return false
  }

  if (!matchesSet(rule.match.labels, event.labels)) {
    return false
  }
  if (!matchesSet(rule.match.state, event.state ? [event.state] : [])) {
    return false
  }
  if (!matchesSet(rule.match.assignees, event.assignees ?? [])) {
    return false
  }
  if (!matchesSet(rule.match.reviewers, event.requestedReviewers ?? [])) {
    return false
  }
  if (!matchesSet(rule.match.baseBranch, event.baseBranch ? [event.baseBranch] : [])) {
    return false
  }
  if (rule.match.isDraft !== undefined && rule.match.isDraft !== (event.isDraft ?? false)) {
    return false
  }

  // Transition clauses need history. On first sight there is none, so a route
  // keyed on "label added" stays quiet rather than firing across a backlog of
  // items that happen to already carry the label.
  const wantsTransition =
    rule.match.labelsAdded !== undefined ||
    rule.match.labelsRemoved !== undefined ||
    rule.match.assigneesAdded !== undefined ||
    rule.match.reviewersAdded !== undefined

  if (wantsTransition) {
    if (!event.changes) {
      return false
    }
    if (!matchesSet(rule.match.labelsAdded, event.changes.labelsAdded)) {
      return false
    }
    if (!matchesSet(rule.match.labelsRemoved, event.changes.labelsRemoved)) {
      return false
    }
    if (!matchesSet(rule.match.assigneesAdded, event.changes.assigneesAdded)) {
      return false
    }
    if (!matchesSet(rule.match.reviewersAdded, event.changes.reviewersAdded)) {
      return false
    }
  }
  if (!matchesPattern(rule.match.titleMatches, event.title)) {
    return false
  }
  if (!matchesPattern(rule.match.bodyMatches, event.body)) {
    return false
  }

  // A rule targeting an agent by GitHub identity only fires when that identity
  // was actually named on the item - this is what makes "hand this to the
  // review bot" address one specific agent rather than all of them.
  //
  // Named means assigned *or* requested as a reviewer. Checking reviewers alone,
  // as this once did, made a whole shape of route silently impossible: the API
  // accepts a pr_event route matching `assigneesAdded` and targeting a login,
  // and it could never fire, because assigning someone does not request their
  // review. A dead route that reports no error is worse than a rejected one.
  const githubLogin = rule.target.agentRef.githubLogin
  if (githubLogin) {
    const named = new Set([
      ...normalize(event.requestedReviewers ?? []),
      ...normalize(event.assignees ?? []),
    ])
    if (!named.has(githubLogin.trim().toLowerCase())) {
      return false
    }
  }

  return true
}

/**
 * Highest priority wins; ties break on id so the choice is stable across
 * restarts and across however Postgres happened to order the rows.
 */
export function evaluate(rules: readonly RoutingRule[], event: TriggerEvent): RoutingRule | null {
  const matching = rules.filter((rule) => matchesRule(rule, event))
  if (matching.length === 0) {
    return null
  }

  matching.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  return matching[0]
}

/**
 * Identity of "this rule, for this thing".
 *
 * Under `per-change` the revision is part of the key, so an unchanged item is a
 * no-op every cycle while a genuine edit triggers fresh work.
 *
 * Under `once` the revision is deliberately excluded, so a route fires for an
 * item exactly one time however much it changes afterwards. That is the
 * structural half of the loop guard: even where marker labels cannot be
 * written -- a tracker that rejects the label, a permissions problem -- a route
 * still cannot retrigger itself off the work it caused.
 */
export function dedupeKey(rule: RoutingRule, event: TriggerEvent): string {
  const parts =
    guardOf(rule).refire === 'once'
      ? [rule.id, event.type, event.ref]
      : [rule.id, event.type, event.ref, event.revision]

  return createHash('sha1').update(parts.join(' ')).digest('hex')
}
