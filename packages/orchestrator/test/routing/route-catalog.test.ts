import { describe, expect, it } from 'vitest'
import {
  SENTINEL0_LABEL,
  ROUTE_CATALOG,
  TICKET_PROVIDER,
  TRIGGER_TYPE,
  fillRouteTemplate,
  findRouteTemplate,
  validateRoutingRule,
  type RoutingRule,
  type TriggerEvent,
} from '@sentinel0/common'
import { renderPromptText } from '../../src/prompts/render.js'
import { dedupeKey, guardOf, matchesRule } from '../../src/routing/rule-engine.js'

/** The values a user would type into the dashboard. */
const ANSWERS: Record<string, string> = {
  '<PROJECT_ID>': 'taplands',
  '<AGENT_PROFILE>': 'reviewer',
  '<AGENT_GITHUB_LOGIN>': 'acme-reviewer',
  '<LABEL>': 'needs-agent',
}

function filled(templateId: string): RoutingRule {
  const template = findRouteTemplate(templateId)!
  return { ...fillRouteTemplate(template, ANSWERS), id: `rt_${templateId}` }
}

const event = (overrides: Partial<TriggerEvent> = {}): TriggerEvent => ({
  type: TRIGGER_TYPE.TICKET,
  projectId: 'taplands',
  provider: TICKET_PROVIDER.LINEAR,
  ref: 'LIN-1',
  revision: 'r',
  title: 'Billing export',
  body: 'Need CSV.',
  url: 'https://linear.app/x',
  labels: [],
  assignees: [],
  ...overrides,
})

describe('every catalog template', () => {
  it.each(ROUTE_CATALOG.map((template) => [template.id, template] as const))(
    '%s is a route the API would accept',
    (_id, template) => {
      const route = { ...fillRouteTemplate(template, ANSWERS), id: 'rt_x' }
      // The same validator the cloud runs, so a template can never ship in a
      // shape that would 400 the moment a user submits it.
      expect(validateRoutingRule(route)).toBeUndefined()
    }
  )

  it.each(ROUTE_CATALOG.map((template) => [template.id, template] as const))(
    '%s uses only prompt variables the renderer can fill',
    (_id, template) => {
      const context = {
        event: event({ prNumber: 7, ref: 'acme/www#7' }),
        route: { ...fillRouteTemplate(template, ANSWERS), id: 'rt_x' },
        agentProfile: 'reviewer',
      }
      expect(renderPromptText(template.route.execution.prompt, context).unknown).toEqual([])
    }
  )

  it.each(ROUTE_CATALOG.map((template) => [template.id, template] as const))(
    '%s declares every placeholder it actually uses',
    (_id, template) => {
      const used = new Set(JSON.stringify(template.route).match(/<[A-Z_]+>/g) ?? [])
      const declared = new Set(template.placeholders.map((entry) => entry.token))

      expect([...used].filter((token) => !declared.has(token))).toEqual([])
      expect([...declared].filter((token) => !used.has(token))).toEqual([])
    }
  )

  it('leaves no placeholder behind once filled', () => {
    for (const template of ROUTE_CATALOG) {
      const json = JSON.stringify(fillRouteTemplate(template, ANSWERS))
      expect(json.match(/<[A-Z_]+>/g)).toBeNull()
    }
  })

  it('has unique ids and a summary for a picker', () => {
    const ids = ROUTE_CATALOG.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const template of ROUTE_CATALOG) {
      expect(template.summary.length).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(template.summary.length)
    }
  })

  it('sets a guard explicitly rather than relying on a default', () => {
    // What a route will do should be visible in the template a user is reading.
    for (const template of ROUTE_CATALOG) {
      expect(template.route.guard).toBeDefined()
    }
  })
})

