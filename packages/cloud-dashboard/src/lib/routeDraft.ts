import type { RouteTemplate, RoutingRule } from '../api/types.js'
import type { RouteDraft } from '../components/RouteForm.js'
import { fillRouteTemplate } from './routeTemplate.js'

/** The fields the form owns. Everything else on a rule is preserved as-is. */
const EDITED_KEYS = ['name', 'priority', 'enabled', 'trigger', 'target', 'execution'] as const

export const EMPTY_DRAFT: RouteDraft = {
  name: '',
  projectId: '',
  agentProfile: '',
  agentGithubLogin: '',
  priority: '100',
  enabled: true,
  timeoutSeconds: '1800',
  prompt: '',
  extras: {},
}

/** The values a template's placeholders should be filled with, from a draft. */
export function placeholderValues(draft: RouteDraft): Record<string, string> {
  return {
    ...draft.extras,
    '<PROJECT_ID>': draft.projectId,
    '<AGENT_PROFILE>': draft.agentProfile,
    '<AGENT_GITHUB_LOGIN>': draft.agentGithubLogin,
  }
}

/** An existing rule, as the form's fields. */
export function toDraft(route: RoutingRule): RouteDraft {
  return {
    name: route.name ?? '',
    projectId: route.trigger?.projectId ?? '',
    agentProfile: route.target?.agentRef?.profile ?? '',
    agentGithubLogin: route.target?.agentRef?.githubLogin ?? '',
    priority: String(route.priority ?? 100),
    enabled: route.enabled !== false,
    timeoutSeconds: String(route.execution?.timeoutSeconds ?? 1800),
    prompt: route.execution?.prompt ?? '',
    extras: route.target?.agentRef?.linearUserId
      ? {
          '<LINEAR_USER_ID>': route.target.agentRef.linearUserId,
          '<LINEAR_WORKSPACE_ID>': route.target.agentRef.linearWorkspaceId ?? '',
        }
      : {},
  }
}

/**
 * Writes a draft back onto a rule.
 *
 * `base` supplies everything the form does not edit — the match clauses, the
 * guard, the outcome — so editing a name can never quietly drop the thing that
 * stops a route re-firing on its own work.
 *
 * The target keeps only the key it already had. A rule addresses an agent by
 * profile, GitHub login, or a scoped Linear identity. Editing preserves that
 * choice so it cannot silently change which agent receives the work.
 */
export function applyDraft(base: Partial<RoutingRule>, draft: RouteDraft): Omit<RoutingRule, 'id'> {
  const byLogin = Boolean(base.target?.agentRef?.githubLogin)
  const byLinear = Boolean(base.target?.agentRef?.linearUserId)
  const priority = Number.parseInt(draft.priority, 10)
  const timeout = Number.parseInt(draft.timeoutSeconds, 10)

  return {
    ...base,
    name: draft.name.trim(),
    priority: Number.isFinite(priority) ? priority : 100,
    enabled: draft.enabled,
    trigger: {
      ...base.trigger,
      type: base.trigger?.type ?? 'ticket',
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
    },
    target: {
      ...base.target,
      agentRef: byLinear
        ? {
            linearUserId: draft.extras['<LINEAR_USER_ID>'],
            linearWorkspaceId: draft.extras['<LINEAR_WORKSPACE_ID>'],
          }
        : byLogin
          ? { githubLogin: draft.agentGithubLogin }
          : { profile: draft.agentProfile },
    },
    execution: {
      ...base.execution,
      prompt: draft.prompt,
      timeoutSeconds: Number.isFinite(timeout) ? timeout : 1800,
    },
  } as Omit<RoutingRule, 'id'>
}

/** The rule a filled-in template becomes, ready to POST. */
export function draftToNewRoute(
  template: RouteTemplate,
  draft: RouteDraft
): Omit<RoutingRule, 'id'> {
  return applyDraft(fillRouteTemplate(template, placeholderValues(draft)), draft)
}

/** The parts of a rule the form leaves alone, for the read-only panel. */
export function preservedParts(route: Partial<RoutingRule>): Partial<RoutingRule> {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(route)) {
    if (!(EDITED_KEYS as readonly string[]).includes(key) && key !== 'id') {
      rest[key] = value
    }
  }
  // The trigger and the match together are what "when does this fire" means, so
  // the trigger is shown even though the form edits one field of it.
  return { trigger: route.trigger, ...rest } as Partial<RoutingRule>
}

/**
 * Which fields are missing, in the order a person reads the form.
 *
 * Returned as messages rather than a boolean so the form can say what to fix
 * instead of disabling a button with no explanation.
 */
export function draftProblems(draft: RouteDraft, extraTokens: string[]): string[] {
  const problems: string[] = []
  if (!draft.name.trim()) {
    problems.push('Give the route a name you will recognise in the run list.')
  }
  if (!draft.projectId) {
    problems.push('Pick the project this route watches.')
  }
  if (extraTokens.includes('<AGENT_GITHUB_LOGIN>')) {
    if (!draft.agentGithubLogin.trim()) {
      problems.push('This route matches on a GitHub identity, so it needs one.')
    }
  } else if (!extraTokens.includes('<LINEAR_USER_ID>') && !draft.agentProfile) {
    problems.push('Pick the agent this route starts.')
  }
  for (const token of extraTokens) {
    if (
      token === '<PROJECT_ID>' ||
      token === '<AGENT_PROFILE>' ||
      token === '<AGENT_GITHUB_LOGIN>'
    ) {
      continue
    }
    if (!draft.extras[token]?.trim()) {
      problems.push(`Fill in ${token}.`)
    }
  }
  if (!draft.prompt.trim()) {
    problems.push('The agent needs a prompt.')
  }
  return problems
}
