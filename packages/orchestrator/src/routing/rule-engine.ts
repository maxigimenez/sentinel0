import { createHash } from 'node:crypto'
import {
  DEFAULT_ROUTE_GUARD,
  SENTINEL0_LABEL,
  type AgentDescriptor,
  type RouteGuard,
  type RouteTarget,
  type RoutingRule,
  type StringSetMatch,
  type TriggerEvent,
} from '@sentinel0/common'

/**
 * The agent a route addresses, or undefined when nothing answers to it.
 *
 * Pure, and shared with the dispatcher rather than duplicated, so that a
 * diagnostic asking "could this route ever run" gets the same answer the
 * dispatcher would give. Matching and targeting fail independently: a route can
 * match perfectly and still address a profile that does not exist, which is
 * invisible until the day it finally matches.
 */
export function resolveAgent(
  agents: readonly AgentDescriptor[],
  target: RouteTarget
): AgentDescriptor | undefined {
  const { profile, githubLogin } = target.agentRef
  return agents.find((agent) => {
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
 * Why a route's target does not resolve, or undefined when it does.
 *
 * Separates "no agent has that identity" from "the agent is switched off",
 * because the fix is different and the symptom is identical.
 */
export function explainTarget(
  agents: readonly AgentDescriptor[],
  target: RouteTarget
): string | undefined {
  if (resolveAgent(agents, target)) {
    return undefined
  }

  const { profile, githubLogin } = target.agentRef
  if (!profile && !githubLogin) {
    return 'target.agentRef names neither a profile nor a githubLogin'
  }

  if (profile) {
    const disabled = agents.some((agent) => agent.profile === profile)
    return disabled ? `profile "${profile}" is disabled` : `no agent has the profile "${profile}"`
  }

  // The case that cost a day: the profile exists and works, but nobody told
  // Sentinel0 which GitHub account it acts as, so a route addressing it by
  // identity can never find it.
  const wanted = githubLogin!.toLowerCase()
  const disabled = agents.some((agent) => agent.githubLogin?.toLowerCase() === wanted)
  if (disabled) {
    return `the agent with githubLogin "${githubLogin}" is disabled`
  }
  const anonymous = agents.filter((agent) => !agent.githubLogin).map((agent) => agent.profile)
  const hint = anonymous.length
    ? ` (${anonymous.join(', ')} ${anonymous.length === 1 ? 'has' : 'have'} no githubLogin set — see hermes.profiles[].githubLogin in ~/.sentinel0/config.json)`
    : ''
  return `no enabled agent has githubLogin "${githubLogin}"${hint}`
}

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

/**
 * Why a rule did not select an event, in the operator's own vocabulary, or
 * undefined when it did.
 *
 * `matchesRule` is defined in terms of this rather than beside it. A route that
 * silently does nothing is the hardest failure this system has: the log says
 * `no-route`, which is equally consistent with a typo'd login, a transition
 * that was never recorded, and a route that is simply switched off. Two
 * implementations -- one deciding, one explaining -- would eventually disagree,
 * and the explanation is only worth having if it is the decision.
 */
export function explainRule(rule: RoutingRule, event: TriggerEvent): string | undefined {
  if (!rule.enabled) {
    return 'the route is disabled'
  }

  // Never start a second agent on something a run is already working on. This
  // is unconditional: an agent acting on an item changes it, and without this
  // the change would re-trigger the very route that started the work.
  const present = new Set(normalize(event.labels))
  if (present.has(SENTINEL0_LABEL.IN_PROGRESS)) {
    return `${event.ref} carries ${SENTINEL0_LABEL.IN_PROGRESS}, so a run is already working on it`
  }

  // A route that fires once per item also declines anything it already
  // finished. Removing the marker by hand is how a human re-arms it.
  const guard = guardOf(rule)
  if (guard.refire === 'once' && guard.markers) {
    const marker = [SENTINEL0_LABEL.DONE, SENTINEL0_LABEL.FAILED].find((label) =>
      present.has(label)
    )
    if (marker) {
      return `${event.ref} carries ${marker} and guard.refire is "once"; remove the label to re-arm it`
    }
  }
  if (rule.trigger.type !== event.type) {
    return `trigger.type is ${rule.trigger.type}, the event is ${event.type}`
  }
  if (rule.trigger.projectId !== event.projectId) {
    return `trigger.projectId is "${rule.trigger.projectId}", the event is from "${event.projectId}"`
  }
  if (rule.trigger.provider && rule.trigger.provider !== event.provider) {
    return `trigger.provider is ${rule.trigger.provider}, the event came from ${event.provider}`
  }

  const state = [
    ['match.labels', rule.match.labels, event.labels],
    ['match.state', rule.match.state, event.state ? [event.state] : []],
    ['match.assignees', rule.match.assignees, event.assignees ?? []],
    ['match.reviewers', rule.match.reviewers, event.requestedReviewers ?? []],
    ['match.baseBranch', rule.match.baseBranch, event.baseBranch ? [event.baseBranch] : []],
  ] as const

  for (const [name, match, values] of state) {
    if (!matchesSet(match, values)) {
      return `${name} ${describeSet(match)}; the event has ${describeValues(values)}`
    }
  }

  if (rule.match.isDraft !== undefined && rule.match.isDraft !== (event.isDraft ?? false)) {
    return `match.isDraft is ${rule.match.isDraft}, the pull request is ${event.isDraft ?? false}`
  }

  // Transition clauses need history. On first sight there is none, so a route
  // keyed on "label added" stays quiet rather than firing across a backlog of
  // items that happen to already carry the label.
  const transitions = [
    ['match.labelsAdded', rule.match.labelsAdded, event.changes?.labelsAdded],
    ['match.labelsRemoved', rule.match.labelsRemoved, event.changes?.labelsRemoved],
    ['match.assigneesAdded', rule.match.assigneesAdded, event.changes?.assigneesAdded],
    ['match.reviewersAdded', rule.match.reviewersAdded, event.changes?.reviewersAdded],
  ] as const

  const wantsTransition = transitions.some(([, match]) => match !== undefined)
  if (wantsTransition) {
    if (!event.changes) {
      return `${event.ref} has never been observed before, and a transition clause needs a previous sighting to compare against; it will be evaluated from the next poll onward`
    }
    for (const [name, match, values] of transitions) {
      if (!matchesSet(match, values ?? [])) {
        return `${name} ${describeSet(match)}; nothing changed there this cycle (${describeValues(values ?? [])})`
      }
    }
  }
  if (!matchesPattern(rule.match.titleMatches, event.title)) {
    return `match.titleMatches /${rule.match.titleMatches}/ does not match "${event.title}"`
  }
  if (!matchesPattern(rule.match.bodyMatches, event.body)) {
    return `match.bodyMatches /${rule.match.bodyMatches}/ does not match the body`
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
    const named = [...(event.requestedReviewers ?? []), ...(event.assignees ?? [])]
    if (!new Set(normalize(named)).has(githubLogin.trim().toLowerCase())) {
      return `target.agentRef.githubLogin is "${githubLogin}", who is neither assigned to nor a requested reviewer on ${event.ref} (${describeValues(named)})`
    }
  }

  return undefined
}

function describeSet(match: StringSetMatch | undefined): string {
  const parts: string[] = []
  if (match?.any?.length) {
    parts.push(`wants any of [${match.any.join(', ')}]`)
  }
  if (match?.all?.length) {
    parts.push(`wants all of [${match.all.join(', ')}]`)
  }
  if (match?.none?.length) {
    parts.push(`excludes [${match.none.join(', ')}]`)
  }
  return parts.join(' and ') || 'imposes no constraint'
}

function describeValues(values: readonly string[]): string {
  return values.length > 0 ? `[${values.join(', ')}]` : 'nothing'
}

export function matchesRule(rule: RoutingRule, event: TriggerEvent): boolean {
  return explainRule(rule, event) === undefined
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
 *
 * `while-matched` excludes it for the same reason and re-arms differently: the
 * claim is released when the item stops matching, so the key must be the one a
 * later cycle would compute for the same item.
 */
export function dedupeKey(rule: RoutingRule, event: TriggerEvent): string {
  const parts = holdsClaimAcrossRevisions(rule)
    ? [rule.id, event.type, event.ref]
    : [rule.id, event.type, event.ref, event.revision]

  return createHash('sha1').update(parts.join(' ')).digest('hex')
}

/** Whether a route's dedupe key ignores the item's revision. */
export function holdsClaimAcrossRevisions(rule: RoutingRule): boolean {
  const refire = guardOf(rule).refire
  return refire === 'once' || refire === 'while-matched'
}