describe('the templates actually fire on what they describe', () => {
  it('ticket-label-analysis fires on a ticket carrying the label', () => {
    const route = filled('ticket-label-analysis')
    expect(matchesRule(route, event({ labels: ['needs-agent'] }))).toBe(true)
    expect(matchesRule(route, event({ labels: ['other'] }))).toBe(false)
  })

  it('ticket-label-added-triage waits for the label to be added', () => {
    const route = filled('ticket-label-added-triage')
    const present = event({ labels: ['needs-agent'] })

    expect(matchesRule(route, present)).toBe(false)
    expect(
      matchesRule(route, {
        ...present,
        changes: {
          labelsAdded: ['needs-agent'],
          labelsRemoved: [],
          assigneesAdded: [],
          assigneesRemoved: [],
          reviewersAdded: [],
        },
      })
    ).toBe(true)
  })

  it('pr-review-cycle acts whenever a review is outstanding', () => {
    const route = filled('pr-review-cycle')
    const base = event({
      type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      provider: TICKET_PROVIDER.GITHUB,
      ref: 'acme/www#7',
      prNumber: 7,
      requestedReviewers: ['acme-reviewer'],
    })

    // State, so it does not depend on having witnessed the request appear. This
    // is the case a transition clause could never reach: a review asked for
    // before the route existed, or while the runner was down.
    expect(matchesRule(route, base)).toBe(true)

    // Still true on later cycles -- what stops a second run is the claim the
    // first one took, not the match. A push does not clear the request.
    expect(matchesRule(route, { ...base, revision: 'pushed' })).toBe(true)

    // Answering the review clears the request on GitHub's side, and the trigger
    // stops being raised at all.
    expect(matchesRule(route, { ...base, requestedReviewers: [] })).toBe(false)

    // Somebody else's review request is not this agent's business.
    expect(matchesRule(route, { ...base, requestedReviewers: ['someone-else'] })).toBe(false)
  })

  it('pr-review-cycle holds one claim across pushes, and re-arms when the request lapses', () => {
    const route = filled('pr-review-cycle')
    const asked = event({
      type: TRIGGER_TYPE.PR_REVIEW_REQUESTED,
      provider: TICKET_PROVIDER.GITHUB,
      ref: 'acme/www#7',
      prNumber: 7,
      requestedReviewers: ['acme-reviewer'],
    })

    // The revision moves on every push; the key must not, or each commit would
    // start another review round.
    expect(dedupeKey(route, asked)).toBe(dedupeKey(route, { ...asked, revision: 'pushed' }))
    expect(guardOf(route).refire).toBe('while-matched')
  })

  it('pr-assigned skips drafts', () => {
    const route = filled('pr-assigned')
    const assigned = event({
      type: TRIGGER_TYPE.PR_EVENT,
      provider: TICKET_PROVIDER.GITHUB,
      ref: 'acme/www#7',
      prNumber: 7,
      assignees: ['acme-reviewer'],
      changes: {
        labelsAdded: [],
        labelsRemoved: [],
        assigneesAdded: ['acme-reviewer'],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })

    expect(matchesRule(route, { ...assigned, isDraft: false })).toBe(true)
    expect(matchesRule(route, { ...assigned, isDraft: true })).toBe(false)
  })

  it('pr-unblocked fires when the blocking label comes off', () => {
    const route = filled('pr-unblocked')
    const unblocked = event({
      type: TRIGGER_TYPE.PR_EVENT,
      provider: TICKET_PROVIDER.GITHUB,
      ref: 'acme/www#7',
      prNumber: 7,
      changes: {
        labelsAdded: [],
        labelsRemoved: ['needs-agent'],
        assigneesAdded: [],
        assigneesRemoved: [],
        reviewersAdded: [],
      },
    })
    expect(matchesRule(route, unblocked)).toBe(true)
  })

  it('no template can be started while a run is already in flight', () => {
    for (const template of ROUTE_CATALOG) {
      const route = { ...fillRouteTemplate(template, ANSWERS), id: 'rt_x' } as RoutingRule
      const busy = event({
        type: route.trigger.type,
        provider: TICKET_PROVIDER.GITHUB,
        labels: [SENTINEL0_LABEL.IN_PROGRESS],
      })
      expect(matchesRule(route, busy)).toBe(false)
    }
  })
})

describe('validateRoutingRule', () => {
  it('rejects the one guard combination that can loop', () => {
    const route = { ...filled('ticket-label-analysis') }
    route.guard = { refire: 'per-change', markers: false }
    expect(validateRoutingRule(route)).toMatch(/requires guard.markers/)
  })

  it('rejects a githubLogin target on a ticket trigger, which could never fire', () => {
    const route = { ...filled('ticket-label-analysis') }
    route.target = { agentRef: { githubLogin: 'someone' } }
    expect(validateRoutingRule(route)).toMatch(/only applies to/)
  })

  it('rejects pull-request-only clauses on a ticket trigger', () => {
    const route = { ...filled('ticket-label-analysis') }
    route.match = { ...route.match, isDraft: false }
    expect(validateRoutingRule(route)).toMatch(/only apply to pull request triggers/)
  })

  it('rejects an unknown trigger type', () => {
    const route = { ...filled('ticket-label-analysis') }
    route.trigger = { ...route.trigger, type: 'nonsense' as never }
    expect(validateRoutingRule(route)).toMatch(/trigger.type must be one of/)
  })
})

describe('fillRouteTemplate escaping', () => {
  /**
   * Substitution happens inside a serialized JSON document, so a value carrying
   * a quote or a backslash has to be escaped or the result no longer parses.
   * The dashboard feeds arbitrary typed text through this, which is where such
   * a value realistically comes from.
   */
  it('survives values that need JSON escaping', () => {
    const template = findRouteTemplate('ticket-label-analysis')!
    const filledRoute = fillRouteTemplate(template, {
      ...ANSWERS,
      '<LABEL>': 'needs "review"\\now',
    })
    expect(JSON.stringify(filledRoute)).toContain('needs \\"review\\"')
    expect(validateRoutingRule({ ...filledRoute, id: 'rt_x' })).toBeUndefined()
  })

  it('leaves a token with no answer in place, so the API rejects the route', () => {
    const template = findRouteTemplate('ticket-label-analysis')!
    const filledRoute = fillRouteTemplate(template, {})
    expect(JSON.stringify(filledRoute)).toContain('<PROJECT_ID>')
  })
})
