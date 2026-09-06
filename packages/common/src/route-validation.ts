import { TRIGGER_TYPE, type RoutingRule, type TriggerType } from './index.js'

/**
 * The one definition of a valid route.
 *
 * Shared rather than living in the cloud package so the API, the route catalog
 * and its tests all agree on what is acceptable. A starter template that the
 * API would reject is worse than no template at all.
 */

/**
 * Read inside the function, not at module scope.
 *
 * This module is re-exported from `index`, which is also where TRIGGER_TYPE
 * lives, so touching it while this module evaluates hits the temporal dead
 * zone and throws at import time. Deferring to call time breaks the cycle.
 */
function triggerTypes(): TriggerType[] {
  return Object.values(TRIGGER_TYPE) as TriggerType[]
}

export function validateRoutingRule(route: RoutingRule): string | undefined {
  if (!route || typeof route !== 'object') {
    return 'A route object is required.'
  }
  if (!route.name) {
    return 'name is required.'
  }

  if (!route.trigger?.type) {
    return 'trigger.type is required.'
  }
  const types = triggerTypes()
  if (!types.includes(route.trigger.type)) {
    return `trigger.type must be one of: ${types.join(', ')}.`
  }
  if (!route.trigger.projectId) {
    return 'trigger.projectId is required.'
  }

  if (!route.target?.agentRef) {
    return 'target.agentRef is required.'
  }
  if (!route.target.agentRef.profile && !route.target.agentRef.githubLogin) {
    return 'target.agentRef needs either a profile or a githubLogin.'
  }

  if (!route.execution?.prompt?.trim()) {
    return 'execution.prompt is required.'
  }
  if (typeof route.execution.timeoutSeconds !== 'number') {
    return 'execution.timeoutSeconds must be a number.'
  }
  if (route.execution.timeoutSeconds < 1) {
    return 'execution.timeoutSeconds must be positive.'
  }
  if (route.execution.approvalTimeoutSeconds !== undefined) {
    if (typeof route.execution.approvalTimeoutSeconds !== 'number') {
      return 'execution.approvalTimeoutSeconds must be a number.'
    }
    if (route.execution.approvalTimeoutSeconds < 1) {
      return 'execution.approvalTimeoutSeconds must be positive.'
    }
  }

  if (route.guard) {
    if (route.guard.refire !== 'once' && route.guard.refire !== 'per-change') {
      return 'guard.refire must be "once" or "per-change".'
    }
    if (route.guard.markers !== undefined && typeof route.guard.markers !== 'boolean') {
      return 'guard.markers must be a boolean.'
    }
    // The one combination that can loop: the route re-fires on every change,
    // and an agent working on the item is a change.
    if (route.guard.refire === 'per-change' && route.guard.markers === false) {
      return 'guard.refire "per-change" requires guard.markers, or the route can retrigger itself.'
    }
  }

  // Matching an agent by GitHub identity only means anything where GitHub tells
  // us who was asked -- otherwise the route would silently never fire.
  if (route.target.agentRef.githubLogin) {
    const supported: TriggerType[] = [TRIGGER_TYPE.PR_REVIEW_REQUESTED, TRIGGER_TYPE.PR_EVENT]
    if (!supported.includes(route.trigger.type)) {
      return `target.agentRef.githubLogin only applies to ${supported.join(' or ')} triggers.`
    }
  }

  const prOnly = route.match?.isDraft !== undefined || route.match?.baseBranch !== undefined
  if (prOnly && route.trigger.type === TRIGGER_TYPE.TICKET) {
    return 'match.isDraft and match.baseBranch only apply to pull request triggers.'
  }

  return undefined
}
