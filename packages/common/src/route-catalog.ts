import type { RoutingRule } from './index.js'

/**
 * Ready-made routes covering the cases Sentinel0 actually supports.
 *
 * The dashboard renders these as starting points, so each one is a complete,
 * valid route rather than a fragment — a template a user picks and then has to
 * debug is worse than an empty form. Every entry is checked against the same
 * validator the API uses, and against the prompt renderer, so a template can
 * never ship with a placeholder nothing can fill.
 *
 * `placeholders` names the values a user must supply. They appear in the route
 * as `<ANGLE_BRACKETED>` tokens, deliberately unlike the `{{curly}}` prompt
 * variables Sentinel0 fills in at dispatch: one is answered at creation time by
 * a human, the other at run time by the runner.
 */
export interface RouteTemplatePlaceholder {
  token: string
  label: string
  hint: string
}

export interface RouteTemplate {
  id: string
  name: string
  /** One line, for a card in a picker. */
  summary: string
  /** Why you would choose this, and what it will and will not do. */
  description: string
  placeholders: RouteTemplatePlaceholder[]
  route: Omit<RoutingRule, 'id'>
}

const PROJECT: RouteTemplatePlaceholder = {
  token: '<PROJECT_ID>',
  label: 'Project',
  hint: 'The project id you registered with POST /v1/projects.',
}

const PROFILE: RouteTemplatePlaceholder = {
  token: '<AGENT_PROFILE>',
  label: 'Agent',
  hint: 'A Hermes profile name, as shown by "sentinel0 agents".',
}

const GITHUB_LOGIN: RouteTemplatePlaceholder = {
  token: '<AGENT_GITHUB_LOGIN>',
  label: "Agent's GitHub account",
  hint: 'The GitHub username this agent reviews as. Set it on the profile during "sentinel0 init".',
}

export const ROUTE_CATALOG: RouteTemplate[] = [
  // ── Tickets ───────────────────────────────────────────────
  {
    id: 'ticket-label-analysis',
    name: 'Assess a ticket when it gets a label',
    summary: 'Label a ticket, an agent assesses it and comments back.',
    description:
      'Fires once per ticket when the label is present. The agent writes no code — it ' +
      'reads the ticket and replies on it. The safest route to start with, because ' +
      'nothing it does touches a repository.',
    placeholders: [
      PROJECT,
      PROFILE,
      { token: '<LABEL>', label: 'Label', hint: 'e.g. feasibility' },
    ],
    route: {
      name: 'Assess on label',
      priority: 100,
      enabled: true,
      guard: { refire: 'once', markers: true },
      trigger: { type: 'ticket', projectId: '<PROJECT_ID>' },
      match: { labels: { any: ['<LABEL>'] } },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: {
        prompt: [
          'Assess this ticket for product sense and feasibility. Do not write code.',
          '',
          'Ticket: {{ticket.ref}}',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          'Labels: {{ticket.labels}}',
          '',
          'Description:',
          '{{ticket.body}}',
          '',
          'Cover what is actually being asked for, whether it is worth doing, rough',
          'feasibility, and anything underspecified that must be decided first.',
          'Be direct. If this is a bad idea, say so and say why.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 1800,
      },
      outcome: {
        postComment: { target: 'ticket' },
        labels: { add: ['reviewed'], remove: ['<LABEL>'] },
      },
    },
  },
  {
    id: 'ticket-label-added-triage',
    name: 'Triage a ticket the moment a label is added',
    summary: 'Fires on the act of labelling, not on tickets that already carry it.',
    description:
      'Uses transition matching, so creating this route does not fire it across every ' +
      'ticket already carrying the label. It stays quiet until someone adds the label ' +
      'while the runner is up.',
    placeholders: [
      PROJECT,
      PROFILE,
      { token: '<LABEL>', label: 'Label', hint: 'e.g. needs-triage' },
    ],
    route: {
      name: 'Triage on label added',
      priority: 90,
      enabled: true,
      guard: { refire: 'once', markers: true },
      trigger: { type: 'ticket', projectId: '<PROJECT_ID>' },
      match: { labelsAdded: { any: ['<LABEL>'] } },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: {
        prompt: [
          'Triage this ticket. Do not write code.',
          '',
          'Ticket: {{ticket.ref}}',
          'Title: {{ticket.title}}',
          'State: {{ticket.state}}',
          '',
          'Description:',
          '{{ticket.body}}',
          '',
          'Say what kind of work this is, how urgent it looks, and what information is',
          'missing before anyone could start on it.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 900,
      },
      outcome: { postComment: { target: 'ticket' } },
    },
  },
  {
    id: 'ticket-implementation',
    name: 'Implement a ticket',
    summary: 'The agent writes the code and opens its own pull request.',
    description:
      'The agent owns the whole change — branch, edits, checks, commit, push, pull ' +
      'request — under its own GitHub identity. Its Hermes profile needs a working ' +
      'directory and git credentials for the repository. Fires once per ticket.',
    placeholders: [
      PROJECT,
      PROFILE,
      { token: '<LABEL>', label: 'Label', hint: 'e.g. ready-for-agent' },
    ],
    route: {
      name: 'Implement on label',
      priority: 80,
      enabled: true,
      guard: { refire: 'once', markers: true },
      trigger: { type: 'ticket', projectId: '<PROJECT_ID>' },
      match: { labels: { any: ['<LABEL>'] } },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: {
        prompt: [
          'Implement this ticket end to end.',
          '',
          'Ticket: {{ticket.ref}}',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          '',
          'Description:',
          '{{ticket.body}}',
          '',
          'You own the whole change: create your own branch, make the edits, run the',
          'checks, commit, push, and open the pull request under your own identity.',
          'Keep the change scoped to what the ticket asks for. If you cannot proceed,',
          'stop and explain why rather than guessing.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 3600,
      },
      outcome: {
        postComment: { target: 'ticket' },
        labels: { add: ['in-review'], remove: ['<LABEL>'] },
      },
    },
  },

  // ── Pull requests ─────────────────────────────────────────
  {
    id: 'pr-review-cycle',
    name: 'Review a pull request, every time you are asked',
    summary: 'Request review from the agent; re-request it for another round.',
    description:
      'Matches the act of requesting review, so each request starts one round and ' +
      'nothing else does. Push commits or reply in the thread and it stays quiet; ' +
      're-request review and it comes back, reads what you said, and reviews again. ' +
      'The agent fetches the diff and the conversation itself with gh.',
    placeholders: [PROJECT, GITHUB_LOGIN],
    route: {
      name: 'Reviewer agent',
      priority: 100,
      enabled: true,
      // per-change is required for repeat rounds, and is safe here because
      // nothing the agent does adds a reviewer.
      guard: { refire: 'per-change', markers: true },
      trigger: { type: 'pr_review_requested', provider: 'github', projectId: '<PROJECT_ID>' },
      // Transition, deliberately. `match.reviewers` would also fire here and
      // would additionally catch a request made while the runner was down --
      // but a pull request's revision includes its updatedAt, so under
      // per-change refiring every push would start another review round. Being
      // asked is the signal; still being an outstanding reviewer is not.
      match: { reviewersAdded: { any: ['<AGENT_GITHUB_LOGIN>'] } },
      target: { agentRef: { githubLogin: '<AGENT_GITHUB_LOGIN>' } },
      execution: {
        prompt: [
          'You have been requested as a reviewer on {{ticket.ref}}.',
          '',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          '',
          'Read it yourself:',
          '  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews',
          '  gh pr diff {{pr.number}} --repo {{repo.slug}}',
          '',
          'If you have reviewed this pull request before, your earlier comments are in',
          'that thread. Read the author’s replies and pick up from there rather than',
          'repeating findings that have already been addressed or answered.',
          '',
          'Correctness first, then clarity. Prefer a few substantive findings over',
          'exhaustive nitpicking, and say plainly when it looks good.',
          '',
          'Leave your review with `gh pr review`, as an approval or a request for',
          'changes rather than a bare comment.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 1800,
      },
      outcome: {},
    },
  },
  {
    id: 'pr-assigned',
    name: 'Act on a pull request assigned to an agent',
    summary: 'Assign a PR to the agent and it picks the work up.',
    description:
      'Fires when the agent is newly assigned, and skips drafts. Use this when you ' +
      'want assignment rather than review request to be the signal.',
    placeholders: [PROJECT, GITHUB_LOGIN],
    route: {
      name: 'Work assigned pull requests',
      priority: 90,
      enabled: true,
      guard: { refire: 'per-change', markers: true },
      trigger: { type: 'pr_event', provider: 'github', projectId: '<PROJECT_ID>' },
      // Assignment is the signal, and the login now targets the agent directly:
      // until this release the gate behind `agentRef.githubLogin` consulted
      // only requested reviewers, so this route could be saved and could never
      // fire. See the note in rule-engine's matchesRule.
      match: { assigneesAdded: { any: ['<AGENT_GITHUB_LOGIN>'] }, isDraft: false },
      target: { agentRef: { githubLogin: '<AGENT_GITHUB_LOGIN>' } },
      execution: {
        prompt: [
          'You have been assigned {{ticket.ref}}.',
          '',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          '',
          'Read it yourself:',
          '  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews',
          '  gh pr diff {{pr.number}} --repo {{repo.slug}}',
          '',
          'Then do what the pull request asks of you and report what you did.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 1800,
      },
      outcome: {},
    },
  },
  {
    id: 'pr-label-added',
    name: 'Act on a pull request when a label is added',
    summary: 'Label a PR to hand it to an agent.',
    description:
      'Fires on the label being added, not while it is present, so it will not sweep ' +
      'through pull requests that already carry it. Pair it with an outcome that ' +
      'removes the label if you want the label itself to act as a queue.',
    placeholders: [
      PROJECT,
      PROFILE,
      { token: '<LABEL>', label: 'Label', hint: 'e.g. agent-review' },
    ],
    route: {
      name: 'Act on labelled pull requests',
      priority: 80,
      enabled: true,
      guard: { refire: 'per-change', markers: true },
      trigger: { type: 'pr_event', provider: 'github', projectId: '<PROJECT_ID>' },
      match: { labelsAdded: { any: ['<LABEL>'] }, isDraft: false },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: {
        prompt: [
          '{{ticket.ref}} was labelled {{changes.labelsAdded}}.',
          '',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          '',
          'Read it yourself:',
          '  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews',
          '  gh pr diff {{pr.number}} --repo {{repo.slug}}',
          '',
          'Then act on what that label means in this repository.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 1800,
      },
      outcome: { labels: { remove: ['<LABEL>'] } },
    },
  },
  {
    id: 'pr-unblocked',
    name: 'Pick a pull request back up when it is unblocked',
    summary: 'Removing a blocking label hands it back to an agent.',
    description:
      'Fires on a label being removed. Useful as the other half of a human gate: ' +
      'label to pause, unlabel to resume.',
    placeholders: [
      PROJECT,
      PROFILE,
      { token: '<LABEL>', label: 'Blocking label', hint: 'e.g. blocked' },
    ],
    route: {
      name: 'Resume when unblocked',
      priority: 70,
      enabled: true,
      guard: { refire: 'per-change', markers: true },
      trigger: { type: 'pr_event', provider: 'github', projectId: '<PROJECT_ID>' },
      match: { labelsRemoved: { any: ['<LABEL>'] } },
      target: { agentRef: { profile: '<AGENT_PROFILE>' } },
      execution: {
        prompt: [
          '{{ticket.ref}} is no longer blocked.',
          '',
          'Title: {{ticket.title}}',
          'Link: {{ticket.url}}',
          '',
          'Read the current state and the discussion:',
          '  gh pr view {{pr.number}} --repo {{repo.slug}} --json title,body,comments,reviews',
          '  gh pr diff {{pr.number}} --repo {{repo.slug}}',
          '',
          'Then continue the work from wherever it was left.',
        ].join('\n'),
        requireApproval: false,
        timeoutSeconds: 1800,
      },
      outcome: {},
    },
  },
]

export function findRouteTemplate(id: string): RouteTemplate | undefined {
  return ROUTE_CATALOG.find((template) => template.id === id)
}

/** Substitutes `<PLACEHOLDER>` tokens, leaving `{{prompt.variables}}` alone. */
export function fillRouteTemplate(
  template: RouteTemplate,
  values: Record<string, string>
): Omit<RoutingRule, 'id'> {
  const serialized = JSON.stringify(template.route)
  const filled = serialized.replace(/<[A-Z_]+>/g, (token) => {
    const value = values[token]
    if (value === undefined) {
      return token
    }
    // Substitution happens inside a JSON string literal, so the value is
    // escaped the way JSON would escape it, minus the quotes the literal
    // already carries. A value containing a quote or a backslash -- a prompt
    // with a quoted phrase, a Windows-style path -- would otherwise produce a
    // document that no longer parses.
    return JSON.stringify(value).slice(1, -1)
  })
  return JSON.parse(filled) as Omit<RoutingRule, 'id'>
}
